// Runs the full pipeline in-process: N runs x (3 bug posts + 1 duplicate + 5 attacks + 1 feature + 1 noise), resetting between runs.
import { Pipeline } from '../src/pipeline.js';
import { closeBrowser } from '../src/reproducer.js';
import { stopLive } from '../src/shipper.js';
import { POSTS } from './posts.js';

const runs = Number(process.argv[2] || 2);
const fixer = process.argv[3];
const p = new Pipeline({ fixer });
if (process.env.VERBOSE) p.on('log', (e) => console.log(`  [${e.postId || '-'}] ${e.stage}: ${e.msg}`));
const all = [];
for (let r = 1; r <= runs; r++) {
  await p.init({ reset: true });
  const recs = [];
  for (const post of POSTS) recs.push(await p.handlePost({ ...post, source: 'inject', createdAt: Date.now() }));
  for (const x of recs) all.push({ run: r, ...x });
}
await stopLive(); await closeBrowser();

const f = (s) => (s?.ms != null ? (s.ms / 1000).toFixed(2) : '-');
console.log(`\nMODE=${p.mode} fixer=${p.fixer.name} runs=${runs}`);
console.log('| run | post | verdict | status | detect | classify | reproduce | fix | gate+test | deploy | total s |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const x of all) console.log(`| ${x.run} | ${x.post.text.slice(0, 48)} | ${x.verdict?.category}${x.verdict?.signature ? '/' + x.verdict.signature : ''} | ${x.status} | ${f(x.stages.detect)} | ${f(x.stages.classify)} | ${f(x.stages.reproduce)} | ${f(x.stages.fix)} | ${f(x.stages.gate_test)} | ${f(x.stages.deploy)} | ${(x.totalMs / 1000).toFixed(2)} |`);
const bugs = all.filter((x) => x.post.expect === 'fix');
const atk = all.filter((x) => x.post.expect === 'refuse');
console.log(`\nfix success: ${bugs.filter((x) => x.status === 'shipped').length}/${bugs.length}`);
console.log(`attack refusal: ${atk.filter((x) => x.status === 'refused').length}/${atk.length}`);
console.log(`other expectations: ${all.filter((x) => x.post.expect && !['fix', 'refuse'].includes(x.post.expect)).map((x) => `${x.post.expect}->${x.status}`).join(', ')}`);
process.exit(0);
