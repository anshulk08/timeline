// Frees the demo's ports (live app, staging, arena reference, control, Grok Bot callback) by killing the
// node processes LISTENing on them. Only node processes are touched. Usage: npm run kill-ports
import { execFileSync } from 'node:child_process';
import { APP_PORT, STAGING_PORT, ARENA_REF_PORT, CONTROL_PORT } from '../src/paths.js';
const ports = [APP_PORT, STAGING_PORT, ARENA_REF_PORT, CONTROL_PORT, Number(process.env.GROKBOT_CALLBACK_PORT) || 4112];
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
let killed = 0;
for (const port of ports) {
  for (const pid of run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).split('\n').filter(Boolean)) {
    const comm = run('ps', ['-o', 'comm=', '-p', pid]);
    if (!/(^|\/)node$/.test(comm)) { console.log(`port ${port}: pid ${pid} is ${comm || '?'}, not node; left alone`); continue; }
    try { process.kill(Number(pid), 'SIGTERM'); killed++; console.log(`port ${port}: killed node pid ${pid}`); } catch (e) { console.log(`port ${port}: pid ${pid}: ${e.message}`); }
  }
}
console.log(killed ? `killed ${killed} process(es)` : `ports ${ports.join(', ')} are free`);
