// npm run tunnel: cloudflared quick tunnels for (1) the live demo app and (2) the Grok Bot callback server ONLY.
// The control server (inject/reset/changes) is never tunnelled. Writes runs/tunnel.json, which the pipeline reads
// when PUBLIC_APP_URL / PUBLIC_CALLBACK_URL are not set. Ctrl-C closes both tunnels and removes the file.
// CLOUDFLARED_BIN overrides the binary (used by the test with a fake binary; no network).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { APP_PORT, RUNS } from '../src/paths.js';
import { TUNNEL_FILE } from '../src/grokbot/config.js';

const CALLBACK_PORT = Number(process.env.GROKBOT_CALLBACK_PORT) || 4112;
const BIN = process.env.CLOUDFLARED_BIN || 'cloudflared';
const TIMEOUT = Number(process.env.TUNNEL_TIMEOUT_MS) || 45000;
const children = [];

export const parseUrl = (s) => (s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/) || [])[0] || null;

function open(port, name) {
  return new Promise((resolve, reject) => {
    const p = spawn(BIN, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(p);
    let buf = '';
    const t = setTimeout(() => reject(new Error(`${name}: no trycloudflare URL within ${TIMEOUT} ms`)), TIMEOUT);
    const on = (d) => { buf += d; const u = parseUrl(buf); if (u) { clearTimeout(t); resolve(u); } };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`${name}: cloudflared exited ${c}`)); });
  });
}

function cleanup() { for (const c of children) c.kill('SIGTERM'); try { fs.rmSync(TUNNEL_FILE, { force: true }); } catch {} }

try {
  const [app_url, callback_url] = await Promise.all([open(APP_PORT, 'app'), open(CALLBACK_PORT, 'callback')]);
  fs.mkdirSync(RUNS, { recursive: true });
  fs.writeFileSync(TUNNEL_FILE, JSON.stringify({ app_url, callback_url, app_port: APP_PORT, callback_port: CALLBACK_PORT, startedAt: new Date().toISOString() }, null, 2));
  console.log(`PUBLIC_APP_URL=${app_url}      (-> live demo app :${APP_PORT})`);
  console.log(`PUBLIC_CALLBACK_URL=${callback_url} (-> Grok Bot callback server :${CALLBACK_PORT}, only POST /grokbot/callback/:job_id)`);
  console.log(`wrote ${TUNNEL_FILE}. Leave this running; start the pipeline with npm start in another terminal. Ctrl-C to close.`);
} catch (e) { console.error(`tunnel failed: ${e.message}`); cleanup(); process.exit(1); }
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { cleanup(); process.exit(0); });
