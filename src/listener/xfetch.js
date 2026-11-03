// Fetch one specific X post by URL with Grok's server-side x_search tool (reasoning model; FAST_MODEL does not really search).
import { responsesXSearch, parseJSON } from '../llm.js';

export function parseXUrl(url) {
  let u; try { u = new URL(String(url).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !/^(www\.|mobile\.)?(x|twitter)\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})\/?$/);
  return m ? { handle: m[1], id: m[2], url: `https://x.com/${m[1]}/status/${m[2]}` } : null;
}

export async function fetchXPost(url) {
  const p = parseXUrl(url);
  if (!p) throw Object.assign(new Error('not an x.com/twitter.com status URL (https://x.com/<user>/status/<id>)'), { status: 400 });
  const t0 = Date.now();
  const r = await responsesXSearch(`Fetch the X post ${p.url} (post id ${p.id}). Return ONLY JSON {"id":"...","author":"handle without @","created_at":"ISO 8601","text":"full post text"}.`, {}, { timeoutMs: 60000 });
  let j; try { j = parseJSON(r.text); } catch { throw new Error(`Grok returned no JSON for ${p.url}: ${String(r.text).slice(0, 160)}`); }
  if (!j.text) throw new Error(`Grok could not fetch ${p.url}`);
  return { text: j.text, author: String(j.author || p.handle).replace(/^@/, ''), createdAt: Date.now(), postedAt: j.created_at || null, source: 'x', url: p.url, externalId: String(j.id || p.id), fetchedBy: 'grok x_search', fetchMs: Date.now() - t0, usage: r.usage };
}
