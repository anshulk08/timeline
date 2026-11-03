// LOCAL STUB of the Grok Bot routine (NOT Grok Bot). Exercises the webhook -> cloud browser -> callback path
// without the real routine. Accepts the webhook (checks Bearer), drives Playwright against app_url using a
// keyword -> canned plan lookup, screenshots, then POSTs the callback after a delay.
// Results from it say nothing about Grok Bot's ability or latency.
//
// env: FAKE_GROKBOT_PORT (4113), GROKBOT_WEBHOOK_KEY (required), FAKE_GROKBOT_DELAY_MS (2500),
//      FAKE_GROKBOT_MODE = ok | silent (never calls back) | badtoken (calls back with a wrong token) | notrepro
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { CANNED_PLANS, runPlan, closeBrowser } from '../src/reproducer.js';

const PORT = Number(process.env.FAKE_GROKBOT_PORT) || 4113;
const KEY = process.env.GROKBOT_WEBHOOK_KEY || '';
const DELAY = Number(process.env.FAKE_GROKBOT_DELAY_MS ?? 2500);
const MODE = process.env.FAKE_GROKBOT_MODE || 'ok';
if (!KEY) { console.error('fake-grokbot: GROKBOT_WEBHOOK_KEY must be set'); process.exit(2); }

const sigOf = (t) => (/export|download/i.test(t) ? 'export' : /search|find/i.test(t) ? 'search' : /add|note|disappear/i.test(t) ? 'add-note' : null);
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const describeStep = (s) => s.op === 'goto' ? `open ${s.path}` : s.op === 'fill' ? `type "${s.value}" into ${s.selector}` : s.op === 'click' ? `click ${s.selector}`
  : s.op === 'wait' ? `wait ${s.ms} ms` : s.op === 'expectCount' ? `check ${s.selector} count is ${s.count}` : s.op === 'expectDownload' ? `click ${s.selector} and wait for a download` : `${s.op}`;

async function work(job) {
  const sig = sigOf(job.complaint);
  const plan = sig ? CANNED_PLANS[sig] : null;
  let result;
  if (!plan) result = { reproduced: false, steps: [`open ${job.app_url}`], observed: 'stub: no idea how to reproduce this complaint' };
  else {
    const shot = path.join(os.tmpdir(), `fake-grokbot-${job.job_id}.png`);
    const r = await runPlan(plan, job.app_url, shot);
    const reproduced = MODE === 'notrepro' ? false : r.reproduced;
    result = { reproduced, steps: plan.map(describeStep), observed: reproduced ? `stub: ${r.failures.join('; ')}` : 'stub: everything behaved as expected' };
    try { result.screenshot_base64 = fs.readFileSync(shot).toString('base64'); fs.rmSync(shot, { force: true }); } catch {}
  }
  await new Promise((r) => setTimeout(r, DELAY));
  if (MODE === 'silent') return console.log(`fake-grokbot: ${job.job_id} silent mode, not calling back`);
  const token = MODE === 'badtoken' ? 'wrong-token' : job.callback_token;
  const res = await fetch(job.callback_url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-callback-token': token }, body: JSON.stringify(result) }).catch((e) => ({ status: `ERR ${e.message}` }));
  console.log(`fake-grokbot: ${job.job_id} callback -> ${res.status}`);
}

http.createServer((req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  const auth = String(req.headers.authorization || '');
  if (!eq(auth, `Bearer ${KEY}`)) { res.statusCode = 401; return res.end('unauthorized'); }
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    let job; try { job = JSON.parse(b); } catch { res.statusCode = 400; return res.end('bad json'); }
    if (!job.job_id || !job.app_url || !job.callback_url || !job.callback_token) { res.statusCode = 400; return res.end('missing fields'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ accepted: true, job_id: job.job_id }));
    work(job).catch((e) => console.log(`fake-grokbot: ${job.job_id} error ${e.message}`));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`fake-grokbot (LOCAL STUB, not Grok Bot) on :${PORT} mode=${MODE} delay=${DELAY}ms`));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await closeBrowser(); process.exit(0); });
