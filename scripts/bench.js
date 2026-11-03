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
console.log(`\nMODE=${p.mode} fixer=${p.fixer.name} arena=${p.breaker ? `${p.breaker.mode}/${p.breaker.name}` : 'off'} runs=${runs}`);
console.log('| run | post | verdict | status | attempts | detect | classify | reproduce | fix | gate+test | arena | deploy | total s |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const x of all) console.log(`| ${x.run} | ${x.post.text.slice(0, 48)} | ${x.verdict?.category}${x.verdict?.signature ? '/' + x.verdict.signature : ''} | ${x.status} | ${x.attempts ?? '-'} | ${f(x.stages.detect)} | ${f(x.stages.classify)} | ${f(x.stages.reproduce)} | ${f(x.stages.fix)} | ${f(x.stages.gate_test)} | ${f(x.stages.arena)} | ${f(x.stages.deploy)} | ${(x.totalMs / 1000).toFixed(2)} |`);
const arenaRecs = all.filter((x) => x.arena);
if (arenaRecs.length) {
  console.log(`\nPATCH ARENA (breaker=${p.breaker.name}, ${p.breaker.mode}; the MOCK Breaker uses canned attacks, so this measures plumbing, not Grok's attack quality)`);
  console.log('| run | bug | round | patch from | breaker s | attacks | admitted | rejected | killed | referee s | attack runs s | fix s | gate+test s | verdict |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const s = (ms) => (ms != null ? (ms / 1000).toFixed(2) : '-');
  for (const x of arenaRecs) for (const r of x.arena.rounds) console.log(`| ${x.run} | ${x.verdict.signature} | ${r.round} | ${r.patchSource} | ${s(r.breakerMs)} | ${r.attacks.length} | ${r.admitted} | ${r.rejected} | ${r.killed} | ${s(r.refereeMs)} | ${s(r.attackMs)} | ${s(r.fixMs)} | ${s(r.gateTestMs)} | ${r.round === x.arena.rounds.length ? x.arena.verdict : 'retry'} |`);
}
const bugs = all.filter((x) => x.post.expect === 'fix');
const atk = all.filter((x) => x.post.expect === 'refuse');
console.log(`\nfix success: ${bugs.filter((x) => x.status === 'shipped').length}/${bugs.length}`);
console.log(`attack refusal: ${atk.filter((x) => x.status === 'refused').length}/${atk.length}`);
console.log(`other expectations: ${all.filter((x) => x.post.expect && !['fix', 'refuse'].includes(x.post.expect)).map((x) => `${x.post.expect}->${x.status}`).join(', ')}`);
process.exit(0);
