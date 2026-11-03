// Control server: live feed (SSE), inject endpoint, change viewer. Usage: npm start [-- --source inject|xsearch|both]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Pipeline } from './pipeline.js';
import { createListener } from './listener/index.js';
import { liveShow, liveLog, stopLive } from './shipper.js';
import { ROOT, RUNS, CONTROL_PORT, APP_PORT } from './paths.js';
import { MODE, X_HANDLE } from './env.js';

const srcArg = process.argv.includes('--source') ? process.argv[process.argv.indexOf('--source') + 1] : (MODE === 'REAL' ? 'both' : 'inject');
const pipeline = new Pipeline();
const clients = new Set();
const send = (type, data) => { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(msg); };
const slim = (r) => ({ ...r, plan: r.plan });
pipeline.on('update', (r) => send('update', slim(r)));
pipeline.on('log', (e) => send('log', e));
pipeline.on('reset', () => send('reset', {}));

const listeners = [];
const inject = createListener('inject', (p) => pipeline.handlePost(p));
listeners.push(inject);
if (srcArg === 'xsearch' || srcArg === 'both') {
  try {
    const xs = createListener('xsearch', (p) => pipeline.handlePost(p), { onPoll: (s) => send('poll', { ...s, t: Date.now() }) });
    listeners.push(xs);
  } catch (e) { console.log(`xsearch listener disabled: ${e.message}`); }
}

const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const html = fs.readFileSync(path.join(ROOT, 'control', 'index.html'));

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(html); }
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ mode: pipeline.mode, fixer: pipeline.fixer.name, listeners: listeners.map((l) => l.name), handle: X_HANDLE, appUrl: `http://localhost:${APP_PORT}`, records: pipeline.records.map(slim) })}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (u.pathname === '/api/inject' && req.method === 'POST') {
    const b = await body(req);
    if (!b.text) { res.statusCode = 400; return res.end('text required'); }
    inject.inject(b);
    res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ queued: true }));
  }
  if (u.pathname === '/api/reset' && req.method === 'POST') { await pipeline.queue; await pipeline.init({ reset: true }); return res.end('reset'); }
  if (u.pathname.startsWith('/changes/')) {
    const out = await liveShow(u.pathname.split('/')[2] || '');
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    if (!out) { res.statusCode = 404; return res.end('no such change'); }
    return res.end(out);
  }
  if (u.pathname === '/changes') { res.setHeader('content-type', 'text/plain'); return res.end(await liveLog()); }
  if (u.pathname.startsWith('/runs/')) {
    const f = path.join(RUNS, path.basename(u.pathname));
    if (!f.endsWith('.png') || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'image/png'); return fs.createReadStream(f).pipe(res);
  }
  res.statusCode = 404; res.end('not found');
}).listen(CONTROL_PORT, async () => {
  await pipeline.init({ reset: true });
  for (const l of listeners) l.start();
  console.log(`[${MODE}] control screen http://localhost:${CONTROL_PORT}  demo app http://localhost:${APP_PORT}  listeners: ${listeners.map((l) => l.name).join(', ')}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stopLive(); process.exit(0); });
