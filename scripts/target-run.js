// One complaint through a config target, no control server. Prints every event with timings.
// Usage: TARGET=simpliearn node scripts/target-run.js [--bug <seeded id>] ["complaint text"]
import { TargetPipeline } from '../src/target/pipeline.js';
import { TARGET } from '../src/target/core.js';
import { MODE_LABEL } from '../src/env.js';

const args = process.argv.slice(2);
const bi = args.indexOf('--bug');
const p = new TargetPipeline({ cfg: TARGET });
const bug = bi >= 0 ? p.cfg.seeded_bugs.find((b) => b.id === args[bi + 1]) : p.cfg.seeded_bugs.find((b) => b.expected_tier === 'auto') || p.cfg.seeded_bugs[0];
const text = args.filter((a, i) => i !== bi && i !== bi + 1)[0] || bug?.complaint;
if (!text) { console.error('no complaint text and no seeded bug'); process.exit(2); }
const T0 = Date.now();
const at = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`.padStart(6);
p.on('log', (e) => console.log(`${at()} [${e.stage}] ${e.msg}`));
p.on('target_event', (e) => { const { t, type, ...d } = e; console.log(`${at()} EVENT ${type} ${JSON.stringify(d).slice(0, 300)}`); });
p.on('arena', (e) => { if (['skipped', 'attack', 'attack_result', 'verdict'].includes(e.type)) console.log(`${at()} ARENA ${e.type} ${JSON.stringify({ ...e, code: undefined, diff: undefined, t: undefined }).slice(0, 300)}`); });
console.log(`[${MODE_LABEL}] target=${p.cfg.name} complaint: ${text}`);
await p.init();
const rec = await p.handlePost({ text, author: 'demo_user', createdAt: Date.now(), source: 'inject' });
await p.lastCleanup;
console.log(`\nRESULT ${rec.status} tier=${rec.tier || '-'} sha=${rec.sha || '-'} total=${(rec.totalMs / 1000).toFixed(1)}s`);
console.log('stages:', Object.entries(rec.stages).map(([k, v]) => `${k}=${v.ms ?? '?'}ms`).join(' '));
process.exit(['shipped', 'pr-ready'].includes(rec.status) ? 0 : 1);
