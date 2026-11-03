// Config-target pipeline: tier rule (code), forbidden paths blocked, parallel candidate race (MOCK agents, throwaway fixture repo).
process.env.FORCE_MOCK = '1';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { execFileSync } = await import('node:child_process');
const { decideTier, checkTargetDiff, globToRegExp } = await import('../src/target/core.js');
const { TargetPipeline } = await import('../src/target/pipeline.js');

const FIX = path.join(import.meta.dirname, 'fixtures', 'mini');
const REF = fs.readFileSync(path.join(FIX, 'reference', 'add.diff'), 'utf8');
const REPRO = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.js';\ntest('add sums', () => assert.equal(add(2, 3), 5));\n`;

function makeTarget() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-fixture-'));
  const repo = path.join(tmp, 'repo');
  fs.cpSync(path.join(FIX, 'repo'), repo, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim();
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  g('branch', 'demo');
  const cfg = {
    name: 'mini', display_name: 'Mini', repo, branch: 'demo', __dir: FIX,
    tiers: { auto: { globs: ['src/calc.js'], max_changed_lines: 8 }, pr: { globs: ['src/**'] } },
    forbid_globs: ['src/auth.js', '**/.env*'], forbid_identifiers: ['isAdmin', 'SUPABASE_SERVICE'],
    tests: [{ name: 'unit', cwd: '.', cmd: 'node --test "src/**/*.test.js"' }],
    context_files: ['src/calc.js'],
    seeded_bugs: [{ id: 'add', complaint: 'the calculator add button subtracts numbers instead of adding them', expected_tier: 'auto', files: ['src/calc.js'], reference_patch: path.join(FIX, 'reference', 'add.diff'), repro_test: { path: 'src/automaintainer-repro.test.js', content: REPRO } }],
  };
  return { cfg, g, runs: path.join(tmp, 'runs') };
}
const post = (text) => ({ text, author: 'tester', createdAt: Date.now(), source: 'inject' });
const collect = (p) => { const ev = []; p.on('target_event', (e) => ev.push(e)); return ev; };

test('glob matching', () => {
  assert.ok(globToRegExp('frontend/lib/**/*.ts').test('frontend/lib/a/b.ts'));
  assert.ok(globToRegExp('frontend/lib/**/*.ts').test('frontend/lib/b.ts'));
  assert.ok(!globToRegExp('frontend/lib/*.ts').test('frontend/lib/a/b.ts'));
});

test('tier rule: auto only when all files in auto globs, lines <= max, gate ok', () => {
  const { cfg } = makeTarget();
  assert.equal(decideTier({ files: ['src/calc.js'], changedLines: 2, gateOk: true }, cfg).tier, 'auto');
  assert.equal(decideTier({ files: ['src/calc.js'], changedLines: 9, gateOk: true }, cfg).tier, 'pr');
  assert.equal(decideTier({ files: ['src/calc.js', 'src/other.js'], changedLines: 2, gateOk: true }, cfg).tier, 'pr');
  assert.equal(decideTier({ files: ['src/calc.js'], changedLines: 2, gateOk: false, reasons: ['x'] }, cfg).tier, 'blocked');
});

test('gate: forbidden path / identifier / out-of-glob / header bypass are blocked', () => {
  const { cfg } = makeTarget();
  assert.equal(checkTargetDiff(REF, cfg).ok, true);
  const auth = `--- a/src/auth.js\n+++ b/src/auth.js\n@@ -1,1 +1,1 @@\n-export const isAdmin = (u) => u === 'root';\n+export const isAdmin = (u) => true;\n`;
  const r = checkTargetDiff(auth, cfg); assert.equal(r.ok, false); assert.match(r.reasons.join(), /forbidden path: src\/auth\.js/);
  const smug = REF.replace('+  return a + b;', '+  return a + b; // isAdmin');
  assert.match(checkTargetDiff(smug, cfg).reasons.join(), /forbidden identifier "isadmin"/);
  assert.match(checkTargetDiff(REF.replaceAll('src/calc.js', 'README.md'), cfg).reasons.join(), /outside tier globs/);
  const hdr = REF.replace('+  return a + b;', '+  return a + b;\n+++ b/src/x.js <script>');
  assert.equal(checkTargetDiff(hdr, cfg).ok, false);
  assert.match(checkTargetDiff(REF.replace('return a + b', 'return eval("a+b")'), cfg).reasons.join(), /forbidden construct/);
});

test('race: forbidden candidate blocked, passing candidate wins, AUTO commits onto branch', async () => {
  const { cfg, g, runs } = makeTarget();
  const before = g('rev-parse', 'demo');
  const bad = `--- a/src/auth.js\n+++ b/src/auth.js\n@@ -1,1 +1,1 @@\n-export const isAdmin = (u) => u === 'root';\n+export const isAdmin = (u) => true;\n`;
  const p = new TargetPipeline({ cfg, runsDir: runs, models: ['fast', 'slow'], agents: {
    fix: async ({ model }) => (model === 'fast' ? { diff: bad, root_cause: 'x', source: 'bad' } : (await new Promise((r) => setTimeout(r, 50)), { diff: REF, root_cause: 'add used minus', source: 'good' })),
  } });
  const ev = collect(p);
  await p.init();
  const rec = await p.handlePost(post('the calculator add button subtracts numbers instead of adding them'));
  await p.lastCleanup;
  assert.equal(rec.status, 'shipped', JSON.stringify(rec.candidates));
  assert.equal(ev.find((e) => e.type === 'repro_test').status, 'fails-before');
  assert.ok(ev.some((e) => e.type === 'candidate' && e.model === 'fast' && e.status === 'gate-fail'));
  assert.ok(ev.some((e) => e.type === 'candidate' && e.model === 'slow' && e.status === 'winner'));
  assert.equal(ev.find((e) => e.type === 'tier').tier, 'auto');
  const aa = ev.find((e) => e.type === 'auto_applied');
  assert.equal(g('rev-parse', 'demo'), aa.sha); assert.notEqual(aa.sha, before);
  assert.match(g('show', 'demo:src/calc.js'), /a \+ b/);
  assert.match(g('log', '-1', '--format=%B', 'demo'), /SEEDED DEMO BUG/);
  assert.equal(g('rev-parse', 'main'), before, 'main untouched');
  assert.equal(g('worktree', 'list').split('\n').length, 1, 'worktrees cleaned');
});

test('race: two passing candidates, first wins, other lost; PR tier writes branch + body', async () => {
  const { cfg, g, runs } = makeTarget();
  cfg.tiers.auto.max_changed_lines = 1; // force PR tier
  const p = new TargetPipeline({ cfg, runsDir: runs, models: ['a', 'b'], agents: {
    fix: async ({ model, signal }) => {
      if (model === 'b') await new Promise((r, j) => { const t = setTimeout(r, 3000); signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
      return { diff: REF, root_cause: 'add used minus', source: model };
    },
  } });
  const ev = collect(p);
  await p.init();
  const t0 = Date.now();
  const rec = await p.handlePost(post('the calculator add button subtracts numbers instead of adding them'));
  await p.lastCleanup;
  assert.ok(Date.now() - t0 < 2500, 'did not wait for the slow candidate');
  assert.equal(rec.status, 'pr-ready');
  assert.ok(ev.some((e) => e.type === 'candidate' && e.model === 'a' && e.status === 'winner'));
  assert.ok(ev.some((e) => e.type === 'candidate' && e.model === 'b' && e.status === 'lost'));
  const pr = ev.find((e) => e.type === 'pr_ready');
  assert.equal(pr.branch, 'automaintainer/fix-add');
  assert.match(fs.readFileSync(pr.body_path, 'utf8'), /Seeded demo bug/);
  assert.match(g('show', 'automaintainer/fix-add:src/calc.js'), /a \+ b/);
  assert.ok(g('show', 'automaintainer/fix-add:src/automaintainer-repro.test.js').includes('add sums'));
  assert.doesNotMatch(g('show', 'demo:src/calc.js'), /a \+ b/, 'PR tier does not touch the target branch');
});

test('all candidates forbidden -> tier blocked', async () => {
  const { cfg, runs } = makeTarget();
  const bad = `--- a/src/auth.js\n+++ b/src/auth.js\n@@ -1,1 +1,1 @@\n-export const isAdmin = (u) => u === 'root';\n+export const isAdmin = (u) => true;\n`;
  const p = new TargetPipeline({ cfg, runsDir: runs, models: ['a', 'b'], agents: { fix: async () => ({ diff: bad, source: 'x' }) } });
  const ev = collect(p);
  await p.init();
  const rec = await p.handlePost(post('the calculator add button subtracts numbers instead of adding them'));
  await p.lastCleanup;
  assert.equal(rec.status, 'blocked');
  assert.equal(ev.find((e) => e.type === 'tier').tier, 'blocked');
});
