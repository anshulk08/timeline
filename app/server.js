// Jotter demo app server. Static assets are loaded into memory at boot,
// so a deploy really requires a restart (like a real build/deploy).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whoami } from './auth/roles.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;
const ASSETS = ['index.html', 'app.js', 'styles.css', 'lib/notes.js'];
const files = Object.fromEntries(ASSETS.map((f) => ['/' + f, fs.readFileSync(path.join(root, 'public', f))]));
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css' };

http.createServer((req, res) => {
  let u = req.url.split('?')[0];
  if (u === '/') u = '/index.html';
  if (u === '/health') return res.end('ok');
  if (u === '/api/whoami') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(whoami(req.headers['x-user'])));
  }
  const body = files[u];
  if (!body) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', TYPES[u.split('.').pop()]);
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}).listen(PORT, () => console.log(`jotter listening on ${PORT}`));
