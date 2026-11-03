// Inject a fake post into a running control server: npm run inject -- "@jotterapp export is broken" [author]
const [text, author = 'judge'] = process.argv.slice(2);
if (!text) { console.error('usage: npm run inject -- "<post text>" [author]'); process.exit(2); }
const port = process.env.CONTROL_PORT || 4100;
const r = await fetch(`http://127.0.0.1:${port}/api/inject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, author, createdAt: Date.now() }) });
console.log(r.status, await r.text());
