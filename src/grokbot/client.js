// Grok Bot client: POSTs a reproduction job to the routine's Webhook trigger and waits for the callback.
// Auth: Authorization: Bearer <GROKBOT_WEBHOOK_KEY> (default). If GROKBOT_SIGNING_SECRET is set, also sends
// webhook-timestamp + webhook-signature: sha256=<hex HMAC of "<timestamp>.<body>"> (scheme unconfirmed).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { grokbotConfig, describe } from './config.js';
import { createCallbackServer } from './callback-server.js';
import { ROUTINE_INSTRUCTIONS } from './instructions.js';
import { RUNS } from '../paths.js';

export function buildJob(cfg, { complaint, author }) {
  const job_id = `job_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
  const callback_token = crypto.randomBytes(24).toString('hex'); // per job
  return {
    job_id, complaint, author,
    app_url: cfg.publicAppUrl,
    callback_url: `${cfg.publicCallbackUrl}/grokbot/callback/${job_id}`,
    callback_token,
    instructions: ROUTINE_INSTRUCTIONS,
  };
}

export function signedHeaders(cfg, body, now = Date.now()) {
  const h = { 'content-type': 'application/json', authorization: `Bearer ${cfg.webhookKey}` };
  if (cfg.signingSecret) {
    const ts = String(Math.floor(now / 1000));
    h['webhook-timestamp'] = ts;
    h['webhook-signature'] = 'sha256=' + crypto.createHmac('sha256', cfg.signingSecret).update(`${ts}.${body}`).digest('hex');
  }
  return h;
}

function saveScreenshot(b64, name) {
  const buf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (buf.length < 8) return null;
  const ext = buf[0] === 0x89 && buf[1] === 0x50 ? 'png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : null;
  if (!ext) return null;
  fs.mkdirSync(RUNS, { recursive: true });
  const f = path.join(RUNS, `${name}.${ext}`);
  fs.writeFileSync(f, buf);
  return f;
}

export class GrokBot {
  constructor(cfg = grokbotConfig(), { log = () => {} } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.callbacks = createCallbackServer({ port: cfg.callbackPort, log: (m) => this.log(m) });
    this.started = false;
  }
  get label() { return this.cfg.label; }
  get target() { return this.cfg.target; }
  describe() { return describe(this.cfg); }
  async start() { if (!this.started) { await this.callbacks.listen(); this.started = true; } }
  async stop() { if (this.started) { this.started = false; await this.callbacks.close(); } }
  // Operator escape hatch (control screen "Skip to Playwright"): stop waiting for callbacks; the pipeline falls back.
  skipWaiting(reason = 'skipped by operator') { const ids = [...this.callbacks.pending.keys()]; for (const id of ids) this.callbacks.cancel(id, reason); return ids.length; }

  // Returns {ok, job_id, result?, error?, dispatchMs, waitMs, screenshotFile?}
  async reproduce({ complaint, author, name = 'grokbot', timeoutMs = this.cfg.timeoutMs }) {
    await this.start();
    const job = buildJob(this.cfg, { complaint, author });
    const waiting = this.callbacks.expect(job.job_id, job.callback_token, timeoutMs);
    const body = JSON.stringify(job);
    const t0 = Date.now();
    try {
      const r = await fetch(this.cfg.webhookUrl, { method: 'POST', headers: signedHeaders(this.cfg, body), body, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`webhook HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } catch (e) {
      this.callbacks.cancel(job.job_id, `dispatch failed: ${e.message}`);
    }
    const dispatchMs = Date.now() - t0;
    const out = await waiting;
    const res = { ...out, job_id: job.job_id, dispatchMs, waitMs: Date.now() - t0 };
    if (out.ok && out.result.screenshot_base64) res.screenshotFile = saveScreenshot(out.result.screenshot_base64, `${name}-grokbot`);
    return res;
  }
}
