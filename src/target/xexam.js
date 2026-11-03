// Cross-Examination client (simpliGrok RAG/cross_examination): POST /api/examinations, poll until terminal.
// Maps the real exam shape (claims[].assessment.classification, qa.classification, call{company,ticker,quarter}) defensively.
// Never fabricates verdicts: backend down / timeout -> status 'unavailable' with the error.
const DONE = new Set(['completed', 'partial', 'failed']);
export const xexamUrl = () => (process.env.XEXAM_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
export const xexamWeb = () => (process.env.XEXAM_WEB || 'http://localhost:3000').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 160)}`);
  return JSON.parse(t);
}

export function mapExam(ex) {
  const claims = (Array.isArray(ex?.claims) ? ex.claims : []).map((c) => {
    const a = c?.assessment || {};
    const v = a.verification;
    const withheld = /withheld|fail/i.test(String(typeof v === 'object' && v ? v.status : v || ''));
    return { text: String(c?.text || ''), verdict: String(withheld ? 'WITHHELD' : (a.classification || 'UNKNOWN')).toUpperCase() };
  });
  const qa = ex?.qa;
  const call = ex?.call ? { company: ex.call.company || null, ticker: ex.call.ticker || null, quarter: ex.call.quarter || null } : null;
  return { claims, dodge: qa && qa.classification ? { verdict: String(qa.classification).toUpperCase() } : undefined, call, error: ex?.error || null };
}

export async function crossExamine(post, { intervalMs = 2000, timeoutMs = 120000, onStarted } = {}) {
  const t0 = Date.now();
  const base = xexamUrl();
  const reqBody = post.source === 'x' && post.url ? { x_url: post.url } : { text: post.text };
  let examId = null;
  try {
    const start = await j(`${base}/api/examinations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqBody) });
    examId = start.id;
    if (!examId) throw new Error('backend returned no exam id');
    onStarted && onStarted(examId);
    let ex = start;
    while (!DONE.has(ex.status)) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs / 1000}s (last status ${ex.status})`);
      await sleep(intervalMs);
      ex = await j(`${base}/api/examinations/${encodeURIComponent(examId)}`);
    }
    // POST answers {id,status} only; a cached exam is already terminal, so always fetch the full body
    if (!Array.isArray(ex.claims)) ex = await j(`${base}/api/examinations/${encodeURIComponent(examId)}`);
    return { examId, status: ex.status, ms: Date.now() - t0, ...mapExam(ex), receiptUrl: `${xexamWeb()}/receipt/${examId}` };
  } catch (e) {
    return { examId, status: 'unavailable', ms: Date.now() - t0, claims: [], error: `${e.cause?.code || ''} ${e.message}`.trim(), receiptUrl: examId ? `${xexamWeb()}/receipt/${examId}` : null };
  }
}

export function claimReply(author, r) {
  if (r.status === 'unavailable') return `@${author} We could not check that claim right now (cross-examination unavailable).`;
  const c = r.call ? [r.call.ticker || r.call.company, r.call.quarter].filter(Boolean).join(' ') + ' earnings call' : 'earnings call';
  const counts = {};
  for (const x of r.claims) counts[x.verdict.toLowerCase().replace(/_/g, ' ')] = (counts[x.verdict.toLowerCase().replace(/_/g, ' ')] || 0) + 1;
  const verdicts = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'no verdicts';
  return `@${author} Checked against the ${c} transcript: ${r.claims.length} claim${r.claims.length === 1 ? '' : 's'} — ${verdicts}. Receipt: ${r.receiptUrl}`;
}
