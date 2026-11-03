// REAL source: official X API v2 mentions timeline for the app's handle (APP_X_HANDLE).
// Polls GET /2/users/:id/mentions with since_id; posts that already existed at startup are skipped.
// Needs X_BEARER_TOKEN in ~/grokathon/.env. Never logs the token.
import { X_HANDLE } from '../env.js';

const API = 'https://api.x.com/2';

async function xget(pathAndQuery, token) {
  const r = await fetch(`${API}${pathAndQuery}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`X API ${r.status}: ${body.title || body.detail || 'error'}`); e.status = r.status; throw e; }
  return body;
}

export function createXApiListener(onPost, { pollMs = Number(process.env.X_API_POLL_MS) || 15000, onPoll } = {}) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error('xapi listener needs X_BEARER_TOKEN in ~/grokathon/.env');
  let timer, stopped = false, userId = null, sinceId = null, primed = false;

  async function tick() {
    if (stopped) return;
    const t0 = Date.now();
    try {
      if (!userId) userId = (await xget(`/users/by/username/${encodeURIComponent(X_HANDLE)}`, token)).data.id;
      const q = new URLSearchParams({ max_results: '10', 'tweet.fields': 'created_at,author_id', expansions: 'author_id', 'user.fields': 'username' });
      if (sinceId) q.set('since_id', sinceId);
      const j = await xget(`/users/${userId}/mentions?${q}`, token);
      const users = Object.fromEntries((j.includes?.users || []).map((u) => [u.id, u.username]));
      const posts = (j.data || []).slice().reverse(); // oldest first
      if (j.meta?.newest_id) sinceId = j.meta.newest_id;
      if (primed) {
        for (const p of posts) {
          const author = users[p.author_id] || p.author_id;
          onPost({ text: p.text, author, createdAt: Date.now(), postedAt: p.created_at || null, source: 'x', url: `https://x.com/${author}/status/${p.id}`, externalId: p.id, fetchedBy: 'X API mentions (@' + X_HANDLE + ')' });
        }
      }
      onPoll && onPoll({ source: 'xapi', n: primed ? posts.length : 0, apiMs: Date.now() - t0, primed: !primed });
      primed = true;
    } catch (e) {
      onPoll && onPoll({ source: 'xapi', error: e.message, apiMs: Date.now() - t0 });
    }
    if (!stopped) timer = setTimeout(tick, pollMs);
  }
  return { name: 'xapi', start() { tick(); }, stop() { stopped = true; clearTimeout(timer); } };
}
