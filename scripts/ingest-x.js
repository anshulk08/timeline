// Fetch a real X post by URL (Grok x_search) into a running control server: npm run ingest-x -- https://x.com/<user>/status/<id>
import { controlPost } from './control-client.js';
const [url] = process.argv.slice(2);
if (!url) { console.error('usage: npm run ingest-x -- https://x.com/<user>/status/<id>'); process.exit(2); }
const r = await controlPost('/api/ingest-x', { url }, { timeoutMs: 90000 });
console.log(r.status, await r.text());
