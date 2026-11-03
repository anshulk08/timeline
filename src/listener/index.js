// Listener interface: createListener(source, onPost) -> {start(), stop(), name}
// onPost receives {text, author, createdAt(ms), source, url?, externalId?}
import { createInjectListener } from './inject.js';
import { createXSearchListener } from './xsearch.js';
export function createListener(source, onPost, opts) {
  if (source === 'inject') return createInjectListener(onPost, opts);
  if (source === 'xsearch') return createXSearchListener(onPost, opts);
  throw new Error(`unknown listener source ${source}`);
}
