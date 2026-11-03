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

// Start an app server from dir on port; resolves with handle once /health is ok.
export async function startApp(dir, port) {
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  const ok = await waitHealthy(port);
  return { child, ok, stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill('SIGTERM'); }) };
}
