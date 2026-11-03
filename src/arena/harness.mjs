// FIXED HARNESS for Breaker "unit" tests. Runs as a sandboxed child process (see sandbox.js):
// empty env, Node permission model (read-only: this file + the one lib file; no writes, no child processes, no workers),
// macOS sandbox-exec with all network denied when available. Usage: node harness.mjs <libPath>  (test JSON on stdin)
// Test contract: `code` is the BODY of `async function (lib, assert)`; lib = exports of public/lib/notes.js,
// assert = node:assert/strict. Throw (or fail an assert) to fail. No imports.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };
try {
  const libPath = process.argv[2];
  let src = '';
  for await (const c of process.stdin) src += c;
  const { code } = JSON.parse(src);
  const real = await import(pathToFileURL(libPath).href);
  // Tests may only observe BEHAVIOUR: exports are opaque wrappers, function source is hidden and stack traces are cut,
  // so a test cannot pass/fail on how the patch is written (e.g. lib.toCSV.toString().includes('csvCell')).
  const lib = Object.freeze(Object.fromEntries(Object.entries(real).map(([k, v]) => [k, typeof v === 'function' ? (...a) => v(...a) : v])));
  const hidden = function toString() { return 'function () { [native code] }'; };
  Object.defineProperty(Function.prototype, 'toString', { value: hidden, writable: false, configurable: false });
  Error.stackTraceLimit = 0;
  const AsyncFunction = (async () => {}).constructor;
  const fn = new AsyncFunction('lib', 'assert', '"use strict";\n' + code);
  await fn(lib, assert);
  out({ pass: true });
} catch (e) {
  out({ pass: false, error: String((e && e.message) || e).slice(0, 600) });
}
