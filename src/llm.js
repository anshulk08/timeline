// Single xAI adapter. REAL when XAI_API_KEY exists, else callers use their deterministic MOCK path.
import { MODE, MODEL } from './env.js';
const BASE = process.env.XAI_BASE_URL || 'https://api.x.ai/v1'; // override only for the local stub test
const headers = () => ({ 'content-type': 'application/json', authorization: `Bearer ${process.env.XAI_API_KEY}` });

export const llmMode = () => MODE;

// OpenAI-compatible chat completion. Returns string content.
export async function chat(messages, { model = MODEL, json = false, temperature = 0, timeoutMs = 90000, maxTokens, signal } = {}) {
  if (MODE !== 'REAL') throw new Error('chat() called in MOCK mode');
  const body = { model, messages, temperature };
  if (json) body.response_format = { type: 'json_object' };
  if (maxTokens) body.max_tokens = maxTokens;
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const r = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: sig });
  if (!r.ok) throw new Error(`xAI chat ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? '';
}

export function parseJSON(s) {
  const m = String(s).match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : s);
}

// Responses API with server-side x_search tool (docs.x.ai/developers/tools/x-search).
export async function responsesXSearch(input, tool = {}, { model = MODEL, timeoutMs = 120000 } = {}) {
  if (MODE !== 'REAL') throw new Error('responsesXSearch() called in MOCK mode');
  const body = { model, input, tools: [{ type: 'x_search', ...tool }] };
  const r = await fetch(`${BASE}/responses`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`xAI responses ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const text = (j.output || []).filter((o) => o.type === 'message')
    .flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('\n') || j.output_text || '';
  const citations = [...(j.citations || []), ...(j.output || []).flatMap((o) => (o.content || []).flatMap((c) => (c.annotations || []).map((a) => a.url)))].filter(Boolean);
  return { text, citations, usage: j.usage, raw: j };
}
