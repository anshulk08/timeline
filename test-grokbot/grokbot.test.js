// Grok Bot handoff tests, against scripts/fake-grokbot.js (LOCAL STUB, not Grok Bot).
// Ports: APP 4010, STAGING 4011, callback 4112, fake routine 4113 (override via env).
process.env.APP_PORT ||= '4010';
process.env.STAGING_PORT ||= '4011';
process.env.FORCE_MOCK = '1';
delete process.env.NODE_TEST_CONTEXT; // else the app's own node --test children report to this runner, not as TAP
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { Pipeline } = await import('../src/pipeline.js');
const { GrokBot } = await import('../src/grokbot/client.js');
const { grokbotConfig } = await import('../src/grokbot/config.js');
const { createCallbackServer } = await import('../src/grokbot/callback-server.js');
const { stopLive } = await import('../src/shipper.js');
const { closeBrowser } = await import('../src/reproducer.js');
const { APP_PORT, ROOT } = await import('../src/paths.js');

const CB = 4112, STUB = 4113;
const KEY = 'test-key-' + Math.random().toString(36).slice(2); // throwaway, not a real secret
const stubScript = fileURLToPath(new URL('../scripts/fake-grokbot.js', import.meta.url));

function startStub(mode, delay = 800) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [stubScript], { env: { ...process.env, GROKBOT_WEBHOOK_KEY: KEY, FAKE_GROKBOT_MODE: mode, FAKE_GROKBOT_DELAY_MS: String(delay), FAKE_GROKBOT_PORT: String(STUB) }, stdio: ['ignore', 'pipe', 'inherit'] });
    p.logs = '';
    p.stdout.on('data', (d) => { p.logs += d; if (/ on :/.test(p.logs)) resolve(p); });
    p.on('exit', (c) => reject(new Error(`stub exited ${c}`)));
  });
}
const stopStub = (p) => new Promise((r) => { p.removeAllListeners('exit'); p.once('exit', r); p.kill('SIGTERM'); });

function makeBot(extra = {}) {
  const cfg = grokbotConfig({
    GROKBOT_WEBHOOK_URL: `http://127.0.0.1:${STUB}/webhook`, GROKBOT_WEBHOOK_KEY: KEY,
    PUBLIC_APP_URL: `http://127.0.0.1:${APP_PORT}`, PUBLIC_CALLBACK_URL: `http://127.0.0.1:${CB}`,
    GROKBOT_CALLBACK_PORT: String(CB), GROKBOT_TIMEOUT_MS: '20000', ...extra,
  });
  return new GrokBot(cfg);
}
const post = (text) => ({ text, author: 'judge', source: 'inject', createdAt: Date.now() });

after(async () => { await stopLive(); await closeBrowser(); });

test('config: off without all four values, local webhook labelled LOCAL STUB, never REAL', () => {
  assert.equal(grokbotConfig({ GROKBOT_WEBHOOK_URL: 'https://x/y' }).enabled, false);
  const c = makeBot().cfg;
  assert.equal(c.enabled, true); assert.equal(c.target, 'LOCAL STUB');
  assert.equal(grokbotConfig({ GROKBOT_WEBHOOK_URL: 'https://api2.cursor.sh/automations/webhook/abc', GROKBOT_WEBHOOK_KEY: 'k', PUBLIC_APP_URL: 'https://a', PUBLIC_CALLBACK_URL: 'https://b' }).target, 'REAL');
});

test('callback server: bad token 403, bad schema 400, other routes 404, good token 200, replay 404', async () => {
  const s = createCallbackServer({ port: CB });
  await s.listen();
  try {
    const wait = s.expect('job_abc', 'right-token', 5000);
    const u = `http://127.0.0.1:${CB}/grokbot/callback/job_abc`;
    const body = JSON.stringify({ reproduced: true, steps: ['a'], observed: 'x' });
    const h = (t) => ({ 'content-type': 'application/json', 'x-callback-token': t });
    assert.equal((await fetch(u, { method: 'POST', headers: h('wrong'), body })).status, 403);
    assert.equal((await fetch(u, { method: 'POST', body })).status, 403);
    assert.equal((await fetch(u, { method: 'POST', headers: h('right-token'), body: '{"reproduced":"yes"}' })).status, 400);
    for (const p of ['/api/inject', '/api/reset', '/events', '/', '/changes']) assert.equal((await fetch(`http://127.0.0.1:${CB}${p}`, { method: 'POST' })).status, 404, p);
    assert.equal((await fetch(u, { method: 'GET' })).status, 404);
    const big = JSON.stringify({ reproduced: true, steps: [], observed: '', screenshot_base64: 'A'.repeat(7 * 1024 * 1024) });
    assert.equal((await fetch(u, { method: 'POST', headers: h('right-token'), body: big })).status, 413);
    assert.equal((await fetch(u, { method: 'POST', headers: h('right-token'), body })).status, 200);
    const r = await wait; assert.equal(r.ok, true); assert.equal(r.result.reproduced, true);
    assert.equal((await fetch(u, { method: 'POST', headers: h('right-token'), body })).status, 404);
  } finally { await s.close(); }
});

test('e2e: injected post -> webhook to stub -> callback -> pipeline continues -> fix ships', async () => {
  const stub = await startStub('ok');
  const bot = makeBot();
  const p = new Pipeline({ fixer: 'mock', grokbot: bot });
  try {
    await p.init({ reset: true });
    const rec = await p.handlePost(post('@jotterapp the export button is broken, I click it and nothing happens'));
    assert.equal(rec.status, 'shipped', JSON.stringify(rec.reproducer));
    assert.equal(rec.reproducer.by, 'grokbot');
    assert.equal(rec.reproducer.target, 'LOCAL STUB');
    assert.ok(rec.reproducer.steps.length > 0);
    assert.equal(rec.reproducer.crossCheck.reproduced, true);
    assert.match(rec.screenshot, /-grokbot\.png$/);
    assert.ok(fs.existsSync(`${ROOT}/runs/${rec.screenshot.split('/').pop()}`));
    assert.match(stub.logs, /callback -> 200/);
  } finally { await bot.stop(); await stopStub(stub); }
});

test('Grok Bot says not reproduced -> stop, no fix', async () => {
  const stub = await startStub('notrepro');
  const bot = makeBot();
  const p = new Pipeline({ fixer: 'mock', grokbot: bot });
  try {
    await p.init({ reset: true });
    const rec = await p.handlePost(post("@jotterapp search doesn't find my note 'Buy Milk' when I type milk"));
    assert.equal(rec.status, 'not-reproduced');
    assert.equal(rec.reproducer.by, 'grokbot');
    assert.equal(rec.stages.fix, undefined);
    assert.equal(rec.sha, undefined);
  } finally { await bot.stop(); await stopStub(stub); }
});

test('bad callback token rejected -> pipeline times out -> Playwright fallback ships', async () => {
  const stub = await startStub('badtoken', 300);
  const bot = makeBot({ GROKBOT_TIMEOUT_MS: '4000' });
  const p = new Pipeline({ fixer: 'mock', grokbot: bot });
  try {
    await p.init({ reset: true });
    const rec = await p.handlePost(post('@jotterapp when I add a note it flashes and then disappears??'));
    assert.match(stub.logs, /callback -> 403/);
    assert.equal(rec.reproducer.by, 'playwright-fallback');
    assert.match(rec.reproducer.label, /FALLBACK/);
    assert.equal(rec.status, 'shipped');
  } finally { await bot.stop(); await stopStub(stub); }
});

test('timeout (routine never calls back) -> labelled Playwright fallback ships', async () => {
  const stub = await startStub('silent', 0);
  const bot = makeBot({ GROKBOT_TIMEOUT_MS: '2000' });
  const p = new Pipeline({ fixer: 'mock', grokbot: bot });
  try {
    await p.init({ reset: true });
    const rec = await p.handlePost(post('@jotterapp the export button is broken, I click it and nothing happens'));
    assert.equal(rec.reproducer.by, 'playwright-fallback');
    assert.match(rec.reproducer.error, /timeout/);
    assert.equal(rec.status, 'shipped');
  } finally { await bot.stop(); await stopStub(stub); }
});

test('webhook rejects wrong Bearer key -> dispatch error -> fallback (no wait for timeout)', async () => {
  const stub = await startStub('ok');
  const bot = makeBot({ GROKBOT_WEBHOOK_KEY: 'not-the-key' });
  const p = new Pipeline({ fixer: 'mock', grokbot: bot });
  try {
    await p.init({ reset: true });
    const t0 = Date.now();
    const rec = await p.handlePost(post('@jotterapp the export button is broken, I click it and nothing happens'));
    assert.equal(rec.reproducer.by, 'playwright-fallback');
    assert.match(rec.reproducer.error, /HTTP 401/);
    assert.ok(Date.now() - t0 < 15000);
  } finally { await bot.stop(); await stopStub(stub); }
});

test('tunnel script parses cloudflared URLs and writes runs/tunnel.json (fake cloudflared, no network)', async () => {
  const fake = `${ROOT}/runs/fake-cloudflared.sh`;
  fs.mkdirSync(`${ROOT}/runs`, { recursive: true });
  fs.writeFileSync(fake, '#!/bin/sh\nport=$(echo "$4" | sed "s/.*://")\necho "INF |  https://fake-$port.trycloudflare.com  |" 1>&2\nexec sleep 30\n', { mode: 0o755 });
  const p = spawn(process.execPath, [`${ROOT}/scripts/tunnel.js`], { env: { ...process.env, CLOUDFLARED_BIN: fake, GROKBOT_CALLBACK_PORT: String(CB) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  try {
    await new Promise((r, j) => { const t = setInterval(() => { if (/wrote/.test(out)) { clearInterval(t); r(); } }, 50); setTimeout(() => j(new Error(out)), 8000); });
    const t = JSON.parse(fs.readFileSync(`${ROOT}/runs/tunnel.json`, 'utf8'));
    assert.equal(t.app_url, `https://fake-${APP_PORT}.trycloudflare.com`);
    assert.equal(t.callback_url, `https://fake-${CB}.trycloudflare.com`);
  } finally { await new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); }); fs.rmSync(fake, { force: true }); }
  assert.equal(fs.existsSync(`${ROOT}/runs/tunnel.json`), false);
});
