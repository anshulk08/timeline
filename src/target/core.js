// Config-target building blocks (TARGET=<name>, targets/<name>/target.json): config, globs, gate, tier rule, git worktrees, tests.
// The tier rule and the gate are CODE, never LLM output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../paths.js';
import { sh } from '../proc.js';
import { parseDiff } from '../gate.js';

export const TARGET = process.env.TARGET || 'jotter';
export const isConfigTarget = (name = TARGET) => name !== 'jotter';

export function loadTarget(nameOrPath = TARGET) {
  const f = nameOrPath.endsWith('.json') ? nameOrPath : path.join(ROOT, 'targets', nameOrPath, 'target.json');
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  cfg.__dir = path.dirname(f);
  cfg.__file = f;
  cfg.tiers ||= {}; cfg.tiers.auto ||= { globs: [], max_changed_lines: 8 }; cfg.tiers.pr ||= { globs: [] };
  cfg.forbid_globs ||= []; cfg.forbid_identifiers ||= []; cfg.tests ||= []; cfg.context_files ||= []; cfg.seeded_bugs ||= [];
  return cfg;
}
// reference_patch paths are relative to the complaint-commit root (per interface); fall back to the target dir.
export function resolveRef(cfg, p) {
  if (!p) return null;
  for (const c of [path.resolve(ROOT, p), path.resolve(cfg.__dir, p), path.resolve(cfg.__dir, path.basename(p))]) if (fs.existsSync(c)) return c;
  return null;
}

export function globToRegExp(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i++; } }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = g.indexOf('}', i); re += `(?:${g.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
export const matchAny = (file, globs = []) => globs.some((g) => globToRegExp(g).test(file));

// Generic, language-neutral dangerous constructs (on top of the target's forbid_identifiers).
const GENERIC_FORBIDDEN = /(\beval\s*\(|new\s+Function\s*\(|child_process|\bsubprocess\b|os\.system|__import__|pickle\.loads|document\.cookie|<script|<iframe|process\.env|os\.environ|https?:\/\/)/i;
export const HARD_MAX_CHANGED_LINES = 60;

function lineReasons(added, removed, cfg, forbidLines = []) {
  const reasons = [];
  const ids = cfg.forbid_identifiers.map((s) => String(s).toLowerCase()).filter(Boolean);
  for (const l of [...added, ...removed]) {
    const m = l.match(GENERIC_FORBIDDEN);
    if (m) reasons.push(`forbidden construct "${m[0]}" in changed line: ${l.trim().slice(0, 80)}`);
    const low = l.toLowerCase();
    const id = ids.find((x) => low.includes(x));
    if (id) reasons.push(`forbidden identifier "${id}" in changed line: ${l.trim().slice(0, 80)}`);
  }
  const banned = new Set(forbidLines.map((l) => l.trim()).filter((l) => l.length >= 16));
  for (const l of added) if (banned.has(l.trim())) reasons.push(`Breaker/repro test code copied into source: ${l.trim().slice(0, 80)}`);
  const n = added.length + removed.length;
  if (n > HARD_MAX_CHANGED_LINES) reasons.push(`too many changed lines: ${n} > ${HARD_MAX_CHANGED_LINES}`);
  return { reasons, changedLines: n };
}

// Pre-apply gate. ok=false => BLOCKED. Returns files + changedLines for the tier rule.
export function checkTargetDiff(diff, cfg, { forbidLines = [], protect = [] } = {}) {
  const reasons = [];
  if (!diff || !/^@@/m.test(diff)) reasons.push('no hunks in diff');
  const { files, added, removed, problems } = parseDiff(diff || '');
  reasons.push(...problems);
  if (!files.length) reasons.push('diff names no files');
  const allowed = [...cfg.tiers.auto.globs, ...cfg.tiers.pr.globs];
  for (const f of files) {
    if (f.includes('..') || f.startsWith('/') || f.includes('\\')) { reasons.push(`path traversal: ${f}`); continue; }
    if (f.split('/').includes('.git')) reasons.push(`protected path: ${f}`);
    if (matchAny(f, cfg.forbid_globs)) reasons.push(`forbidden path: ${f}`);
    if (protect.includes(f)) reasons.push(`patch edits the acceptance test: ${f}`);
    if (!matchAny(f, allowed)) reasons.push(`file outside tier globs: ${f}`);
  }
  const c = lineReasons(added, removed, cfg, forbidLines);
  reasons.push(...c.reasons);
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], files, changedLines: c.changedLines };
}

// Post-apply recheck of what really changed on disk (`git diff` in the worktree), not the proposed text.
export function checkTargetTree(treeDiff, files, cfg, opts = {}) {
  const pre = checkTargetDiff(treeDiff, cfg, opts);
  return { ...pre, files };
}

// TIER RULE (code): AUTO iff every changed file matches tiers.auto.globs AND changedLines <= max AND no forbid hits.
export function decideTier({ files, changedLines, gateOk, reasons = [] }, cfg) {
  if (!gateOk) return { tier: 'blocked', reasons };
  const max = cfg.tiers.auto.max_changed_lines ?? 8;
  const why = [];
  const outside = files.filter((f) => !matchAny(f, cfg.tiers.auto.globs));
  if (outside.length) why.push(`not auto-tier path(s): ${outside.join(', ')}`);
  if (changedLines > max) why.push(`${changedLines} changed lines > auto max ${max}`);
  if (why.length) return { tier: 'pr', reasons: why };
  return { tier: 'auto', reasons: [`all ${files.length} file(s) in auto globs`, `${changedLines} changed lines <= ${max}`, 'no forbid hits'] };
}

// ---- git ----
export const git = (cwd, args, opts = {}) => sh('git', args, { cwd, ...opts });
async function gitOk(cwd, args, opts) { const r = await git(cwd, args, opts); if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${(r.err || r.out).trim().slice(0, 300)}`); return r.out.trim(); }
export { gitOk };
const BOT = ['-c', 'user.name=BDBI AutoMaintainer', '-c', 'user.email=automaintainer@localhost', '-c', 'commit.gpgsign=false'];

export async function addWorktree(repo, ref, tag = 'job') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `am-${tag}-`));
  fs.rmSync(dir, { recursive: true, force: true });
  await gitOk(repo, ['worktree', 'add', '--detach', dir, ref]);
  return dir;
}
export async function removeWorktree(repo, dir) {
  if (!dir) return;
  await git(repo, ['worktree', 'remove', '--force', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  await git(repo, ['worktree', 'prune']);
}
export async function applyPatch(dir, diff) {
  const pf = path.join(os.tmpdir(), `am-${process.pid}-${Math.random().toString(36).slice(2)}.patch`);
  fs.writeFileSync(pf, diff.endsWith('\n') ? diff : diff + '\n');
  const r = await git(dir, ['apply', '--recount', '--whitespace=nowarn', '-p1', pf]);
  fs.rmSync(pf, { force: true });
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.err || r.out).trim().slice(0, 400) };
}
export async function commitAll(dir, message, extraFiles = []) {
  await gitOk(dir, ['add', '-u']);
  if (extraFiles.length) await gitOk(dir, ['add', '--', ...extraFiles]);
  await gitOk(dir, [...BOT, 'commit', '-q', '--no-verify', '-m', message]);
  return gitOk(dir, ['rev-parse', 'HEAD']);
}
// Move cfg.branch to sha (fast-forward only). If the branch is checked out in a worktree, ff-merge there.
export async function advanceBranch(repo, branch, sha, oldSha) {
  const wl = await gitOk(repo, ['worktree', 'list', '--porcelain']);
  let wt = null, cur = null;
  for (const line of wl.split('\n')) {
    if (line.startsWith('worktree ')) cur = line.slice(9);
    if (line === `branch refs/heads/${branch}`) wt = cur;
  }
  if (wt) { await gitOk(wt, ['merge', '--ff-only', '-q', sha]); return { how: `ff-merge in ${wt}` }; }
  await gitOk(repo, ['update-ref', `refs/heads/${branch}`, sha, oldSha]);
  return { how: 'update-ref' };
}

// ---- tests ----
// Single test file runner by extension, cwd = the cfg.tests entry whose cwd owns the file (longest prefix).
export function ownerEntry(cfg, rel) {
  return cfg.tests.filter((t) => !t.cwd || t.cwd === '.' || rel.startsWith(t.cwd.replace(/\/?$/, '/'))).sort((a, b) => (b.cwd || '').length - (a.cwd || '').length)[0] || null;
}
export function fileCmd(rel, cwdRel) {
  const local = cwdRel && cwdRel !== '.' ? path.relative(cwdRel, rel) : rel;
  if (/\.py$/.test(rel)) return `python3 -m pytest -q -p no:cacheprovider ${JSON.stringify(local)}`;
  return `node --test ${JSON.stringify(local)}`;
}
const runCmd = (dir, cwdRel, cmd, timeoutMs = 120000) => new Promise((resolve) => {
  const t0 = Date.now();
  let done = false;
  const p = sh('bash', ['-c', cmd], { cwd: path.join(dir, cwdRel || '.'), env: { ...process.env, NODE_TEST_CONTEXT: undefined, XAI_API_KEY: '', CI: '1' } });
  const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, out: `timeout after ${timeoutMs}ms`, ms: Date.now() - t0 }); } }, timeoutMs);
  p.then((r) => { if (done) return; done = true; clearTimeout(t); resolve({ ok: r.code === 0, out: (r.out + r.err).slice(-1500), ms: Date.now() - t0 }); });
});
export async function runSuite(dir, cfg) {
  const t0 = Date.now();
  const results = await Promise.all(cfg.tests.map(async (t) => ({ name: t.name, ...(await runCmd(dir, t.cwd, t.cmd)) })));
  return { results, ms: Date.now() - t0 };
}
export async function runTestFile(dir, cfg, rel) {
  const e = ownerEntry(cfg, rel);
  return runCmd(dir, e?.cwd || '.', fileCmd(rel, e?.cwd || '.'), 60000);
}
export function writeFileIn(dir, rel, content) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}
export function readContext(dir, cfg, extra = []) {
  const out = {};
  for (const rel of [...new Set([...cfg.context_files, ...extra])]) { try { out[rel] = fs.readFileSync(path.join(dir, rel), 'utf8').slice(0, 12000); } catch {} }
  return out;
}
// Test file path rule for Grok-written tests: inside the repo, a test-named new file, never an existing file.
export function validTestPath(rel, dir) {
  if (!rel || typeof rel !== 'string' || rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) return 'bad path';
  if (!/(\.test\.(ts|js|mjs)|(^|\/)test_[\w-]+\.py)$/.test(rel)) return 'not a test file name (*.test.ts|js|mjs or test_*.py)';
  if (fs.existsSync(path.join(dir, rel))) return 'would overwrite an existing file';
  return null;
}
