// HARD SAFETY GATE (code, not prompts). Every diff must pass checkDiff() before it is applied,
// and the post-apply tree check before it is deployed. Paths are relative to the app root.
export const ALLOWLIST = new Set(['public/app.js', 'public/index.html', 'public/styles.css', 'public/lib/notes.js']);
const FORBIDDEN_PATH = /(auth|user|role|perm|admin|session|token|secret|passw|db|database|data|sql|migrat|server\.js|test|package)/i;
// Substring match (catches camelCase like isAdmin, userRole, authToken) + word match for short/common terms.
const FORBIDDEN_CODE = /(auth|admin|role|permission|perm|privilege|user|whoami|passw|token|session|secret|cookie|credential|localStorage|sessionStorage|indexedDB|XMLHttpRequest|WebSocket|sendBeacon|<script|<iframe|https?:\/\/)|\b(db|database|sql|fetch|eval|Function|import\s*\(|can|grant)\b/i;
export const MAX_CHANGED_LINES = 30;

// File headers (---/+++) count only BEFORE the first @@ of a file section (top of the diff, or after "diff --git").
// Inside a hunk every line starting with + or - is content: `git apply --recount` (the shipper's flags) treats a
// "+++ b/x" line in a hunk as an added line, so the gate must too, or "+++ b/public/index.html <script>..." slips through.
export function parseDiff(diff) {
  const files = new Set(), added = [], removed = [], problems = [];
  let inHunk = false;
  for (const line of diff.split('\n')) {
    let m;
    if ((m = line.match(/^diff --git a\/(\S+) b\/(\S+)/))) { inHunk = false; files.add(m[1]); files.add(m[2]); }
    else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk) {
      if (line.startsWith('+')) added.push(line.slice(1));
      else if (line.startsWith('-')) removed.push(line.slice(1));
    }
    else if ((m = line.match(/^(?:---|\+\+\+) (?:[ab]\/)?(\S+)/))) { if (m[1] !== '/dev/null') files.add(m[1]); else problems.push('file creation/deletion not allowed'); }
    else if (/^(new|deleted) file mode|^rename (from|to)|^copy (from|to)|^(old|new) mode|^GIT binary patch|^Binary files/.test(line)) problems.push(`not allowed: ${line.slice(0, 60)}`);
    else if (line.startsWith('+') || line.startsWith('-')) problems.push(`changed line outside a hunk: ${line.slice(0, 60)}`);
  }
  return { files: [...files], added, removed, problems };
}

// Content checks shared by the pre-apply diff check and the post-apply check of what actually changed on disk.
export function checkLines(added, removed, { forbidLines = [] } = {}) {
  const reasons = [];
  for (const l of [...added, ...removed]) {
    const m = l.match(FORBIDDEN_CODE);
    if (m) reasons.push(`forbidden identifier "${m[0]}" in changed line: ${l.trim().slice(0, 80)}`);
  }
  const banned = new Set(forbidLines.map((l) => l.trim()).filter((l) => l.length >= 16));
  for (const l of added) if (banned.has(l.trim())) reasons.push(`Breaker test code copied into app source: ${l.trim().slice(0, 80)}`);
  const n = added.length + removed.length;
  if (n > MAX_CHANGED_LINES) reasons.push(`too many changed lines: ${n} > ${MAX_CHANGED_LINES}`);
  return { reasons, changedLines: n };
}

// opts.forbidLines: lines of Breaker test code. A patch that pastes them into app source is rejected (Patch Arena).
export function checkDiff(diff, { forbidLines = [] } = {}) {
  const reasons = [];
  if (!diff || !/^@@/m.test(diff)) reasons.push('no hunks in diff');
  const { files, added, removed, problems } = parseDiff(diff || '');
  reasons.push(...problems);
  if (files.length === 0) reasons.push('diff names no files');
  for (const f of files) {
    if (f.includes('..') || f.startsWith('/') || f.includes('\\')) reasons.push(`path traversal: ${f}`);
    else if (!ALLOWLIST.has(f)) reasons.push(`file not in allowlist: ${f}`);
    if (FORBIDDEN_PATH.test(f) && !ALLOWLIST.has(f)) reasons.push(`protected path: ${f}`);
  }
  const c = checkLines(added, removed, { forbidLines });
  reasons.push(...c.reasons);
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], files, changedLines: c.changedLines };
}

// Post-apply check that does not trust the proposed diff's text: `treeDiff` is `git diff --no-index` output of
// live vs staging for the changed files, i.e. the lines that really changed on disk.
export function checkTreeDiff(treeDiff, { forbidLines = [] } = {}) {
  const { added, removed } = parseDiff(treeDiff);
  const c = checkLines(added, removed, { forbidLines });
  return { ok: c.reasons.length === 0, reasons: [...new Set(c.reasons)], changedLines: c.changedLines };
}
