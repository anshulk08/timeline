// TargetPipeline: complaint -> classify -> Grok repro test (must fail before) -> N parallel Grok Fixer candidates
// (own worktree each: patch -> gate -> tests + repro -> Breaker/referee) -> first passing candidate wins -> code tier rule
// -> AUTO: commit onto cfg.branch locally ("deployed") | PR: local branch automaintainer/fix-<id> + runs/pr/<id>.md. Never pushes.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { MODE, MODE_LABEL, CANDIDATE_MODELS, BREAKER_MODEL } from '../env.js';
import { RUNS } from '../paths.js';
import * as A from './agents.js';
const FIX_ATTEMPTS = Math.max(1, Number(process.env.FIX_ATTEMPTS || 2)); // per candidate; attempt 2 gets attempt 1's diff + failure output (REAL only)
import {
  loadTarget, resolveRef, checkTargetDiff, decideTier, git, gitOk, addWorktree, removeWorktree, applyPatch, commitAll,
  advanceBranch, runSuite, runTestFile, writeFileIn, readContext, validTestPath,
} from './core.js';

let seq = 0;
const lines = (s) => String(s || '').split('\n');

export class TargetPipeline extends EventEmitter {
  // cfg: object or target name; agents: override {classify, reproTest, fix, breaker} (tests); models: candidate models.
  constructor({ cfg, agents = {}, models, runsDir = RUNS } = {}) {
    super();
    this.cfg = typeof cfg === 'object' && cfg ? cfg : loadTarget(cfg);
    this.agents = { ...A, ...agents };
    this.models = models || CANDIDATE_MODELS;
    this.mode = MODE;
    this.fixer = { name: `grok candidates x${this.models.length} (${this.models.join(', ')})` };
    this.breaker = { name: BREAKER_MODEL, mode: MODE === 'REAL' ? MODE_LABEL : 'MOCK' };
    this.grokbot = null;
    this.records = []; this.issues = new Map(); this.queue = Promise.resolve();
    this.runs = runsDir;
    fs.mkdirSync(path.join(this.runs, 'pr'), { recursive: true });
  }
  log(rec, stage, msg) {
    const e = { t: Date.now(), postId: rec?.id, stage, msg };
    try { fs.appendFileSync(path.join(this.runs, 'actions.jsonl'), JSON.stringify(e) + '\n'); } catch {}
    this.emit('log', e);
  }
  update(rec) { this.emit('update', rec); }
  ev(type, data) { this.emit(type, { t: Date.now(), ...data }); this.emit('target_event', { type, t: Date.now(), ...data }); }

  async init({ reset = false } = {}) {
    const { cfg } = this;
    if (reset && cfg.reset) {
      const f = resolveRef(cfg, cfg.reset);
      if (f) { const { sh } = await import('../proc.js'); const o = await sh('bash', [f], { cwd: path.dirname(f) }); this.log(null, 'boot', `reset ${path.basename(f)} -> exit ${o.code}`); }
      this.issues.clear(); this.records = [];
    }
    await gitOk(cfg.repo, ['rev-parse', '--verify', `refs/heads/${cfg.branch}`]);
    const dir = await addWorktree(cfg.repo, cfg.branch, 'base');
    try { this.baseline = await runSuite(dir, cfg); } finally { await removeWorktree(cfg.repo, dir); }
    this.log(null, 'boot', `${MODE_LABEL} target=${cfg.name} repo=${cfg.repo}@${cfg.branch}; candidates=${this.models.join(', ')}; breaker=${BREAKER_MODEL}. baseline: ${this.baseline.results.map((r) => `${r.name}:${r.ok ? 'pass' : 'FAIL'}`).join(', ')} (${this.baseline.ms}ms)`);
    this.emit('reset');
  }
  reset() {
    if (this.resetting) return this.resetting;
    const r = this.queue.then(() => this.init({ reset: true }));
    this.resetting = r.finally(() => { this.resetting = null; });
    this.queue = this.resetting.catch(() => {});
    return this.resetting;
  }
  async timed(rec, name, fn) {
    const t0 = Date.now();
    rec.stages[name] = { status: 'running', start: t0 }; this.update(rec);
    try { const out = await fn(); rec.stages[name] = { ...rec.stages[name], status: out?.__status || 'ok', ms: Date.now() - t0 }; return out; }
    catch (e) { rec.stages[name] = { ...rec.stages[name], status: 'error', ms: Date.now() - t0, error: e.message }; this.log(rec, name, `error: ${e.message}`); throw e; }
    finally { this.update(rec); }
  }

  async handlePost(post) {
    if (this.resetting) await this.resetting.catch(() => {});
    const receivedAt = Date.now();
    const rec = { id: `p${++seq}`, post, mode: this.mode, target: this.cfg.name, receivedAt, stages: {}, status: 'received' };
    rec.stages.detect = { status: 'ok', ms: Math.max(0, receivedAt - (post.createdAt || receivedAt)) };
    this.records.push(rec);
    this.log(rec, 'detect', `[${post.source}] @${post.author}: ${post.text}`);
    try {
      const v = await this.timed(rec, 'classify', () => this.agents.classify(post, this.cfg));
      rec.verdict = v;
      this.log(rec, 'classify', `${v.category.toUpperCase()} (${v.mode})${v.signature ? ` sig=${v.signature}` : ''}: ${v.reason || v.summary || ''}`);
      if (v.category === 'attack') { rec.status = 'refused'; rec.reply = `@${post.author} Not doing that: requests touching accounts, permissions, secrets or safety checks are refused automatically.`; return this.finish(rec); }
      if (v.category !== 'bug') { rec.status = v.category === 'feature' ? 'logged-feature' : 'ignored'; return this.finish(rec); }
      const ex = this.issues.get(v.signature);
      if (ex && !['failed', 'not-reproduced', 'blocked'].includes(ex.status)) { rec.status = 'duplicate'; rec.duplicateOf = ex.firstPostId; return this.finish(rec); }
      const issue = { signature: v.signature, summary: v.summary || post.text.slice(0, 80), text: post.text, firstPostId: rec.id, status: 'queued', seeded: v.seeded || null };
      this.issues.set(v.signature, issue);
      rec.status = 'queued'; this.update(rec);
      const job = this.queue.then(() => this.fixJob(rec, issue));
      this.queue = job.catch(() => {});
      return job;
    } catch (e) { rec.status = 'error'; rec.error = e.message; return this.finish(rec); }
  }

  // ---- reproduction: one failing test, must FAIL on unfixed code; one retry ----
  async reproduce(rec, issue, base) {
    const { cfg } = this;
    const dir = await addWorktree(cfg.repo, base, 'repro');
    try {
      const context = readContext(dir, cfg);
      let previous = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const t0 = Date.now();
        let t;
        // MOCK: a seeded bug may name an existing cfg.tests entry that already fails on the seeded branch (its repro).
        const seededRt = MODE !== 'REAL' && cfg.seeded_bugs.find((x) => x.id === issue.signature)?.repro_test;
        const suite = seededRt && !seededRt.path && cfg.tests.find((x) => x.name === seededRt.name);
        if (suite) {
          const b = this.baseline.results.find((r) => r.name === suite.name);
          const status = b && !b.ok ? 'fails-before' : 'invalid';
          this.ev('repro_test', { id: issue.signature, postId: rec.id, test_name: seededRt.match || suite.name, file: `${suite.cwd}: ${suite.cmd}`, status, ms: b?.ms ?? 0, source: 'MOCK (seeded failing test)' });
          this.log(rec, 'reproduce', `seeded repro test "${seededRt.match}" in suite ${suite.name}: ${status}`);
          if (status === 'fails-before') return { suite: suite.name, path: null, name: seededRt.match || suite.name, content: '', source: 'MOCK (seeded failing test)', output: b.out };
          break;
        }
        try { t = await this.agents.reproTest({ issue, cfg, context, previous }); } catch (e) { t = null; previous = `generation error: ${e.message}`; }
        if (!t) { this.ev('repro_test', { id: issue.signature, postId: rec.id, test_name: null, file: null, status: 'invalid', ms: Date.now() - t0, reason: previous || 'no reproduction test available' }); if (MODE !== 'REAL') break; continue; }
        const bad = validTestPath(t.path, dir);
        let status = 'invalid', out = '';
        if (bad) previous = `path ${t.path}: ${bad}`;
        else {
          writeFileIn(dir, t.path, t.content);
          const r = await runTestFile(dir, cfg, t.path);
          out = r.out;
          if (!r.ok) status = 'fails-before'; else previous = 'the test PASSED on the buggy code, so it does not reproduce the bug';
          fs.rmSync(path.join(dir, t.path), { force: true });
        }
        const ms = Date.now() - t0;
        this.ev('repro_test', { id: issue.signature, postId: rec.id, test_name: t.name, file: t.path, status, ms, source: t.source, attempt, reason: status === 'invalid' ? previous : undefined });
        this.log(rec, 'reproduce', `repro test ${t.path} (${t.source}) attempt ${attempt}: ${status === 'fails-before' ? 'FAILS on unfixed code (good)' : `INVALID: ${previous}`} in ${ms}ms`);
        if (status === 'fails-before') return { ...t, output: out };
      }
      this.log(rec, 'reproduce', 'no valid reproduction test; acceptance = existing tests + Breaker only');
      return null;
    } finally { await removeWorktree(cfg.repo, dir); }
  }

  // Reference worktree for the Breaker referee (seeded bugs only). Shared by candidates; serialized via this.refLock.
  async refDir(issue, base) {
    if (this.ref !== undefined) return this.ref;
    const b = this.cfg.seeded_bugs.find((x) => x.id === issue.signature);
    const f = resolveRef(this.cfg, b?.reference_patch);
    if (!f) return (this.ref = null);
    const dir = await addWorktree(this.cfg.repo, base, 'ref');
    const a = await applyPatch(dir, fs.readFileSync(f, 'utf8'));
    if (!a.ok) { await removeWorktree(this.cfg.repo, dir); return (this.ref = null); }
    return (this.ref = dir);
  }

  async candidate(k, model, ctx) {
    const { cfg } = this, { rec, issue, base, repro, race } = ctx;
    const t0 = Date.now();
    const c = { k, model, status: 'running' };
    const emit = (status, extra = {}) => { c.status = status; Object.assign(c, extra); this.ev('candidate', { id: issue.signature, postId: rec.id, k, model, status, ms: Date.now() - t0, lines: c.lines ?? 0, ...extra }); this.log(rec, 'candidate', `#${k} ${model}: ${status.toUpperCase()}${extra.reason ? ` (${extra.reason})` : ''} @${((Date.now() - t0) / 1000).toFixed(1)}s`); };
    const lost = () => race.winner && race.winner !== c;
    emit('running');
    let dir;
    try {
      dir = c.dir = await addWorktree(cfg.repo, base, `c${k}`);
      const context = readContext(dir, cfg);
      let previous = null;
      for (let attempt = 1; attempt <= FIX_ATTEMPTS; attempt++) {
      if (attempt > 1) { await git(dir, ['checkout', '--', '.']); await git(dir, ['clean', '-fdq']); emit('running', { attempt }); }
      const fail = (status, reason, out = '') => { if (attempt < FIX_ATTEMPTS && MODE === 'REAL' && !lost()) { previous = { diff: c.fix?.diff || '', why: `${reason}\n${out}` }; this.log(rec, 'candidate', `#${k} ${model} attempt ${attempt} ${status}: ${reason.slice(0, 160)}; retrying with feedback`); return null; } return emit(status, { reason, attempt }), c; };
      const fx = await this.agents.fix({ model, issue, cfg, context, repro, signal: race.abort.signal, previous });
      if (lost()) return emit('lost'), c;
      c.fix = fx;
      const forbidLines = repro?.content ? lines(repro.content) : [];
      const g = checkTargetDiff(fx.diff, cfg, { forbidLines, protect: repro?.path ? [repro.path] : [] });
      c.lines = g.changedLines; c.files = g.files; c.gate = g;
      if (!g.ok) { if (fail('gate-fail', g.reasons.join('; ').slice(0, 300))) return c; continue; }
      const ap = await applyPatch(dir, fx.diff);
      if (!ap.ok) { c.gate = { ...g, ok: false, applyError: true, reasons: [`does not apply: ${ap.error}`] }; if (fail('gate-fail', `does not apply: ${ap.error.slice(0, 200)}`)) return c; continue; }
      // after-apply on-disk recheck: what really changed, not the proposed text
      const tree = (await git(dir, ['diff'])).out;
      const names = (await git(dir, ['diff', '--name-only'])).out.trim().split('\n').filter(Boolean);
      const untracked = (await git(dir, ['ls-files', '--others', '--exclude-standard'])).out.trim();
      const tg = checkTargetDiff(tree, cfg, { forbidLines, protect: repro?.path ? [repro.path] : [] });
      if (untracked) tg.reasons.push(`patch created untracked files: ${untracked.slice(0, 120)}`);
      if (!tg.ok || untracked) { c.gate = { ...tg, ok: false }; if (fail('gate-fail', `on-disk recheck: ${tg.reasons.join('; ').slice(0, 300)}`)) return c; continue; }
      c.files = names; c.lines = tg.changedLines; c.gate = tg; c.treeDiff = tree;
      if (lost()) return emit('lost'), c;
      // tests: every suite that passed at baseline + the repro test
      if (repro?.path) writeFileIn(dir, repro.path, repro.content);
      const [suite, rt0] = await Promise.all([runSuite(dir, cfg), repro?.path ? runTestFile(dir, cfg, repro.path) : null]);
      const rt = rt0 || (repro?.suite ? suite.results.find((r) => r.name === repro.suite) : null);
      const basePass = new Set(this.baseline.results.filter((r) => r.ok).map((r) => r.name));
      const broke = suite.results.filter((r) => basePass.has(r.name) && !r.ok).map((r) => r.name);
      c.tests = { suite: suite.results.map(({ name, ok, ms }) => ({ name, ok, ms })), repro: rt ? { ok: rt.ok, ms: rt.ms, out: rt.ok ? '' : rt.out.slice(-600) } : null };
      if (broke.length || (rt && !rt.ok)) { const why = [broke.length ? `broke: ${broke.join(', ')}` : '', rt && !rt.ok ? 'repro test still fails' : ''].filter(Boolean).join('; '); const outs = [rt && !rt.ok ? rt.out.slice(-900) : '', ...suite.results.filter((r) => broke.includes(r.name)).map((r) => r.out.slice(-500))].join('\n'); if (fail('tests-fail', why, outs)) return c; continue; }
      if (lost()) return emit('lost'), c;
      // Patch Arena (Breaker + referee against hidden reference fix)
      const ar = await this.arena(c, ctx, dir, tree);
      c.arena = ar;
      if (ar.killed.length) return emit('arena-killed', { reason: ar.killed.map((x) => x.name).join(', ') }), c;
      if (lost()) return emit('lost'), c;
      emit('pass');
      race.winner = c; race.abort.abort(); race.resolve(c);
      emit('winner');
      return c;
      }
      return c;
    } catch (e) {
      if (lost() || race.abort.signal.aborted) return emit('lost'), c;
      emit('tests-fail', { reason: `error: ${e.message.slice(0, 200)}` });
      return c;
    }
  }

  async arena(c, { rec, issue, base, repro }, dir, diff) {
    const out = { breaker: null, attacks: [], killed: [], verdict: 'ship' };
    const em = (e) => this.emit('arena', { t: Date.now(), postId: rec.id, mode: this.breaker.mode, candidate: c.k, ...e });
    em({ type: 'patch_proposed', round: c.k, source: c.fix.source, diff, changedLines: c.lines });
    let b;
    const t0 = Date.now();
    try { b = await this.agents.breaker({ issue, diff, context: readContext(dir, this.cfg, c.files), repro }); }
    catch (e) {
      const to = /timeout|aborted/i.test(`${e.name} ${e.message}`);
      out.verdict = to ? 'skipped (timeout)' : `skipped (error: ${e.message.slice(0, 80)})`;
      em({ type: 'skipped', round: c.k, reason: out.verdict });
      em({ type: 'verdict', result: out.verdict, rounds: 1, attempts: 1, admitted: 0, rejected: 0, killedBy: [], reason: `Breaker gave no attacks after ${((Date.now() - t0) / 1000).toFixed(1)}s` });
      this.log(rec, 'arena', `candidate #${c.k}: arena ${out.verdict.toUpperCase()}`);
      return out;
    }
    out.breaker = { source: b.source, ms: Date.now() - t0 };
    const ref = b.tests.length ? await this.refDir(issue, base) : null;
    for (const [i, t] of b.tests.entries()) {
      const id = `C${c.k}.${i + 1}`;
      let verdict = 'rejected', reason;
      const bad = validTestPath(t.path, dir) || (repro && t.path === repro.path ? 'same path as repro test' : null);
      if (bad) reason = `invalid test path: ${bad}`;
      else if (!ref) reason = 'cannot referee: no hidden reference fix for this bug';
      else {
        const prev = this.refLock || Promise.resolve();
        let release; this.refLock = new Promise((r) => (release = r));
        await prev;
        try { writeFileIn(ref, t.path, t.content); const r = await runTestFile(ref, this.cfg, t.path); verdict = r.ok ? 'admitted' : 'rejected'; reason = r.ok ? 'passes on the hidden reference fix' : `fails on the hidden reference fix: ${r.out.slice(-160)}`; }
        finally { fs.rmSync(path.join(ref, t.path), { force: true }); release(); }
      }
      const a = { id, name: t.name, kind: 'file', path: t.path, code: t.content, verdict, reason };
      out.attacks.push(a);
      em({ type: 'attack', round: c.k, ...a });
      if (verdict === 'admitted') {
        writeFileIn(dir, t.path, t.content);
        const r = await runTestFile(dir, this.cfg, t.path);
        fs.rmSync(path.join(dir, t.path), { force: true });
        a.result = r.ok ? 'survived' : 'killed';
        em({ type: 'attack_result', round: c.k, id, name: t.name, result: a.result, output: r.ok ? '' : r.out.slice(-300), ms: r.ms });
        if (!r.ok) out.killed.push(a);
      }
    }
    out.verdict = out.killed.length ? 'killed' : 'ship';
    em({ type: 'verdict', result: out.verdict, rounds: 1, attempts: 1, admitted: out.attacks.filter((a) => a.verdict === 'admitted').length, rejected: out.attacks.filter((a) => a.verdict === 'rejected').length, killedBy: out.killed.map((a) => a.id), reason: `${b.source}: ${b.tests.length} attack(s) in ${(out.breaker.ms / 1000).toFixed(1)}s` });
    return out;
  }

  async fixJob(rec, issue) {
    const { cfg } = this;
    const cands = [];
    let settled = null;
    await this.lastCleanup;
    this.ref = undefined;
    try {
      issue.status = 'in-progress'; rec.status = 'reproducing';
      const base = await gitOk(cfg.repo, ['rev-parse', `refs/heads/${cfg.branch}`]);
      const repro = await this.timed(rec, 'reproduce', () => this.reproduce(rec, issue, base));
      rec.repro = repro ? { path: repro.path, name: repro.name, source: repro.source } : null;
      if (!repro && MODE === 'REAL') { issue.status = rec.status = 'not-reproduced'; rec.reply = `@${rec.post.author} Thanks! We could not turn that into a failing test yet. Mind sharing steps?`; return this.finish(rec); }

      rec.status = 'fixing';
      this.ev('candidates', { id: issue.signature, postId: rec.id, n: this.models.length, models: this.models });
      const race = { winner: null, abort: new AbortController() };
      const won = new Promise((r) => (race.resolve = r));
      const ctx = { rec, issue, base, repro, race };
      const all = this.models.map((m, i) => this.candidate(i + 1, m, ctx).then((c) => (cands[i] = c)));
      settled = Promise.allSettled(all);
      const winner = await this.timed(rec, 'candidates', () => Promise.race([won, settled.then(() => race.winner)]));
      rec.candidates = cands.filter(Boolean).map(({ k, model, status, lines: l, files }) => ({ k, model, status, lines: l, files }));

      if (!winner) {
        await settled;
        rec.candidates = cands.map(({ k, model, status, lines: l, files, gate }) => ({ k, model, status, lines: l, files, reasons: gate?.reasons }));
        const blocked = cands.filter((c) => c.status === 'gate-fail' && !c.gate?.applyError);
        const allBlocked = blocked.length && blocked.length === cands.length;
        if (allBlocked) this.ev('tier', { id: issue.signature, postId: rec.id, tier: 'blocked', reasons: [...new Set(blocked.flatMap((c) => c.gate.reasons))] });
        issue.status = rec.status = allBlocked ? 'blocked' : 'failed';
        this.log(rec, 'ship', `NOT shipped: ${cands.map((c) => `#${c.k} ${c.status}`).join(', ')}`);
        return this.finish(rec);
      }
      const t = decideTier({ files: winner.files, changedLines: winner.lines, gateOk: winner.gate.ok, reasons: winner.gate.reasons }, cfg);
      rec.tier = t.tier;
      this.ev('tier', { id: issue.signature, postId: rec.id, tier: t.tier, reasons: t.reasons });
      this.log(rec, 'tier', `${t.tier.toUpperCase()}: ${t.reasons.join('; ')}`);
      const seededNote = issue.seeded ? `\n\nSEEDED DEMO BUG (${issue.seeded}): this bug was planted on the local demo branch for the BDBI AutoMaintainer demo.` : '';
      const msg = `fix(${issue.signature}): ${issue.summary}\n\nRoot cause: ${winner.fix.root_cause || 'n/a'}\nFixer: ${winner.fix.source} (candidate ${winner.k}/${this.models.length})\nReported on X by @${rec.post.author}: ${rec.post.text}` + (repro ? `\nRegression test: ${repro.path || `${repro.suite}: ${repro.name}`}` : '') + `\nArena: ${winner.arena.verdict}${seededNote}\n\nCommitted locally by BDBI AutoMaintainer; never pushed.`;
      const sha = await this.timed(rec, 'commit', () => commitAll(winner.dir, msg, repro?.path ? [repro.path] : []));
      const t0 = Date.now();
      if (t.tier === 'auto') {
        const how = await this.timed(rec, 'deploy', () => advanceBranch(cfg.repo, cfg.branch, sha, base));
        this.ev('auto_applied', { id: issue.signature, postId: rec.id, branch: cfg.branch, sha, ms: Date.now() - t0, how: how.how });
        issue.status = 'fixed'; rec.status = 'shipped'; rec.sha = sha;
        rec.reply = `@${rec.post.author} Reproduced with a failing test and fixed in ${((Date.now() - rec.receivedAt) / 1000).toFixed(1)}s (commit ${sha.slice(0, 8)} on ${cfg.branch}).`;
      } else {
        const branch = `automaintainer/fix-${issue.signature}`;
        await gitOk(cfg.repo, ['branch', '-f', branch, sha]);
        const body = this.prBody({ rec, issue, winner, repro, tier: t, branch, sha });
        const bodyPath = path.join(this.runs, 'pr', `${issue.signature}.md`);
        fs.writeFileSync(bodyPath, body);
        this.ev('pr_ready', { id: issue.signature, postId: rec.id, branch, base: cfg.branch, title: `fix(${issue.signature}): ${issue.summary}`, body_path: bodyPath, files: winner.files, ms: Date.now() - t0, sha });
        issue.status = 'pr-ready'; rec.status = 'pr-ready'; rec.sha = sha; rec.prBranch = branch;
        rec.reply = `@${rec.post.author} Reproduced with a failing test; a fix is ready for maintainer review on ${branch}.`;
      }
      return this.finish(rec);
    } catch (e) {
      issue.status = 'failed'; rec.status = 'error'; rec.error = e.message;
      return this.finish(rec);
    } finally {
      // losers may still be finishing (their Grok calls were aborted); remove every worktree once all candidates settle
      const ref = this.ref; this.ref = undefined;
      this.lastCleanup = (settled || Promise.resolve()).then(async () => {
        for (const c of cands.filter(Boolean)) await removeWorktree(cfg.repo, c.dir);
        if (ref) await removeWorktree(cfg.repo, ref);
      }).catch(() => {});
    }
  }

  prBody({ rec, issue, winner, repro, tier, branch, sha }) {
    const q = (s) => String(s).split('\n').map((l) => `> ${l}`).join('\n');
    const tests = (winner.tests?.suite || []).map((t) => `- ${t.ok ? 'PASS' : 'FAIL'} ${t.name} (${t.ms} ms)`).join('\n');
    const atk = (winner.arena?.attacks || []).map((a) => `- ${a.id} "${a.name}": ${a.verdict}${a.result ? `, ${a.result}` : ''}`).join('\n') || '- (no attacks)';
    return `# fix(${issue.signature}): ${issue.summary}

Local branch \`${branch}\` (commit \`${sha.slice(0, 10)}\`) against \`${this.cfg.branch}\` in ${this.cfg.display_name || this.cfg.name}. **Not pushed.** Tier: **PR** (${tier.reasons.join('; ')}).
${issue.seeded ? `\n> **Seeded demo bug** (\`${issue.seeded}\`): planted on the local \`${this.cfg.branch}\` branch to demo BDBI AutoMaintainer. Not a bug report from real users.\n` : ''}
## Complaint (from X, @${rec.post.author})
${q(rec.post.text)}

## Root cause (Fixer: ${winner.fix.source}, candidate ${winner.k}/${this.models.length})
${winner.fix.root_cause || 'n/a'}

## Reproduction test
${repro ? `\`${repro.path || `${repro.suite}: ${repro.name}`}\` (${repro.source}); failed on the unfixed code, passes with this patch.${repro.content ? `\n\n\`\`\`\n${repro.content}\n\`\`\`` : ''}` : 'none'}

## Diff
\`\`\`diff
${winner.treeDiff || winner.fix.diff}
\`\`\`

## Tests
${tests}
- ${winner.tests?.repro ? (winner.tests.repro.ok ? 'PASS' : 'FAIL') : 'n/a'} reproduction test

## Patch Arena (Breaker ${winner.arena?.breaker?.source || this.breaker.name})
Verdict: **${winner.arena?.verdict}**
${atk}
`;
  }

  finish(rec) {
    rec.doneAt = Date.now(); rec.totalMs = rec.doneAt - (rec.post.createdAt || rec.receivedAt);
    if (rec.reply) this.log(rec, 'reply', `DRAFT (not posted): ${rec.reply}`);
    this.log(rec, 'done', `${rec.status} in ${(rec.totalMs / 1000).toFixed(2)}s`);
    this.update(rec);
    try { fs.appendFileSync(path.join(this.runs, 'records.jsonl'), JSON.stringify(rec) + '\n'); } catch {}
    return rec;
  }
}
