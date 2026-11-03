# Complaint → Commit

**A user finds a bug. Grok fixes it. Another Grok tries to prove the fix is wrong. Only the independently verified patch survives.**

Someone posts on X: "@jotterapp the export button is broken". Grok finds the post with x_search and works out whether it is
a bug, a feature request, noise, or an attack. Grok Bot opens the app in its cloud browser and reproduces the bug. A Grok
Fixer writes a patch. A second Grok, the **Breaker**, then writes tests meant to prove that patch wrong. A referee keeps
only the attacks that are valid, a valid attack that fails sends the patch back to the Fixer, and only a patch that survives
gets deployed. A reply is drafted to the user.

> **Status, honestly:** no xAI key existed when this was built. Everything you can run today is **MOCK** (canned Fixer
> diffs and Breaker tests) or uses a **LOCAL STUB** of Grok Bot. The REAL path for each part is wired behind env vars and
> has been exercised only against local scripted stubs. The UI labels every result MOCK / LOCAL STUB / REAL. See RESULTS.md.

## Architecture
```
X post ──▶ Listener ──▶ Gatekeeper ──▶ Reproducer ─────────────▶ Fixer ──▶ Diff gate ──▶ Staging tests ──▶ PATCH ARENA ──▶ Ship ──▶ Reply draft
 (x_search  (Grok classify +   (Grok Bot cloud browser,   (Grok, or    (allowlist,   (no regressions,    (Breaker vs       (deploy,   (never
  or inject) rule layer)        Playwright fallback +      Cursor)      forbidden     a failing test      referee, ≤2       health +    posted)
                                cross-check)                            identifiers)  now passes,         Fixer attempts)   re-repro,
                                                                                      re-repro fixed)                       rollback)
```
| stage | code | Grok product | MOCK today | REAL path (env) |
|---|---|---|---|---|
| Listener | `src/listener/` | **Grok x_search** (Responses API tool) polls for @mentions | `inject` source (control screen buttons, `npm run inject`) | `XAI_API_KEY`; `npm start -- --source both` |
| Gatekeeper | `src/gatekeeper.js` | **Grok** (fast model) classifies bug / feature / noise / attack | deterministic keyword rules | `XAI_API_KEY`; the rule layer still overrides Grok on known attack patterns |
| Reproducer | `src/reproducer.js`, `src/grokbot/` | **Grok** writes the repro plan; **Grok Bot** (Webhook-triggered routine) runs it in a cloud browser and calls back with steps + screenshot | local Playwright, or `scripts/fake-grokbot.js` (LOCAL STUB) | `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY`, `PUBLIC_APP_URL`, `PUBLIC_CALLBACK_URL` (`npm run tunnel`); see GROKBOT.md |
| Fixer | `src/fixers/` | **Grok** writes a unified diff; on a kill it gets the failing Breaker test + output + its previous diff | canned diffs (`src/fixers/canned/`) | `XAI_API_KEY` (`FIXER=grok`). **Cursor** plugs in here: `FIXER=cursor`, `src/fixers/cursor.js` has the same interface (stub, not wired) |
| Patch Arena | `src/arena/`, `src/breaker/` | **Grok** as Breaker writes ≤3 adversarial tests per round | canned attacks incl. one deliberately invalid one | `XAI_API_KEY` (`BREAKER=grok`); details in ARENA.md |
| Ship | `src/shipper.js` | none | real: commits to the nested `live/` repo, restarts, re-verifies, reverts on failure | same |

## Patch Arena, in one paragraph
After a patch passes the diff gate and the existing staging tests, the Breaker proposes tests (unit tests against
`lib/notes.js`, or browser steps). The **referee** runs each one against a hidden reference fix (`arena/reference/`) and
admits it only if it passes there **3 times out of 3** (flaky tests are rejected), so a test asserting behaviour the spec doesn't require is **REJECTED** with the reason. Unit tests only see opaque wrappers around the lib exports (function source hidden, stack traces cut), so a test can't key on how the patch is written (e.g. `toCSV.toString().includes('csvCell')`). Every
admitted test, from this round and earlier ones, then runs against the candidate. Any failure **KILLS** the patch, and the failing
test and its output go back to the Fixer. At most 2 Fixer attempts. A patch ships only when the original tests and all admitted
Breaker tests pass. Caveats: a test that is wrong in a way the reference also gets wrong, or that is flaky but passes 3 runs in a row, can still be admitted; the referee only knows what the reference does. The reference fix exists only because the bugs are planted. In a real product you would referee
against the spec, or have a human or a third model do it.

## Safety model
- **Gatekeeper:** attack posts ("make everyone admin", "ignore previous instructions", "upload notes to …", "disable the tests") are refused before anything runs. A deterministic rule layer overrides Grok.
- **Diff gate** (`src/gate.js`): a file allowlist (4 front-end files), protected paths, forbidden identifiers in changed lines (auth/admin/role/token/fetch/eval/URLs…), no creates, deletes or renames, ≤30 changed lines, and no pasting admitted Breaker test code into app source. The parser treats `---`/`+++` as file headers only before a file's first `@@`, the way `git apply --recount` does, so an added line disguised as `+++ b/public/index.html <script>…` counts as an added line. After apply, a hash check confirms nothing outside the allowlist changed, and the identifier, line-count and paste checks run a second time on `git diff --no-index` of live vs staging, i.e. on what actually changed on disk rather than on the diff text. The identifier list is a deny-list, so it is a strong filter rather than a proof.
- **Tests:** no regressions, at least one previously failing test now passes, and the reproduction no longer reproduces on staging.
- **Breaker sandbox** (`src/arena/sandbox.js`): LLM-written test code runs in a child process with an empty env, the Node permission model (read only the harness and the lib, no writes, no child processes), macOS `sandbox-exec` (no network, no writes), a lint that rejects import/require, and a 5 s SIGKILL.
- **Deploy:** health check plus re-repro on live, with automatic `git revert` and restart on failure.
- **Grok Bot callback:** a separate server on its own port, a per-job token checked with a constant-time compare, size and schema checks, one callback per job. The control server is never tunnelled.
- **Control server:** bound to 127.0.0.1 (the demo app too), Host header checked (DNS rebinding), and `/api/*` requires POST, `content-type: application/json`, a same-origin or absent `Origin`, a ≤16 KB body and the per-boot token from `runs/.control-token` (mode 600, never printed; the control screen has it embedded, `npm run inject`/`reset` read the file).
- **Nothing is posted.** Replies are drafts, and secrets are never printed (logs say `key=set`).

## Run it
```
cd ~/grokathon/complaint-commit && npm install
npm start                 # control screen http://localhost:4100, demo app http://localhost:4000 (override: APP_PORT/STAGING_PORT/CONTROL_PORT)
npm run reset             # re-plant the 3 bugs. While npm start runs this goes through the server (same as "Reset bugs");
                          # with the server stopped it wipes live/ directly
npm run bench -- 2        # headless table incl. per-round arena table. Server must be STOPPED (bench refuses otherwise)
npm run kill-ports        # frees 4000/4001/4051/4100/4112 (node processes only) after a crash or kill -9
npm run test:gate && npm run test:arena && npm run test:grokbot
# Grok Bot, stub:  GROKBOT_WEBHOOK_KEY=k npm run fake-grokbot   +  GROKBOT_WEBHOOK_URL=http://127.0.0.1:4113/webhook GROKBOT_WEBHOOK_KEY=k PUBLIC_APP_URL=http://127.0.0.1:4000 PUBLIC_CALLBACK_URL=http://127.0.0.1:4112 npm start
# REAL: put XAI_API_KEY (and GROKBOT_* values) in ~/grokathon/.env, then `node scripts/check-xai.js`, `npm run tunnel`, `npm start`
```
Stopping: Ctrl-C, `kill <pid>` (SIGTERM) or SIGHUP stop the live app, any staging / arena-reference servers and the Grok Bot
callback server. A failed start (e.g. a port in use) also cleans up and exits 1. `kill -9` can't be caught; use `npm run kill-ports`.

The header badge shows the mode: `MOCK · no xAI key, canned outputs`, `REAL`, or `REAL code path, LOCAL STUB endpoint`.

## 2-minute demo script (judge)
1. **(0:00) Hook.** "Users complain about bugs on X all day. What if the complaint *was* the bug report, and the fix shipped itself, safely?" Point at the header badge: it says MOCK, and say why (no key yet). Every result is labelled.
2. **(0:15) Inject the complaint.** Click **export broken**. The step bar lights up: Reproduce shows *who* reproduced it (Grok Bot cloud browser, or the labelled Playwright fallback) with the screenshot of the broken page.
3. **(0:35) The arena.** The Fixer's first patch passes the diff gate and the existing tests. A normal pipeline would ship it here. Then the Breaker attacks it:
   - R1.1, "a note with a comma stays one CSV field": **ADMITTED**, and it **KILLED** the patch (show the red assertion output).
   - R1.3, "every field quoted": **REJECTED** by the referee, because it fails on the reference fix too. The referee throws out tests that assert requirements the reference doesn't meet.
4. **(1:05) Retry.** The red banner shows the failing test going back to the Fixer. Attempt 2 survives R1.1, R1.2 and the new R2.1 (quotes and newlines). **SHIPPED**, with a commit link (click it to show the real diff in `live/`) and a draft reply.
   *If Grok Bot is configured but the REAL routine never calls back:* the card says "waiting for the Grok Bot callback" with a
   **Skip to Playwright fallback** button. Click it and the run continues on local Playwright, labelled as a fallback. Without
   the click it waits `GROKBOT_TIMEOUT_MS` (default 150000; set 30000 to 45000 in `~/grokathon/.env` for a live demo), and
   Reset bugs waits behind it.
5. **(1:25) Safety.** Click **!admin**: REFUSED by the gatekeeper. Mention that even a legitimate bug whose patch touches `roles.js` is blocked by the diff gate (`npm run test:gate` proves it), and that Breaker code runs with no network, no env and no writes.
6. **(1:45) Grok everywhere.** Grok x_search hears the complaint, Grok triages it, Grok Bot reproduces it in a cloud browser, Grok fixes, a second Grok attacks, and Cursor can drop in as the Fixer. Close on "only the independently verified patch survives." Press **Reset bugs** to run it again.

## Files
`control/index.html` (control screen, SSE), `src/pipeline.js` (orchestrator), `ARENA.md`, `GROKBOT.md`, `RESULTS.md` (measured numbers), `app/` (Jotter demo app source with 3 planted bugs), `live/` (deployed copy, nested git repo, ignored).
