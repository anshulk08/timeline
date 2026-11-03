// One chat call + one x_search call; prints latency and shape only (never the key).
import { MODE, MODEL, FAST_MODEL } from '../src/env.js';
import { chat, responsesXSearch } from '../src/llm.js';
if (MODE !== 'REAL') { console.error('MOCK: no XAI_API_KEY in ~/grokathon/.env'); process.exit(2); }
let t = Date.now();
try { const c = await chat([{ role: 'user', content: 'Reply with the single word: pong' }], { model: FAST_MODEL }); console.log(`chat ${FAST_MODEL}: ${Date.now() - t} ms -> ${JSON.stringify(c.slice(0, 40))}`); } catch (e) { console.log(`chat FAILED: ${e.message}`); }
t = Date.now();
try { const r = await responsesXSearch('Find the 3 most recent X posts from @xai. One line each.', { allowed_x_handles: ['xai'] }, { model: MODEL }); console.log(`x_search ${MODEL}: ${Date.now() - t} ms, text ${r.text.length} chars, citations ${r.citations.length}, usage ${JSON.stringify(r.usage?.server_side_tool_usage_details || {})}`); console.log(r.text.slice(0, 400)); } catch (e) { console.log(`x_search FAILED: ${e.message}`); }
