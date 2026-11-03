// Talks to a running control server (npm start) with the per-boot token from runs/.control-token.
import fs from 'node:fs';
import path from 'node:path';
import { RUNS, CONTROL_PORT } from '../src/paths.js';
const BASE = `http://127.0.0.1:${CONTROL_PORT}`;
export async function controlUp() {
  try { await fetch(BASE + '/changes', { signal: AbortSignal.timeout(500) }); return true; } catch { return false; }
}
export function controlPost(p, body = {}, { timeoutMs = 600000 } = {}) {
  let token = '';
  try { token = fs.readFileSync(path.join(RUNS, '.control-token'), 'utf8').trim(); } catch {}
  return fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
}
