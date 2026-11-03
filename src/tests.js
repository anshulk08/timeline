import path from 'node:path';
import { sh, startApp } from './proc.js';

// Runs the app's test suite against `dir` served on `port`. Returns {pass:[], fail:[], ms}.
export async function runAppTests(dir, port) {
  const t0 = Date.now();
  const srv = await startApp(dir, port);
  if (!srv.ok) { await srv.stop(); return { pass: [], fail: ['<server failed to boot>'], ms: Date.now() - t0, bootFailed: true }; }
  const r = await sh(process.execPath, ['--test', '--test-reporter=tap', path.join('test', 'unit.test.js'), path.join('test', 'e2e.test.js')],
    { cwd: dir, env: { ...process.env, APP_URL: `http://127.0.0.1:${port}` } });
  await srv.stop();
  const pass = [], fail = [];
  for (const line of r.out.split('\n')) {
    const m = line.match(/^\s*(not ok|ok) \d+ - (.+?)\s*$/);
    if (m && !/\.test\.js$/.test(m[2])) (m[1] === 'ok' ? pass : fail).push(m[2]);
  }
  return { pass, fail, ms: Date.now() - t0 };
}
