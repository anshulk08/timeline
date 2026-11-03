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
if (import.meta.url === `file://${process.argv[1]}`) { reset(); console.log('live/ reset to pristine (3 planted bugs)'); }
