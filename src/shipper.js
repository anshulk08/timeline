// Shipper: staging copy -> diff gate -> git apply -> tree check -> tests + re-repro on staging -> deploy -> verify -> rollback on error.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LIVE, STAGING, STAGING_PORT, APP_PORT, ROOT } from './paths.js';
import { sh, startApp, waitHealthy } from './proc.js';
import { checkDiff, checkTreeDiff, ALLOWLIST } from './gate.js';
import { runTestsAgainst } from './tests.js';
import { runPlan } from './reproducer.js';

const GIT_ENV = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(STAGING) };
const gitLive = (...a) => sh('git', ['-c', 'user.name=complaint-commit', '-c', 'user.email=bot@localhost', ...a], { cwd: LIVE });

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p));
  }
  return out;
}
const hash = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
export function changedFiles(a, b) {
  const all = new Set([...walk(a), ...walk(b)]);
  return [...all].filter((f) => hash(path.join(a, f)) !== hash(path.join(b, f)));
}

export function readAllowlisted(dir = LIVE) {
  return Object.fromEntries([...ALLOWLIST].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
}

export function prepareStaging() {
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.cpSync(LIVE, STAGING, { recursive: true, filter: (s) => !s.split(path.sep).includes('.git') });
}

export async function applyDiff(diff) {
  const pf = path.join(STAGING, '..', '.staging.patch');
  fs.writeFileSync(pf, diff);
  const r = await sh('git', ['apply', '--recount', '--whitespace=nowarn', '-p1', pf], { cwd: STAGING, env: GIT_ENV });
  fs.rmSync(pf, { force: true });
  return { ok: r.code === 0, error: (r.err || r.out).trim().slice(0, 400) };
}

// git diff --no-index of live vs staging for each changed file (exit 1 = differences, which is expected).
export async function treeDiff(changed, a = LIVE, b = STAGING) {
  let out = '';
  for (const f of changed) out += (await sh('git', ['diff', '--no-index', '--no-color', '-U0', path.join(a, f), path.join(b, f)], { env: GIT_ENV })).out;
  return out;
}

// Gate + test stage. Returns {ok, gate, apply, treeViolations, tests, stagingRepro, reasons}
export async function gateAndTest(diff, { baseline, plan, log, forbidLines }) {
  const gate = checkDiff(diff, { forbidLines });
  log?.('gate', gate.ok ? `diff gate PASS (${gate.files.join(', ')}, ${gate.changedLines} lines)` : `diff gate BLOCK: ${gate.reasons.join('; ')}`);
  if (!gate.ok) return { ok: false, stage: 'gate', gate, reasons: gate.reasons };
  prepareStaging();
  const apply = await applyDiff(diff);
  if (!apply.ok) { log?.('gate', `git apply failed: ${apply.error}`); return { ok: false, stage: 'apply', gate, apply, reasons: [`apply failed: ${apply.error}`] }; }
  const changed = changedFiles(LIVE, STAGING);
  const treeViolations = changed.filter((f) => !ALLOWLIST.has(f));
  if (treeViolations.length) { log?.('gate', `post-apply tree check BLOCK: ${treeViolations.join(', ')}`); return { ok: false, stage: 'tree', gate, treeViolations, reasons: [`changed non-allowlisted files: ${treeViolations}`] }; }
  // Re-run the content checks on what really changed on disk (live vs staging), not on the diff text.
  const tree = checkTreeDiff(await treeDiff(changed), { forbidLines });
  if (!tree.ok) { log?.('gate', `post-apply content check BLOCK: ${tree.reasons.join('; ')}`); return { ok: false, stage: 'tree', gate, treeCheck: tree, reasons: tree.reasons }; }
  const srv = await startApp(STAGING, STAGING_PORT);
  if (!srv.ok) { await srv.stop(); return { ok: false, stage: 'boot', gate, reasons: ['staging server failed to boot'] }; }
  const url = `http://127.0.0.1:${STAGING_PORT}`;
  const [tests, stagingRepro] = await Promise.all([runTestsAgainst(STAGING, url), plan ? runPlan(plan, url, null) : null]);
  await srv.stop();
  const regressions = baseline.pass.filter((t) => !tests.pass.includes(t));
  const newlyPassing = tests.pass.filter((t) => !baseline.pass.includes(t));
  const reasons = [];
  if (regressions.length) reasons.push(`regressions: ${regressions.join(', ')}`);
  if (!newlyPassing.length) reasons.push('no previously failing test now passes');
  if (stagingRepro?.reproduced) reasons.push(`bug still reproduces on staging: ${stagingRepro.failures.join('; ')}`);
  log?.('test', `tests ${tests.pass.length} pass / ${tests.fail.length} fail; newly passing: [${newlyPassing.join(', ')}]; regressions: [${regressions.join(', ')}]; staging re-repro: ${stagingRepro ? (stagingRepro.reproduced ? 'STILL BROKEN' : 'fixed') : 'n/a'}`);
  return { ok: reasons.length === 0, stage: 'test', gate, changed, tests, newlyPassing, regressions, stagingRepro, reasons };
}

// Live app process management.
let live = null;
export async function startLive() { live = await startApp(LIVE, APP_PORT); return live.ok; }
export async function stopLive() { if (live) await live.stop(); live = null; }
export async function restartLive() { await stopLive(); return startLive(); }

export async function deploy(changed, { plan, message, log }) {
  for (const f of changed) fs.copyFileSync(path.join(STAGING, f), path.join(LIVE, f));
  await gitLive('add', '-A');
  await gitLive('commit', '-qm', message);
  const sha = (await gitLive('rev-parse', '--short', 'HEAD')).out.trim();
  const healthy = await restartLive();
  let verify = null;
  if (healthy && plan) verify = await runPlan(plan, `http://127.0.0.1:${APP_PORT}`, null);
  if (!healthy || verify?.reproduced) {
    log?.('deploy', `post-deploy check FAILED (healthy=${healthy}, reproduced=${verify?.reproduced}); rolling back ${sha}`);
    await gitLive('revert', '--no-edit', 'HEAD');
    await restartLive();
    return { ok: false, sha, rolledBack: true, healthy, verify };
  }
  log?.('deploy', `deployed ${sha}, restarted live app, health ok, live re-repro: fixed`);
  return { ok: true, sha, healthy, verify };
}

export async function liveShow(sha) {
  if (!/^[0-9a-f]{4,40}$/.test(sha)) return null;
  const r = await gitLive('show', '--stat', '-p', sha);
  return r.code === 0 ? r.out : null;
}
export async function liveLog() { return (await gitLive('log', '--oneline', '-n', '20')).out; }
