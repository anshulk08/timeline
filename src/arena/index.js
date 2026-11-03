// PATCH ARENA. After a patch passes the diff gate + existing tests in staging, the Breaker writes up to 3 adversarial tests.
// REFEREE RULE: a Breaker test is ADMITTED only if it PASSES against a hidden reference fix for this bug
// (arena/reference/<signature>.diff; exists only because this demo has planted bugs). Tests that fail on the reference are
// REJECTED as invalid attacks. An admitted test that fails on the candidate patch KILLS it; the failure goes back to the Fixer.
import fs from 'node:fs';
import path from 'node:path';
import { LIVE, STAGING, STAGING_PORT, ARENA_REF, ARENA_REF_PORT, REFERENCE_FIXES } from '../paths.js';
import { sh, startApp } from '../proc.js';
import { readAllowlisted } from '../shipper.js';
import { lintTest, runBreakerTest } from './sandbox.js';

export const MAX_ATTACKS_PER_ROUND = 3;
// A test is admitted only if it passes on the reference EVERY time, so flaky tests (Math.random, timing) are rejected.
export const REFEREE_RUNS = Math.max(1, Number(process.env.REFEREE_RUNS) || 3);

export class Arena {
  constructor({ issue, breaker, emit = () => {}, log = () => {} }) {
    Object.assign(this, { issue, breaker, emit, log });
    this.admitted = []; this.rejected = []; this.rounds = [];
    this.reference = null; // {ok, reason}
  }

  // Lines of admitted test code; the diff gate refuses any patch that pastes them into app source.
  forbidLines() { return this.admitted.flatMap((t) => (t.code || '').split('\n')); }

  prepareReference() {
    if (this.reference) return this.reference;
    const f = path.join(REFERENCE_FIXES, `${this.issue.signature}.diff`);
    if (!fs.existsSync(f)) return (this.reference = { ok: false, reason: `no reference fix for "${this.issue.signature}"` });
    fs.rmSync(ARENA_REF, { recursive: true, force: true });
    fs.cpSync(LIVE, ARENA_REF, { recursive: true, filter: (s) => !s.split(path.sep).includes('.git') });
    const pf = ARENA_REF + '.patch';
    fs.writeFileSync(pf, fs.readFileSync(f));
    return sh('git', ['apply', '--recount', '-p1', pf], { cwd: ARENA_REF, env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(ARENA_REF) } })
      .then((r) => { fs.rmSync(pf, { force: true }); return (this.reference = r.code === 0 ? { ok: true } : { ok: false, reason: `reference fix does not apply to live: ${r.err.trim().slice(0, 200)}` }); });
  }

  async withServer(dir, port, needed, fn) {
    if (!needed) return fn(null);
    const srv = await startApp(dir, port);
    try { return await fn(srv.ok ? `http://127.0.0.1:${port}` : null); } finally { await srv.stop(); }
  }

  // One round against the candidate already applied in STAGING. Returns {killed:[...], survived:[...], round summary}
  async round({ round, diff, source }) {
    const r = { round, patchSource: source, breakerMs: 0, refereeMs: 0, attackMs: 0, attacks: [], results: [] };
    this.rounds.push(r);
    this.emit({ type: 'patch_proposed', round, source, diff, changedLines: diff.split('\n').filter((l) => /^[+-](?![+-])/.test(l)).length });
    const ref = await this.prepareReference();
    let out;
    const t0 = Date.now();
    try { out = await this.breaker.attack({ issue: this.issue, diff, files: readAllowlisted(STAGING), round, prior: this.admitted }); }
    catch (e) {
      r.breakerError = e.message;
      if (/timeout|aborted/i.test(`${e.name} ${e.message}`)) { r.skipped = 'timeout'; this.emit({ type: 'skipped', round, reason: `Breaker timed out (${e.message})` }); }
      this.log('arena', r.skipped ? `round ${round}: SKIPPED (timeout): Breaker gave no attacks in time: ${e.message}` : `Breaker call failed: ${e.message}`);
      out = { tests: [], source: `${this.breaker.mode} Breaker (${r.skipped ? 'timeout' : 'error'})` };
    }
    r.breakerMs = Date.now() - t0; r.breakerSource = out.source;
    const tests = (out.tests || []).slice(0, MAX_ATTACKS_PER_ROUND).map((t, i) => ({ ...t, id: `R${round}.${i + 1}`, round }));
    this.log('arena', `round ${round}: Breaker (${out.source}) proposed ${tests.length} attack(s) in ${(r.breakerMs / 1000).toFixed(2)}s`);

    // Referee: admit only tests that pass against the hidden reference fix.
    const t1 = Date.now();
    const fresh = [];
    await this.withServer(ARENA_REF, ARENA_REF_PORT, ref.ok && tests.some((t) => t.kind === 'browser'), async (url) => {
      for (const t of tests) {
        const lint = lintTest(t);
        let verdict, reason, refRun = null;
        if (lint) { verdict = 'rejected'; reason = `invalid test format: ${lint}`; }
        else if (!ref.ok) { verdict = 'rejected'; reason = `cannot referee: ${ref.reason}`; }
        else {
          let ms = 0, runs = 0;
          for (let i = 0; i < REFEREE_RUNS; i++) { refRun = await runBreakerTest(t, { dir: ARENA_REF, url }); ms += refRun.ms || 0; runs++; if (!refRun.pass) break; }
          refRun = { ...refRun, ms };
          verdict = refRun.pass ? 'admitted' : 'rejected';
          reason = refRun.pass ? `passes on the hidden reference fix (${REFEREE_RUNS}/${REFEREE_RUNS} runs)`
            : runs > 1 ? `flaky: passed ${runs - 1} time(s) then failed on run ${runs} against the hidden reference fix: ${refRun.error || 'failed'}`
            : `fails on the hidden reference fix, so it is an invalid attack: ${refRun.error || 'failed'}`;
        }
        const a = { id: t.id, name: t.name, kind: t.kind, code: t.code, plan: t.plan, verdict, reason, refMs: refRun?.ms ?? 0 };
        r.attacks.push(a);
        (verdict === 'admitted' ? fresh : this.rejected).push(a);
        this.emit({ type: 'attack', round, ...a });
        this.log('arena', `${t.id} "${t.name}" ${verdict.toUpperCase()}: ${reason}`);
      }
    });
    this.admitted.push(...fresh);
    r.refereeMs = Date.now() - t1;

    // Every admitted test so far (this round + earlier rounds) must pass on the candidate.
    const t2 = Date.now();
    await this.withServer(STAGING, STAGING_PORT, this.admitted.some((t) => t.kind === 'browser'), async (url) => {
      for (const t of this.admitted) {
        const run = await runBreakerTest(t, { dir: STAGING, url });
        const res = { id: t.id, name: t.name, result: run.pass ? 'survived' : 'killed', output: run.error, ms: run.ms };
        r.results.push(res);
        this.emit({ type: 'attack_result', round, ...res });
        this.log('arena', `${t.id} vs patch: ${res.result.toUpperCase()}${run.pass ? '' : ` (${run.error})`}`);
      }
    });
    r.attackMs = Date.now() - t2;
    r.killed = r.results.filter((x) => x.result === 'killed').map((x) => ({ ...this.admitted.find((t) => t.id === x.id), output: x.output }));
    return r;
  }

  summary() {
    return { breaker: this.breaker.name, mode: this.breaker.mode, rounds: this.rounds.map(({ attacks, results, ...x }) => ({ ...x, admitted: attacks.filter((a) => a.verdict === 'admitted').length, rejected: attacks.filter((a) => a.verdict === 'rejected').length, killed: x.killed?.length || 0, attacks, results })),
      admitted: this.admitted.length, rejected: this.rejected.length };
  }
}
