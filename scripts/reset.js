// Restores the live demo app to the pristine (3 planted bugs) state.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PRISTINE, LIVE, STAGING } from '../src/paths.js';
export function reset() {
  fs.rmSync(LIVE, { recursive: true, force: true });
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.cpSync(PRISTINE, LIVE, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: LIVE, stdio: 'ignore' });
  g('init', '-q'); g('add', '-A');
  g('-c', 'user.name=complaint-commit', '-c', 'user.email=bot@localhost', 'commit', '-qm', 'baseline: 3 planted bugs');
}
// CLI: when the control server is running, ask it to reset (same as the "Reset bugs" button), so its in-memory
// issue state, live app process and live/ stay in sync. Only wipe live/ directly when the server is stopped.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { controlUp, controlPost } = await import('./control-client.js');
  if (await controlUp()) {
    const r = await controlPost('/api/reset');
    console.log(r.ok ? 'control server is running: reset through it (same as the Reset bugs button)' : `control server reset failed: ${r.status} ${await r.text()}`);
    process.exit(r.ok ? 0 : 1);
  }
  reset(); console.log('live/ reset to pristine (3 planted bugs)');
}
