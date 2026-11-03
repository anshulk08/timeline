// REAL fixer: Grok writes a unified diff. One retry with the apply error if it does not apply.
import { chat } from '../llm.js';
import { MODEL } from '../env.js';
const SYS = `You fix bugs in a small web app. Output ONLY a unified diff (git format) and nothing else, no prose, no code fences.
Rules: paths are relative to the app root with a/ and b/ prefixes (e.g. "--- a/public/app.js" / "+++ b/public/app.js"). Only edit the files shown.
Make the smallest possible change. Do not add comments. Do not touch auth, users, roles, permissions, admin, storage, network calls, or tests.
Include 3 lines of unchanged context around each change, copied exactly.`;
export async function fix({ issue, repro, files, previousError, previousDiff, breakerFailures }) {
  const listing = Object.entries(files).map(([p, c]) => `=== ${p} ===\n${c}`).join('\n\n');
  const user = `Bug report from a user: ${issue.text}\nTriage summary: ${issue.summary}\nBrowser reproduction failures: ${JSON.stringify(repro?.failures || [])}\nBrowser console errors: ${JSON.stringify(repro?.consoleErrors || [])}\n\nFiles:\n${listing}` +
    (previousError ? `\n\nYour previous diff failed to apply: ${previousError}\nReturn a corrected diff.` : '') +
    (breakerFailures?.length ? `\n\nYour previous patch passed the existing tests:\n${previousDiff}\nbut an adversarial Breaker found tests (each verified against a correct implementation) that it FAILS:\n` +
      breakerFailures.map((t) => `- ${t.name}\n  ${t.kind === 'unit' ? `test body (lib = public/lib/notes.js exports, assert = node:assert/strict):\n${t.code}` : `browser plan: ${JSON.stringify(t.plan)}`}\n  failure output: ${t.output}`).join('\n') +
      `\nReturn a NEW complete diff against the ORIGINAL files shown above (not on top of your previous patch) that fixes the bug and passes these tests. Fix the behaviour; do not paste test code into the app.` : '');
  let diff = await chat([{ role: 'system', content: SYS }, { role: 'user', content: user }], { model: MODEL });
  diff = diff.replace(/^```\w*\n?/m, '').replace(/\n?```\s*$/m, '').trim() + '\n';
  return { diff, source: `REAL grok (${MODEL})` };
}
