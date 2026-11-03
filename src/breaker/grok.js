// REAL Breaker: one Grok call per arena round writes up to 3 adversarial tests aimed at the proposed patch.
// It never sees the hidden reference fix. Output format is strict JSON; parsing tolerates code fences.
import { chat, parseJSON } from '../llm.js';
import { MODEL } from '../env.js';
export const name = 'grok';
const SYS = `You are the Breaker. A Fixer agent just patched a bug in a small notes web app (Jotter). The patch passes the existing tests.
Your job: write up to 3 adversarial tests that a CORRECT, COMPLETE fix of this bug must pass but that this patch might FAIL
(edge cases: special characters, empty input, ordering, repeated actions, case, whitespace, boundaries).
A hidden referee runs every test against a correct reference implementation first: tests that fail there are thrown out as invalid,
so only assert behaviour that clearly follows from the bug report and normal expectations. Do not assert arbitrary formatting choices.

Return ONLY JSON: {"tests":[ ... ]} with at most 3 items, each one of:
1) {"name":"short description","kind":"unit","code":"<JS body>"}
   code is the BODY of async function (lib, assert). lib = the exports of public/lib/notes.js (as shown below), assert = node:assert/strict.
   Notes are objects {id, text}. No import/require, no network, no filesystem, no timers over 1s. Fail by throwing or a failing assert.
2) {"name":"short description","kind":"browser","plan":[steps]}  (a browser test against the patched app; no code)
   Steps: {"op":"goto","path":"/"} | {"op":"fill","selector","value"} | {"op":"click","selector"} | {"op":"press","selector","key"} | {"op":"wait","ms"} |
   {"op":"expectCount","selector","count"} | {"op":"expectText","selector","text"} | {"op":"expectDownload","selector"}. "/?seed=a,b" preloads notes "a" and "b". Max 12 steps.`;

export function parseTests(content) {
  const s = String(content).replace(/```(?:json|javascript|js)?\s*/gi, '').replace(/```/g, '');
  let j;
  try { j = parseJSON(s); } catch { const m = s.match(/\[[\s\S]*\]/); j = m ? JSON.parse(m[0]) : null; }
  const arr = Array.isArray(j) ? j : j?.tests;
  if (!Array.isArray(arr)) throw new Error('Breaker output had no tests array');
  return arr.slice(0, 3).map((t) => ({ name: String(t?.name || '').slice(0, 120), kind: t?.kind, code: t?.code, plan: t?.plan }));
}

export async function attack({ issue, diff, files, round, prior = [] }) {
  const t0 = Date.now();
  const listing = Object.entries(files).map(([p, c]) => `=== ${p} (after the patch) ===\n${c}`).join('\n\n');
  const user = `Bug report from a user: ${issue.text}\nTriage summary: ${issue.summary}\nArena round ${round}.\n\nProposed patch:\n${diff}\n\n${listing}` +
    (prior.length ? `\n\nAlready-admitted tests (do not repeat): ${JSON.stringify(prior.map((t) => t.name))}` : '');
  const content = await chat([{ role: 'system', content: SYS }, { role: 'user', content: user }], { model: MODEL, json: true });
  return { tests: parseTests(content), source: `REAL grok Breaker (${MODEL})`, ms: Date.now() - t0 };
}
