// Patch Arena: referee, retry loop, sandbox, gate, and the full MOCK export story.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Arena } from '../src/arena/index.js';
import { runUnitInSandbox, lintTest } from '../src/arena/sandbox.js';
import { checkDiff } from '../src/gate.js';
import { Pipeline } from '../src/pipeline.js';
import { prepareStaging, applyDiff, stopLive } from '../src/shipper.js';
import { closeBrowser } from '../src/reproducer.js';
import { reset } from '../scripts/reset.js';
import { LIVE } from '../src/paths.js';

const canned = (f) => fs.readFileSync(`src/fixers/canned/${f}`, 'utf8');
const ISSUE = { signature: 'export', summary: 'Export button does not download notes', text: '@jotterapp the export button is broken, nothing happens' };
const COMMA = { name: 'comma stays one field', kind: 'unit', code: "assert.equal(lib.toCSV([{ id: '1', text: 'eggs, milk' }]), 'text\\n\"eggs, milk\"\\n');" };
const ALWAYS_QUOTE = { name: 'every field quoted', kind: 'unit', code: "assert.equal(lib.toCSV([{ id: '1', text: 'alpha' }]), 'text\\n\"alpha\"\\n');" };
const fakeBreaker = (byRound) => ({ name: 'test', mode: 'MOCK', attack: async ({ round }) => ({ tests: structuredClone(byRound[round] || []), source: 'TEST breaker' }) });

test('referee rejects a Breaker test that fails on the hidden reference fix, admits one that passes', async () => {
  reset(); prepareStaging();
  assert.equal((await applyDiff(canned('export.diff'))).ok, true); // naive candidate in staging
  const events = [];
  const a = new Arena({ issue: ISSUE, breaker: fakeBreaker({ 1: [ALWAYS_QUOTE, COMMA] }), emit: (e) => events.push(e) });
  const r = await a.round({ round: 1, diff: canned('export.diff'), source: 'test' });
  const [q, c] = r.attacks;
  assert.equal(q.verdict, 'rejected'); assert.match(q.reason, /fails on the hidden reference fix/);
  assert.equal(c.verdict, 'admitted');
  assert.deepEqual(r.results.map((x) => [x.id, x.result]), [['R1.2', 'killed']]); // rejected test is never run against the patch
  assert.deepEqual(events.map((e) => e.type), ['patch_proposed', 'attack', 'attack', 'attack_result']);
});

test('referee rejects implementation-detail tests: function source is not observable in the sandbox', async () => {
  reset(); prepareStaging();
  assert.equal((await applyDiff(canned('export.retry.diff'))).ok, true); // behaviourally correct, written differently from the reference
  const SOURCE = { name: 'uses csvCell', kind: 'unit', code: "assert.ok(lib.toCSV.toString().includes('csvCell'), 'toCSV does not escape cells');" };
  const PROTO = { name: 'proto source', kind: 'unit', code: "assert.ok(Function.prototype.toString.call(lib.toCSV).includes('csvCell'));" };
  const a = new Arena({ issue: ISSUE, breaker: fakeBreaker({ 1: [SOURCE, PROTO, COMMA] }) });
  const r = await a.round({ round: 1, diff: canned('export.retry.diff'), source: 'test' });
  assert.deepEqual(r.attacks.map((x) => x.verdict), ['rejected', 'rejected', 'admitted']);
  assert.deepEqual(r.results.map((x) => x.result), ['survived']); // the correct candidate is not killed
});

test('an admitted test that fails on the candidate is fed back to the Fixer, which retries', async () => {
  const calls = [];
  const fixer = { name: 'test-fixer', fix: async (args) => { calls.push(args); return { diff: canned(args.breakerFailures ? 'export.retry.diff' : 'export.diff'), source: 'TEST' }; } };
  const p = new Pipeline({ fixer, breaker: fakeBreaker({ 1: [COMMA] }) });
  const ev = []; p.on('arena', (e) => ev.push(e));
  await p.init({ reset: true });
  const rec = await p.handlePost({ text: ISSUE.text, author: 'x', source: 'inject', createdAt: Date.now() });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].breakerFailures[0].name, COMMA.name);
  assert.match(calls[1].breakerFailures[0].output, /eggs, milk/);
  assert.equal(calls[1].previousDiff, canned('export.diff'));
  assert.ok(ev.some((e) => e.type === 'retry'));
  assert.equal(rec.status, 'shipped');
  await stopLive(); await closeBrowser();
});

test('Breaker tests run sandboxed: no env secrets, no file reads/writes outside the lib, no network, no child processes, timeout', async () => {
  process.env.XAI_API_KEY = 'xai-TEST-NOT-A-REAL-KEY-0123456789';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-'));
  const secret = path.join(dir, '.env'); fs.writeFileSync(secret, 'XAI_API_KEY=xai-TEST-FILE-SECRET\n');
  const lib = path.join(LIVE, 'public', 'lib', 'notes.js');
  const run = (code) => runUnitInSandbox(code, lib, { timeoutMs: 3000 });
  const env = await run("const leaked = Object.entries(process.env).filter(([k, v]) => /KEY|TOKEN|SECRET/i.test(k) || /xai-/.test(v)); if (leaked.length) throw new Error('LEAK ' + JSON.stringify(leaked));");
  assert.equal(env.pass, true, env.error);
  const read = await run(`process.getBuiltinModule('fs').readFileSync(${JSON.stringify(secret)}, 'utf8')`);
  assert.equal(read.pass, false); assert.doesNotMatch(read.error, /FILE-SECRET/); assert.match(read.error, /restricted/);
  const before = fs.readFileSync(path.join(LIVE, 'public', 'app.js'), 'utf8');
  const write = await run(`process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(path.join(LIVE, 'public', 'app.js'))}, 'pwned')`);
  assert.equal(write.pass, false); assert.equal(fs.readFileSync(path.join(LIVE, 'public', 'app.js'), 'utf8'), before);
  const net = await run("try { await fetch('http://1.1.1.1/'); } catch (e) { throw new Error('blocked ' + (e.cause?.code || e.message)); } ");
  assert.equal(net.pass, false); assert.match(net.error, /blocked/);
  const cp = await run("process.getBuiltinModule('child_process').execSync('id')");
  assert.equal(cp.pass, false); assert.match(cp.error, /restricted/);
  const loop = await run('while (true) {}');
  assert.equal(loop.timedOut, true);
  assert.match(lintTest({ name: 'x', kind: 'unit', code: "const fs = await import('node:fs')" }), /module loading/);
  assert.match(lintTest({ name: 'x', kind: 'browser', plan: [{ op: 'goto', path: '@evil.example/' }, { op: 'expectCount', selector: 'a', count: 1 }] }), /same-origin/);
  delete process.env.XAI_API_KEY;
});

test('diff gate rejects a patch that pastes admitted Breaker test code into app source', () => {
  const line = "assert.equal(lib.toCSV([{ id: '1', text: 'eggs, milk' }]), 'text\\n\"eggs, milk\"\\n');";
  const diff = `--- a/public/lib/notes.js\n+++ b/public/lib/notes.js\n@@ -1,1 +1,2 @@\n export function addNote(notes, text) {\n+${line}\n`;
  assert.equal(checkDiff(diff).ok, true);
  const r = checkDiff(diff, { forbidLines: [line] });
  assert.equal(r.ok, false); assert.match(r.reasons.join(), /Breaker test code copied into app source/);
});

test('full MOCK arena story: export ships after exactly 2 attempts (naive fix killed, invalid attack rejected)', async () => {
  const p = new Pipeline({ fixer: 'mock', breaker: 'mock' });
  const ev = []; p.on('arena', (e) => ev.push(e));
  await p.init({ reset: true });
  const rec = await p.handlePost({ text: ISSUE.text, author: 'x', source: 'inject', createdAt: Date.now() });
  assert.equal(rec.status, 'shipped');
  assert.equal(rec.attempts, 2);
  assert.equal(rec.arena.verdict, 'ship');
  const [r1, r2] = rec.arena.rounds;
  assert.deepEqual(r1.attacks.map((a) => a.verdict), ['admitted', 'admitted', 'rejected']);
  assert.deepEqual(r1.results.map((x) => x.result), ['killed', 'survived']);
  assert.ok(r2.results.every((x) => x.result === 'survived') && r2.results.length === 3);
  assert.deepEqual(ev.map((e) => e.type), ['patch_proposed', 'attack', 'attack', 'attack', 'attack_result', 'attack_result', 'retry', 'patch_proposed', 'attack', 'attack_result', 'attack_result', 'attack_result', 'verdict']);
  assert.match(fs.readFileSync(path.join(LIVE, 'public', 'lib', 'notes.js'), 'utf8'), /replaceAll/); // the correct retry is what shipped
  await stopLive(); await closeBrowser();
});
