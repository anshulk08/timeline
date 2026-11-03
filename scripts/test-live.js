import { runAppTests } from '../src/tests.js';
import { LIVE, STAGING_PORT } from '../src/paths.js';
const r = await runAppTests(LIVE, STAGING_PORT);
console.log(JSON.stringify(r, null, 2));
