# Patch Arena

After the Fixer's patch passes the diff gate and the existing tests in staging, a **Breaker** (Grok in REAL mode, canned tests in MOCK mode) writes up to 3 executable adversarial tests aimed at that patch. One Breaker call per round; at most 2 Fixer attempts in total.

## Referee rule
A Breaker test is **ADMITTED** only if it **passes against a hidden reference fix** for that bug (`arena/reference/<signature>.diff`, applied to a copy of live in `.arena-ref/`). A test that fails on the reference is **REJECTED** as an invalid attack (it asserts something a correct fix does not do). An admitted test that fails on the candidate patch **KILLS** it: the test, its code and its failure output go back to the Fixer, which retries. A patch ships only when the original tests and **all** admitted Breaker tests pass.

**The reference fix exists only because this is a demo with planted bugs.** Nothing in the Fixer or Breaker prompt includes it. In a real product there is no reference; you would need another referee (for example, a vote among independent fixes, or a human).

## The demo trap (export)
Export downloads notes as CSV. The planted bug is `new Blob(string)` (throws, nothing downloads). The obvious fix (wrap it in `[ ]`) passes the original test but leaves `toCSV` unescaped, so a note like `eggs, milk` becomes two fields. MOCK story: attempt 1 = naive fix -> Breaker round 1 sends 3 attacks: comma test (admitted, KILLS attempt 1), empty-list test (admitted, survives), "every field quoted" (REJECTED: fails on the reference) -> Fixer attempt 2 = RFC 4180 quoting -> round 2 adds a quotes+newline test -> all 3 admitted tests survive -> ship. add-note and search get a Breaker pass that finds nothing.

## Breaker test format (fixed harness)
JSON `{"tests":[...]}`, max 3, each one of:
- `{"name","kind":"unit","code"}`: `code` is the body of `async function (lib, assert)`; `lib` = exports of `public/lib/notes.js` in the tree under test; `assert` = `node:assert/strict`.
- `{"name","kind":"browser","plan":[...]}`: the reproducer's step DSL (data, not code), run by the trusted Playwright runner against the staging (or reference) server. `goto` paths must be same-origin.

## Sandbox (unit tests are LLM-written code)
`src/arena/sandbox.js` + `src/arena/harness.mjs`. Each test runs in its own child process with: `env: {}` (no XAI_API_KEY or anything else from the parent), Node permission model (`--permission`, read access only to the harness and the one lib file; no fs writes, no child processes, no workers), macOS `sandbox-exec` denying all network and file writes, a 5 s timeout (SIGKILL), and a static lint that rejects `import`/`require`/`getBuiltinModule`. Test code goes in over stdin and is never written to disk. The diff gate (`checkDiff(diff, {forbidLines})`) rejects a patch that pastes admitted Breaker test lines into app source; all existing gate rules still apply.

## Config
`ARENA=0` disables the arena. `BREAKER=mock|grok` (default grok when an xAI key is present, else mock). `ARENA_REF_PORT` (default STAGING_PORT+50) serves the reference copy for browser tests.

## SSE events (`event: arena` on `/events`)
Every event has `{t, postId, mode: "MOCK"|"REAL", type, round}`.
| type | extra fields |
|---|---|
| `patch_proposed` | `source` (who wrote it, e.g. "MOCK canned diff"), `diff`, `changedLines` |
| `attack` | `id` ("R1.2"), `name`, `kind`, `code` or `plan`, `verdict`: `admitted`/`rejected`, `reason`, `refMs` |
| `attack_result` | `id`, `name`, `result`: `survived`/`killed`, `output` (failure message), `ms`. Emitted for every admitted test so far, each round |
| `retry` | `nextAttempt`, `failing`: [{id, name, output}] |
| `verdict` | `result`: `ship`/`killed`/`not-shipped (<stage>)`/`not-run`, `rounds`, `attempts`, `admitted`, `rejected`, `killedBy`: [ids], `reason` |

The record sent in `update` events also carries `rec.arena` = `{breaker, mode, verdict, admitted, rejected, rounds:[{round, patchSource, breakerSource, breakerMs, refereeMs, attackMs, fixMs, gateTestMs, admitted, rejected, killed, attacks, results}]}` and `rec.attempts`.

## Commands
- `npm run test:arena`: referee rejects invalid test; admitted failing test triggers retry; sandbox (no env secrets, fs/network/child-process denied, timeout); gate paste check; full MOCK export story ships after exactly 2 attempts.
- `npm run bench -- 1`: now prints attempts, arena stage time, and a per-round arena table.
