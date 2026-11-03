// Inject a fake post into a running control server: npm run inject -- "@jotterapp export is broken" [author]
import { controlPost } from './control-client.js';
const [text, author = 'judge'] = process.argv.slice(2);
if (!text) { console.error('usage: npm run inject -- "<post text>" [author]'); process.exit(2); }
const r = await controlPost('/api/inject', { text, author, createdAt: Date.now() });
console.log(r.status, await r.text());
