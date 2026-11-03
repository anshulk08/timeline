import path from 'node:path';
import { sh, startApp } from './proc.js';

export async function runTestsAgainst(dir, url) {
  const t0 = Date.now();
  const r = await sh(process.execPath, ['--test', '--test-reporter=tap', path.join('test', 'unit.test.js'), path.join('test', 'e2e.test.js')],
    { cwd: dir, env: { ...process.env, APP_URL: url } });
  const pass = [], fail = [];
  for (const line of r.out.split('\n')) {
    const m = line.match(/^\s*(not ok|ok) \d+ - (.+?)\s*$/);
    if (m && !/\.test\.js$/.test(m[2])) (m[1] === 'ok' ? pass : fail).push(m[2]);
  }
  return { pass, fail, ms: Date.now() - t0 };
}

// Boots dir on port, runs the suite, stops the server.
export async function runAppTests(dir, port) {
  const t0 = Date.now();
  const srv = await startApp(dir, port);
  if (!srv.ok) { await srv.stop(); return { pass: [], fail: ['<server failed to boot>'], ms: Date.now() - t0, bootFailed: true }; }
  const r = await runTestsAgainst(dir, `http://127.0.0.1:${port}`);
  await srv.stop();
  return { ...r, ms: Date.now() - t0 };
}
