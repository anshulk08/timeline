// Local demo/test source: posts arrive via POST /api/inject on the control server (or scripts/inject.js).
export function createInjectListener(onPost) {
  return {
    name: 'inject',
    start() {}, stop() {},
    inject({ text, author = 'judge', createdAt }) {
      return onPost({ text: String(text).slice(0, 500), author: String(author).replace(/^@/, '').slice(0, 40), createdAt: Number(createdAt) || Date.now(), source: 'inject' });
    },
  };
}
