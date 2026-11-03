// Independent verification on Grok Bot's own cloud computer ("AutoMaintainer Verify" routine), fire-and-forget.
// POST GROKBOT_WEBHOOK_URL (Bearer GROKBOT_WEBHOOK_KEY) {job_id, repo_url, base_sha, workdir, test_cmd, callback_url,
// callback_token, setup_patch, fix_patch}. The routine truncates bodies around 4 KB: short fields first, skip > 3500 bytes.
import { git } from './core.js';

const MAX_BYTES = 3500;
export const grokbotVerifyOn = () => !!(process.env.GROKBOT_WEBHOOK_URL && process.env.GROKBOT_WEBHOOK_KEY);

export async function buildVerifyJob({ cfg, bug, base, sha, files }) {
  const v = cfg.grokbot_verify || {};
  const setup = (await git(cfg.repo, ['diff', '-U1', v.public_base_sha, v.seeded_sha, '--', ...bug.files])).out;
  const fix = (await git(cfg.repo, ['diff', '-U1', base, sha, '--', ...files])).out;
  return {
    job_id: `${bug.id}-${sha.slice(0, 8)}`,
    repo_url: v.repo_url,
    base_sha: v.public_base_sha,
    workdir: `/tmp/am-verify-${bug.id}`,
    test_cmd: bug.grokbot_check,
    callback_url: 'none (report result in chat)',
    callback_token: 'none',
    setup_patch: setup,
    fix_patch: fix,
  };
}

// Returns {status:'dispatched'|'error'|'skipped', runUuid, ms, bytes, reason}
export async function dispatchVerify(job) {
  const body = JSON.stringify(job);
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_BYTES) return { status: 'skipped', bytes, ms: 0, reason: `payload ${bytes} B > ${MAX_BYTES} B (Grok Bot truncates ~4 KB)` };
  if (!job.setup_patch || !job.fix_patch || !job.test_cmd) return { status: 'skipped', bytes, ms: 0, reason: 'missing setup_patch / fix_patch / test_cmd' };
  const t0 = Date.now();
  try {
    const r = await fetch(process.env.GROKBOT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.GROKBOT_WEBHOOK_KEY}` }, body, signal: AbortSignal.timeout(30000) });
    const txt = await r.text();
    let j = {}; try { j = JSON.parse(txt); } catch {}
    if (!r.ok || !j.success) return { status: 'error', bytes, ms: Date.now() - t0, http: r.status, reason: `HTTP ${r.status}: ${txt.slice(0, 160)}` };
    return { status: 'dispatched', bytes, ms: Date.now() - t0, http: r.status, runUuid: j.runUuid };
  } catch (e) { return { status: 'error', bytes, ms: Date.now() - t0, reason: e.message.slice(0, 160) }; }
}
