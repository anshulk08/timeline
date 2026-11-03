// M5: measure X-search freshness. YOU post the printed unique string on X yourself; this script never posts.
// Usage: npm run measure-x-latency [-- --interval 5 --max 600]
import readline from 'node:readline/promises';
import { MODE } from '../src/env.js';
import { searchMentions } from '../src/listener/xsearch.js';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const interval = arg('interval', 5) * 1000, maxS = arg('max', 600);
if (MODE !== 'REAL') { console.error('No XAI_API_KEY in ~/grokathon/.env (MOCK mode). Add the key, then rerun. Nothing measured.'); process.exit(2); }
const token = `cc-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
console.log(`\n1) Post this on X now (any account; include it verbatim):\n\n   ${token} testing @${process.env.APP_X_HANDLE || 'jotterapp'} export is broken\n`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question('2) Press Enter the moment the post is live... ');
rl.close();
const t0 = Date.now();
let polls = 0;
while ((Date.now() - t0) / 1000 < maxS) {
  polls++;
  const ps = Date.now();
  let res;
  try { res = await searchMentions({ query: token }); } catch (e) { console.log(`poll ${polls}: error ${e.message}`); await new Promise((r) => setTimeout(r, interval)); continue; }
  const hit = res.posts.find((p) => (p.text || '').includes(token));
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`poll ${polls} @ ${el}s: ${res.posts.length} posts returned, api ${res.apiMs} ms${hit ? '  <-- FOUND' : ''}`);
  if (hit) {
    console.log(`\nRESULT: found after ${el}s (${polls} polls; last poll api latency ${res.apiMs} ms). url=${hit.url || '?'} created_at=${hit.created_at || '?'}`);
    process.exit(0);
  }
  const wait = interval - (Date.now() - ps);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
console.log(`\nRESULT: NOT found within ${maxS}s (${polls} polls).`);
process.exit(1);
