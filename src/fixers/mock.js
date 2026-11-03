// MOCK fixer: returns hand-written, known-correct canned diffs. Measures pipeline plumbing only, NOT model quality.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'canned');
export async function fix({ issue }) {
  const f = path.join(dir, `${issue.signature}.diff`);
  if (!fs.existsSync(f)) throw new Error(`MOCK fixer has no canned diff for "${issue.signature}"`);
  return { diff: fs.readFileSync(f, 'utf8'), source: 'MOCK canned diff' };
}
