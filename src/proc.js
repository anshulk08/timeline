import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const execFileP = promisify(execFile);

export function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    if (opts.input) p.stdin.end(opts.input); else p.stdin.end();
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

export async function waitHealthy(port, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// Every app server child (live, staging, arena reference) is tracked so a signal or crash can stop them all.
const children = new Set();
const stopChild = (child) => new Promise((r) => {
  if (child.exitCode !== null || child.signalCode !== null) return r();
  const t = setTimeout(() => child.kill('SIGKILL'), 2000);
  child.once('exit', () => { clearTimeout(t); r(); });
  child.kill('SIGTERM');
});
export const runningChildren = () => [...children].map((c) => c.pid);
export async function stopAllChildren() { await Promise.all([...children].map(stopChild)); }
// Last resort on any exit path (sync): 'exit' handlers cannot await, but kill() is synchronous.
process.on('exit', () => { for (const c of children) if (c.exitCode === null) try { c.kill('SIGKILL'); } catch {} });

// Start an app server from dir on port; resolves with handle once /health is ok.
export async function startApp(dir, port) {
  try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) }); throw new Error(`port ${port} already serving (orphaned app server?) - run \`npm run kill-ports\` first`); }
  catch (e) { if (String(e.message).startsWith('port ')) throw e; }
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  children.add(child); child.once('exit', () => children.delete(child));
  const ok = await waitHealthy(port);
  return { child, ok, stop: () => stopChild(child) };
}
