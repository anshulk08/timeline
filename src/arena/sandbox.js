// Runs one LLM-written Breaker test. Unit tests: sandboxed child process. Browser tests: data-only plan DSL run by the trusted reproducer.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPlan } from '../reproducer.js';

export const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'harness.mjs');
export const HAS_SANDBOX_EXEC = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
// Deny every network operation and every file write (except /dev/null) at the OS level.
const PROFILE = '(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write-data (literal "/dev/null"))';
const PLAN_OPS = new Set(['goto', 'fill', 'click', 'press', 'wait', 'expectCount', 'expectText', 'expectDownload']);
const MAX_CODE = 4000;

// Static checks on a Breaker test before anything runs. Returns null if OK, else a reason string.
export function lintTest(t) {
  if (!t || typeof t !== 'object') return 'not an object';
  if (typeof t.name !== 'string' || !t.name.trim()) return 'missing name';
  if (t.kind === 'unit') {
    if (typeof t.code !== 'string' || !t.code.trim()) return 'unit test has no code';
    if (t.code.length > MAX_CODE) return `code longer than ${MAX_CODE} chars`;
    if (/\bimport\b|\brequire\s*\(|getBuiltinModule|process\.binding|process\.dlopen|\bmodule\.constructor\b/.test(t.code)) return 'module loading is not allowed in Breaker tests';
    return null;
  }
  if (t.kind === 'browser') {
    if (!Array.isArray(t.plan) || !t.plan.length || t.plan.length > 12) return 'browser plan must have 1-12 steps';
    for (const s of t.plan) {
      if (!PLAN_OPS.has(s?.op)) return `unknown plan op ${s?.op}`;
      if (s.op === 'goto' && !/^\/(?!\/)[^\s@\\]*$/.test(String(s.path ?? '/'))) return `goto path must be a same-origin path: ${String(s.path).slice(0, 40)}`;
    }
    if (!t.plan.some((s) => s.op.startsWith('expect'))) return 'browser plan has no expectation';
    return null;
  }
  return `unknown kind ${t.kind}`;
}

// code runs against the lib file at libPath. Never inherits process.env. Returns {pass, error?, ms, timedOut?}
export function runUnitInSandbox(code, libPath, { timeoutMs = 5000 } = {}) {
  const t0 = Date.now();
  const nodeArgs = ['--permission', `--allow-fs-read=${HARNESS}`, `--allow-fs-read=${libPath}`, HARNESS, libPath];
  const [cmd, args] = HAS_SANDBOX_EXEC ? ['/usr/bin/sandbox-exec', ['-p', PROFILE, process.execPath, ...nodeArgs]] : [process.execPath, nodeArgs];
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: {}, cwd: path.dirname(libPath), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ ...r, ms: Date.now() - t0 }); };
    const timer = setTimeout(() => { p.kill('SIGKILL'); finish({ pass: false, timedOut: true, error: `timed out after ${timeoutMs} ms` }); }, timeoutMs);
    p.stdout.on('data', (d) => { if (out.length < 65536) out += d; });
    p.stderr.on('data', (d) => { if (err.length < 8192) err += d; });
    p.on('error', (e) => finish({ pass: false, error: `spawn failed: ${e.message}` }));
    p.on('close', () => {
      const line = out.trim().split('\n').pop();
      try { const j = JSON.parse(line); finish({ pass: j.pass === true, error: j.error }); }
      catch { finish({ pass: false, error: `harness produced no result: ${(err || out).trim().slice(0, 300)}` }); }
    });
    p.stdin.end(JSON.stringify({ code }));
  });
}

// Runs a linted test against an app tree (dir) served at url. Returns {pass, error?, ms}
export async function runBreakerTest(t, { dir, url }) {
  if (t.kind === 'unit') return runUnitInSandbox(t.code, path.join(dir, 'public', 'lib', 'notes.js'));
  const t0 = Date.now();
  const r = await runPlan(t.plan, url, null);
  return { pass: !r.reproduced, error: r.failures.join('; ') || undefined, ms: Date.now() - t0 };
}
