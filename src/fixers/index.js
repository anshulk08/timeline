// Pluggable Fixer. Interface: async fix({issue, repro, files}) -> {diff, source}
//   issue: {text, summary, signature}; repro: {failures, consoleErrors}; files: {relPath: content} (allowlisted files only)
// Select with FIXER=mock|grok|cursor (default: grok when key present, else mock).
import { MODE } from '../env.js';
import * as mock from './mock.js';
import * as grok from './grok.js';
import * as cursor from './cursor.js';
const FIXERS = { mock, grok, cursor };
export function getFixer(name = process.env.FIXER) {
  const n = name || (MODE === 'REAL' ? 'grok' : 'mock');
  if (!FIXERS[n]) throw new Error(`unknown fixer ${n}`);
  return { name: n, fix: FIXERS[n].fix };
}
