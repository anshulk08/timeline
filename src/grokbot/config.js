// Grok Bot handoff config. Enabled only when all four values resolve. Secret values are never printed.
// PUBLIC_APP_URL / PUBLIC_CALLBACK_URL fall back to runs/tunnel.json (written by `npm run tunnel`).
import fs from 'node:fs';
import path from 'node:path';
import '../env.js'; // loads ~/grokathon/.env
import { RUNS } from '../paths.js';

export const TUNNEL_FILE = path.join(RUNS, 'tunnel.json');

function readTunnel() {
  try { return JSON.parse(fs.readFileSync(TUNNEL_FILE, 'utf8')); } catch { return {}; }
}
const isLocal = (u) => { try { return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };

export function grokbotConfig(env = process.env) {
  const t = readTunnel();
  const c = {
    webhookUrl: env.GROKBOT_WEBHOOK_URL || '',
    webhookKey: env.GROKBOT_WEBHOOK_KEY || '',
    signingSecret: env.GROKBOT_SIGNING_SECRET || '', // optional HMAC (scheme unconfirmed, see GROKBOT.md)
    publicAppUrl: (env.PUBLIC_APP_URL || t.app_url || '').replace(/\/+$/, ''),
    publicCallbackUrl: (env.PUBLIC_CALLBACK_URL || t.callback_url || '').replace(/\/+$/, ''),
    callbackPort: Number(env.GROKBOT_CALLBACK_PORT) || 4112,
    timeoutMs: Number(env.GROKBOT_TIMEOUT_MS) || 150000,
    crossCheck: env.GROKBOT_CROSSCHECK !== '0',
  };
  c.enabled = !!(c.webhookUrl && c.webhookKey && c.publicAppUrl && c.publicCallbackUrl) && env.GROKBOT_DISABLE !== '1';
  // Honest labelling: a webhook on this machine is the local stub (scripts/fake-grokbot.js), never the real routine.
  c.target = !c.enabled ? 'off' : isLocal(c.webhookUrl) ? 'LOCAL STUB' : 'REAL';
  c.label = c.target === 'REAL' ? 'Grok Bot (cloud browser)' : 'fake-grokbot (LOCAL STUB of Grok Bot)';
  return c;
}

// Safe summary for logs: never includes key or secret values.
export const describe = (c) => c.enabled
  ? `Grok Bot handoff ON [${c.target}] webhook=${new URL(c.webhookUrl).host} key=set${c.signingSecret ? ' hmac=on' : ''} app=${c.publicAppUrl} callback=${c.publicCallbackUrl} timeout=${c.timeoutMs}ms crossCheck=${c.crossCheck}`
  : 'Grok Bot handoff OFF (needs GROKBOT_WEBHOOK_URL, GROKBOT_WEBHOOK_KEY, PUBLIC_APP_URL, PUBLIC_CALLBACK_URL)';
