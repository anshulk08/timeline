// Minimal callback server for Grok Bot. This is the ONLY server that gets tunnelled for callbacks.
// Exposes exactly one route: POST /grokbot/callback/:job_id (per-job token, size-limited, schema-checked).
// It has no inject/reset/control/changes endpoints, and it serves nothing back except a short status.
import http from 'node:http';
import crypto from 'node:crypto';

export const MAX_BODY = 6 * 1024 * 1024; // screenshots as base64

const tokEq = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function validateResult(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'body must be a JSON object';
  if (typeof j.reproduced !== 'boolean') return 'reproduced must be boolean';
  if (!Array.isArray(j.steps) || j.steps.length > 50 || !j.steps.every((s) => typeof s === 'string' && s.length <= 500)) return 'steps must be string[] (<=50, each <=500 chars)';
  if (typeof j.observed !== 'string' || j.observed.length > 4000) return 'observed must be a string (<=4000 chars)';
  if (j.screenshot_base64 != null && (typeof j.screenshot_base64 !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(j.screenshot_base64.replace(/^data:image\/\w+;base64,/, '')))) return 'screenshot_base64 must be base64';
  if (j.screenshot_url != null && (typeof j.screenshot_url !== 'string' || !/^https?:\/\//.test(j.screenshot_url) || j.screenshot_url.length > 2000)) return 'screenshot_url must be an http(s) URL';
  return null;
}

export function createCallbackServer({ port, log = () => {} } = {}) {
  const pending = new Map(); // job_id -> {token, resolve, timer}
  const reply = (res, code, msg) => { res.statusCode = code; res.setHeader('content-type', 'text/plain'); res.end(msg); };

  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/grokbot\/callback\/([A-Za-z0-9_-]{1,64})$/);
    if (!m || req.method !== 'POST') return reply(res, 404, 'not found');
    const job = pending.get(m[1]);
    if (!job) return reply(res, 404, 'unknown or expired job');
    if (!tokEq(req.headers['x-callback-token'], job.token)) { log(`callback for ${m[1]} REJECTED: bad token`); return reply(res, 403, 'bad token'); }
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) return reply(res, 413, 'too large');
    const chunks = []; let size = 0, aborted = false;
    req.on('data', (d) => { size += d.length; if (size > MAX_BODY && !aborted) { aborted = true; reply(res, 413, 'too large'); req.destroy(); } else if (!aborted) chunks.push(d); });
    req.on('end', () => {
      if (aborted) return;
      let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, 'invalid JSON'); }
      const err = validateResult(j);
      if (err) return reply(res, 400, err);
      if (!pending.has(m[1])) return reply(res, 409, 'already received');
      pending.delete(m[1]); clearTimeout(job.timer);
      job.resolve({ ok: true, result: j, receivedAt: Date.now() });
      reply(res, 200, 'ok');
    });
  });

  return {
    server,
    pending,
    listen: () => new Promise((r, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', () => r()); }),
    close: () => new Promise((r) => { for (const [, j] of pending) { clearTimeout(j.timer); j.resolve({ ok: false, error: 'server closed' }); } pending.clear(); server.close(() => r()); server.closeAllConnections?.(); }),
    // Registers a job and returns a promise that resolves with the callback or {ok:false,error:'timeout'}.
    expect(jobId, token, timeoutMs) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(jobId); resolve({ ok: false, error: `timeout after ${timeoutMs} ms` }); }, timeoutMs);
        pending.set(jobId, { token, resolve, timer });
      });
    },
    cancel(jobId, error) { const j = pending.get(jobId); if (j) { pending.delete(jobId); clearTimeout(j.timer); j.resolve({ ok: false, error }); } },
  };
}
