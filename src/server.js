// Control server: live feed (SSE), inject endpoint, change viewer. Usage: npm start [-- --source inject|xsearch|both]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Pipeline } from './pipeline.js';
import { TargetPipeline } from './target/pipeline.js';
import { TARGET, isConfigTarget } from './target/core.js';
import { createListener } from './listener/index.js';
import { parseXUrl, fetchXPost } from './listener/xfetch.js';
import { liveShow, liveLog, stopLive } from './shipper.js';
import { stopAllChildren } from './proc.js';
import { ROOT, RUNS, CONTROL_PORT, APP_PORT } from './paths.js';
import { MODE, MODE_LABEL, X_HANDLE } from './env.js';

const srcArg = process.argv.includes('--source') ? process.argv[process.argv.indexOf('--source') + 1] : (MODE === 'REAL' ? 'both' : 'inject');
const pipeline = isConfigTarget() ? new TargetPipeline({ cfg: TARGET }) : new Pipeline();
const clients = new Set();
const send = (type, data) => { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(msg); };
const slim = (r) => ({ ...r, plan: r.plan });
pipeline.on('update', (r) => send('update', slim(r)));
pipeline.on('log', (e) => send('log', e));
let arenaLog = []; // replayed in `hello` so a reload mid-arena shows the rounds so far
pipeline.on('reset', () => { arenaLog = []; send('reset', {}); });
pipeline.on('arena', (e) => { arenaLog.push(e); send('arena', e); }); // Patch Arena events, schema in ARENA.md
// Config-target events (TARGET=<name>): repro_test, candidates, candidate, tier, auto_applied, pr_ready
let targetLog = [];
pipeline.on('reset', () => { targetLog = []; });
for (const t of ['repro_test', 'candidates', 'candidate', 'tier', 'auto_applied', 'pr_ready', 'grokbot_verify', 'xexam_started', 'xexam_done']) pipeline.on(t, (e) => { targetLog.push({ type: t, ...e }); send(t, e); });

const listeners = [];
const inject = createListener('inject', (p) => pipeline.handlePost(p));
listeners.push(inject);
if (srcArg === 'xsearch' || srcArg === 'both') {
  try {
    const xs = createListener('xsearch', (p) => pipeline.handlePost(p), { onPoll: (s) => send('poll', { ...s, t: Date.now() }) });
    listeners.push(xs);
  } catch (e) { console.log(`xsearch listener disabled: ${e.message}`); }
}
if (srcArg === 'xapi' || srcArg === 'both' || (process.env.X_BEARER_TOKEN && srcArg !== 'inject-only')) {
  try {
    const xa = createListener('xapi', (p) => { send('log', { t: Date.now(), stage: 'x-api', msg: `X API mention: @${p.author}: ${p.text}` }); pipeline.handlePost(p).catch(() => {}); }, { onPoll: (s) => send('poll', { ...s, t: Date.now() }) });
    listeners.push(xa);
    console.log('xapi listener: watching X mentions of @' + (process.env.APP_X_HANDLE || '?'));
  } catch (e) { console.log(`xapi listener disabled: ${e.message}`); }
}

// Control API hardening: loopback bind, Host check (DNS rebinding), per-boot token on /api/*, JSON-only bodies
// (blocks cross-site "simple" text/plain POSTs), same-origin Origin, 16 KB body cap.
const HOST = process.env.CONTROL_HOST || '127.0.0.1';
const TOKEN = crypto.randomBytes(18).toString('hex');
const TOKEN_FILE = path.join(RUNS, '.control-token'); // read by npm run inject / npm run reset (same user only)
const MAX_BODY = 16 * 1024;
const okHosts = new Set([`localhost:${CONTROL_PORT}`, `127.0.0.1:${CONTROL_PORT}`, `[::1]:${CONTROL_PORT}`]);
const okOrigins = new Set([...okHosts].map((h) => `http://${h}`));
const tokenOk = (t) => typeof t === 'string' && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
const body = (req) => new Promise((resolve, reject) => {
  let b = '', n = 0;
  req.on('data', (d) => { n += d.length; if (n > MAX_BODY) { req.removeAllListeners('data'); req.resume(); reject(Object.assign(new Error(`body larger than ${MAX_BODY} bytes`), { status: 413 })); } else b += d; });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
  req.on('error', reject);
});
const html = () => fs.readFileSync(path.join(ROOT, 'control', 'index.html'), 'utf8').replace('__CONTROL_TOKEN__', TOKEN); // read per request so UI edits show on reload
const deny = (res, code, msg) => { res.statusCode = code; res.setHeader('content-type', 'text/plain'); res.end(msg); };
let resetting = false;

http.createServer(async (req, res) => {
  if (!okHosts.has(req.headers.host || '')) return deny(res, 421, 'bad host');
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    if (req.method !== 'POST') return deny(res, 405, 'POST only');
    if (req.headers.origin && !okOrigins.has(req.headers.origin)) return deny(res, 403, 'cross-origin request refused');
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return deny(res, 415, 'content-type must be application/json');
    if (!tokenOk(req.headers['x-control-token'])) return deny(res, 401, 'missing or wrong x-control-token (printed at startup, also in runs/.control-token)');
    let b;
    try { b = await body(req); } catch (e) { return deny(res, e.status || 400, e.message); }
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/api/inject') {
      if (typeof b.text !== 'string' || !b.text.trim()) return deny(res, 400, 'text required');
      inject.inject(b);
      return res.end(JSON.stringify({ queued: true, afterReset: resetting }));
    }
    if (u.pathname === '/api/ingest-x') { // fetch one real X post by URL with Grok x_search, then run it like an injected post
      if (!parseXUrl(b.url)) return deny(res, 400, 'url must be an x.com/twitter.com status URL (https://x.com/<user>/status/<id>)');
      if (MODE !== 'REAL') return deny(res, 503, 'ingest-x needs XAI_API_KEY (REAL mode)');
      send('log', { t: Date.now(), stage: 'x-fetch', msg: `Grok x_search fetching ${b.url} ...` });
      let p;
      try { p = await fetchXPost(b.url); } catch (e) { send('log', { t: Date.now(), stage: 'x-fetch', msg: `fetch failed: ${e.message}` }); return deny(res, e.status || 502, `fetch failed: ${e.message}`); }
      send('log', { t: Date.now(), stage: 'x-fetch', msg: `fetched from X by Grok in ${p.fetchMs} ms: @${p.author} (${p.postedAt || '?'}): ${p.text}` });
      const { usage, ...post } = p;
      pipeline.handlePost(post).catch(() => {});
      return res.end(JSON.stringify({ queued: true, post: { author: post.author, postedAt: post.postedAt, url: post.url, id: post.externalId, text: post.text, fetchMs: post.fetchMs } }));
    }
    if (u.pathname === '/api/reset') {
      resetting = true; send('resetting', { t: Date.now() });
      try { await pipeline.reset(); } catch (e) { return deny(res, 500, `reset failed: ${e.message}`); } finally { resetting = false; send('resetting_done', { t: Date.now() }); }
      return res.end(JSON.stringify({ reset: true }));
    }
    if (u.pathname === '/api/skip-grokbot') {
      const n = pipeline.grokbot ? pipeline.grokbot.skipWaiting('skipped by operator from the control screen') : 0;
      return res.end(JSON.stringify({ skipped: n }));
    }
    return deny(res, 404, 'not found');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return deny(res, 405, 'GET only');
  if (u.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(html()); }
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ mode: pipeline.mode, modeLabel: MODE_LABEL, fixer: pipeline.fixer.name, breaker: pipeline.breaker ? { name: pipeline.breaker.name, mode: pipeline.breaker.mode } : null, listeners: listeners.map((l) => l.name), handle: X_HANDLE, reproducer: pipeline.grokbot ? { label: pipeline.grokbot.label, target: pipeline.grokbot.target, publicAppUrl: pipeline.grokbot.cfg.publicAppUrl } : { label: 'Playwright (local)', target: 'local' }, appUrl: `http://localhost:${APP_PORT}`, records: pipeline.records.map(slim), arena: arenaLog, target: isConfigTarget() ? { name: pipeline.cfg.name, display_name: pipeline.cfg.display_name, repo: pipeline.cfg.repo, branch: pipeline.cfg.branch, events: targetLog } : null, resetting })}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (u.pathname.startsWith('/changes/')) {
    const out = await liveShow(u.pathname.split('/')[2] || '');
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    if (!out) { res.statusCode = 404; return res.end('no such change'); }
    return res.end(out);
  }
  if (u.pathname === '/changes') { res.setHeader('content-type', 'text/plain'); return res.end(await liveLog()); }
  if (/^\/runs\/pr\/[A-Za-z0-9._-]+\.md$/.test(u.pathname)) { // PR-tier bodies written by TargetPipeline
    const f = path.join(RUNS, 'pr', path.basename(u.pathname));
    if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('no such PR body'); }
    res.setHeader('content-type', 'text/plain; charset=utf-8'); return fs.createReadStream(f).pipe(res);
  }
  if (u.pathname.startsWith('/runs/')) {
    const f = path.join(RUNS, path.basename(u.pathname));
    if (!/\.(png|jpg)$/.test(f) || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', f.endsWith('.jpg') ? 'image/jpeg' : 'image/png'); return fs.createReadStream(f).pipe(res);
  }
  res.statusCode = 404; res.end('not found');
}).on('error', (e) => fatal(e.code === 'EADDRINUSE' ? new Error(`control port ${CONTROL_PORT} in use (another npm start?) - run \`npm run kill-ports\``) : e))
  .listen(CONTROL_PORT, HOST, async () => {
  try {
    if (pipeline.grokbot) await pipeline.grokbot.start(); // separate server on its own port; only it gets tunnelled
    await pipeline.init({ reset: true });
  } catch (e) { return fatal(e); }
  fs.writeFileSync(TOKEN_FILE, TOKEN + '\n', { mode: 0o600 });
  for (const l of listeners) l.start();
  console.log(`[${MODE}] control screen http://localhost:${CONTROL_PORT}  demo app http://localhost:${APP_PORT}  listeners: ${listeners.map((l) => l.name).join(', ')}  (bound to ${HOST})`);
  console.log(`control API: /api/* needs the per-boot token in ${path.relative(ROOT, TOKEN_FILE)} (mode 600; the control screen and npm run inject/reset read it, the value is never printed)`);
  console.log(pipeline.grokbot ? `${pipeline.grokbot.describe()}  callback server :${pipeline.grokbot.cfg.callbackPort}` : 'reproducer: Playwright (local). Grok Bot handoff OFF (see GROKBOT.md)');
});

// Every exit path stops the live app, any staging / arena-reference servers and the Grok Bot callback server.
let stopping = false;
async function shutdown(code) {
  if (stopping) return; stopping = true;
  const t = setTimeout(() => process.exit(code), 5000); // never hang on exit
  try { await pipeline.grokbot?.stop(); } catch {}
  try { await stopLive(); } catch {}
  try { await stopAllChildren(); } catch {}
  try { fs.rmSync(TOKEN_FILE, { force: true }); } catch {}
  clearTimeout(t); process.exit(code);
}
function fatal(e) { console.error(`fatal: ${e.message}`); return shutdown(1); }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(0));
process.on('uncaughtException', fatal);
process.on('unhandledRejection', (e) => fatal(e instanceof Error ? e : new Error(String(e))));
