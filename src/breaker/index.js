// Pluggable Breaker. Interface: async attack({issue, diff, files, round, prior}) -> {tests:[{name, kind:'unit'|'browser', code?|plan?}], source, ms}
// Select with BREAKER=mock|grok (default: grok when key present, else mock).
import { MODE, XAI_STUB } from '../env.js';
import * as mock from './mock.js';
import * as grok from './grok.js';
const B = { mock, grok };
export function getBreaker(name = process.env.BREAKER) {
  const n = name || (MODE === 'REAL' ? 'grok' : 'mock');
  if (!B[n]) throw new Error(`unknown breaker ${n}`);
  return { name: n, mode: n === 'mock' || MODE === 'MOCK' ? 'MOCK' : XAI_STUB ? 'LOCAL STUB' : 'REAL', attack: B[n].attack };
}
