// REAL source: polls Grok's server-side x_search tool (Responses API) for new posts mentioning @handle.
import { X_HANDLE, MODE } from '../env.js';
import { responsesXSearch, parseJSON } from '../llm.js';

export async function searchMentions({ handle = X_HANDLE, query = null, sinceDate } = {}) {
  const day = (d) => d.toISOString().slice(0, 10);
  const from = sinceDate || day(new Date(Date.now() - 864e5));
  const to = day(new Date(Date.now() + 2 * 864e5));
  const ask = query
    ? `Use X search (keyword search, latest mode) to find X posts containing the exact text "${query}". `
    : `Use X search (keyword search, latest mode) to find the most recent X posts that mention @${handle}. `;
  const t0 = Date.now();
  const r = await responsesXSearch(ask + `Return ONLY JSON: {"posts":[{"id":"post id","url":"https://x.com/...","author":"handle","text":"full text","created_at":"ISO 8601"}]}. Newest first, max 20. If none, {"posts":[]}.`,
    { from_date: from, to_date: to }); // default (reasoning) model: FAST_MODEL answers '0 posts' without calling the tool
  let posts = [];
  try { posts = parseJSON(r.text).posts || []; } catch {}
  return { posts, citations: r.citations, apiMs: Date.now() - t0, usage: r.usage };
}

export function createXSearchListener(onPost, { pollMs = Number(process.env.X_POLL_MS) || 30000, onPoll } = {}) {
  if (MODE !== 'REAL') throw new Error('xsearch listener needs XAI_API_KEY in ~/grokathon/.env');
  const seen = new Set();
  const startedAt = Date.now();
  let timer, stopped = false, first = true;
  async function tick() {
    try {
      const { posts, apiMs } = await searchMentions();
      onPoll?.({ n: posts.length, apiMs });
      for (const p of posts) {
        const key = p.id || p.url || p.text;
        if (seen.has(key)) continue;
        seen.add(key);
        const createdAt = Date.parse(p.created_at) || null;
        // ignore anything posted before the listener started (first poll primes the seen-set)
        if (first && (!createdAt || createdAt < startedAt - 120000)) continue;
        onPost({ text: p.text, author: p.author, createdAt: createdAt || Date.now(), source: 'xsearch', url: p.url, externalId: p.id });
      }
    } catch (e) { onPoll?.({ error: e.message }); }
    first = false;
    if (!stopped) timer = setTimeout(tick, pollMs);
  }
  return { name: 'xsearch', start() { tick(); }, stop() { stopped = true; clearTimeout(timer); } };
}
