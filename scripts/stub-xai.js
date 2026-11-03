// LOCAL STUB of the xAI API, used ONLY to exercise the REAL code path (HTTP, JSON parsing, plan DSL, git apply --recount)
// without a key. Responses are scripted, so results from it say nothing about Grok's quality or latency.
import http from 'node:http';
import fs from 'node:fs';
import { CANNED_PLANS } from '../src/reproducer.js';
import { attack as mockAttack } from '../src/breaker/mock.js';
const canned = (s) => fs.readFileSync(new URL(`../src/fixers/canned/${s}.diff`, import.meta.url), 'utf8');
const sigOf = (t) => (/export/i.test(t) ? 'export' : /search|find/i.test(t) ? 'search' : 'add-note');
http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const j = JSON.parse(b || '{}');
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/responses')) {
      const q = (String(j.input).match(/"(cc[a-z0-9]+)"/) || [])[1];
      const posts = q ? [{ id: '1', url: 'https://x.com/stub/status/1', author: 'stub', text: `${q} testing`, created_at: new Date().toISOString() }] : [];
      return res.end(JSON.stringify({ output: [{ type: 'custom_tool_call', name: 'x_keyword_search' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ posts }), annotations: [] }] }], usage: { server_side_tool_usage_details: { x_search_calls: 1 } } }));
    }
    const sys = j.messages[0].content, user = j.messages.at(-1).content.split(/\n\n(Page HTML|Files):/)[0];
    let content;
    if (sys.startsWith('You triage')) content = JSON.stringify({ category: /admin|roles/i.test(user) ? 'attack' : 'bug', signature: sigOf(user), summary: 'stub', reason: 'stub' });
    else if (sys.startsWith('You write browser')) content = JSON.stringify({ plan: CANNED_PLANS[sigOf(user)] });
    else if (sys.startsWith('You are the Breaker')) { // scripted Breaker reply wrapped in a code fence, like a sloppy LLM
      const round = Number((user.match(/Arena round (\d+)/) || [])[1] || 1);
      return mockAttack({ issue: { signature: sigOf(user.split('\nTriage summary')[0]) }, round }).then(({ tests }) => res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify({ tests }) + '\n```' } }] })));
    }
    else if (/adversarial Breaker found tests/.test(j.messages.at(-1).content) && fs.existsSync(new URL(`../src/fixers/canned/${sigOf(user)}.retry.diff`, import.meta.url))) content = '```diff\n' + canned(`${sigOf(user)}.retry`) + '```';
    else content = '```diff\n' + canned(sigOf(user)).replace(/@@ -(\d+),\d+ \+(\d+),\d+ @@/g, '@@ -$1,99 +$2,99 @@') + '```'; // wrong hunk counts + fences, like a sloppy LLM
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}).listen(4999, () => console.log('stub xAI on :4999'));
