// Reproducer: LOCAL PLAYWRIGHT STAND-IN for Grok Bot's cloud browser (see GROKBOT.md).
// A repro plan is a tiny step DSL; REAL mode asks Grok to write the plan from the complaint + page HTML,
// MOCK mode uses canned plans per bug signature. Expectations failing => bug reproduced.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { MODE, FAST_MODEL } from './env.js';
import { chat, parseJSON } from './llm.js';

let browserP;
export const getBrowser = () => (browserP ||= chromium.launch());
export async function closeBrowser() { if (browserP) { const b = await browserP; browserP = null; await b.close(); } }

export const CANNED_PLANS = {
  export: [{ op: 'goto', path: '/?seed=alpha,beta' }, { op: 'expectDownload', selector: '#export-btn' }],
  'add-note': [{ op: 'goto', path: '/' }, { op: 'fill', selector: '#note-input', value: 'hello from repro' }, { op: 'click', selector: '#add-btn' },
    { op: 'wait', ms: 400 }, { op: 'expectCount', selector: '#list li', count: 1 }],
  search: [{ op: 'goto', path: '/?seed=Buy Milk,Call mom' }, { op: 'fill', selector: '#search', value: 'milk' }, { op: 'expectCount', selector: '#list li', count: 1 }],
};

export async function makePlan(issue, baseUrl) {
  if (MODE !== 'REAL') {
    const plan = CANNED_PLANS[issue.signature];
    return { plan, source: plan ? 'MOCK canned plan' : 'MOCK (no canned plan)' };
  }
  const html = await (await fetch(baseUrl + '/')).text();
  const sys = `You write browser reproduction plans for bug reports against a web app. Return ONLY JSON {"plan":[steps]}.
Steps (use CSS selectors from the HTML): {"op":"goto","path":"/"} | {"op":"fill","selector","value"} | {"op":"click","selector"} | {"op":"press","selector","key"} | {"op":"wait","ms"} |
{"op":"expectCount","selector","count"} (expect N matching elements) | {"op":"expectText","selector","text"} (element contains text) | {"op":"expectDownload","selector"} (clicking selector should start a download).
Expectations describe CORRECT behaviour; the bug is reproduced if an expectation fails. The app accepts "/?seed=a,b" to preload notes "a" and "b". Max 8 steps.`;
  const out = parseJSON(await chat([{ role: 'system', content: sys }, { role: 'user', content: `Bug report: ${issue.text}\nTriage summary: ${issue.summary}\n\nPage HTML:\n${html}` }], { json: true, model: FAST_MODEL }));
  return { plan: out.plan, source: 'REAL grok-generated plan' };
}

// Executes plan against baseUrl. Returns {reproduced, failures, screenshot, consoleErrors, ms}.
export async function runPlan(plan, baseUrl, shotPath) {
  const t0 = Date.now();
  const browser = await getBrowser();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 900, height: 640 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  const failures = [];
  try {
    for (const s of plan) {
      if (s.op === 'goto') await page.goto(baseUrl + (s.path || '/'));
      else if (s.op === 'fill') await page.fill(s.selector, String(s.value ?? ''), { timeout: 2000 });
      else if (s.op === 'click') await page.click(s.selector, { timeout: 2000 });
      else if (s.op === 'press') await page.press(s.selector, s.key, { timeout: 2000 });
      else if (s.op === 'wait') { await page.waitForTimeout(Math.min(s.ms || 200, 2000)); await page.waitForLoadState('load'); }
      else if (s.op === 'expectCount') { const n = await page.locator(s.selector).count(); if (n !== s.count) failures.push(`expected ${s.count} x ${s.selector}, saw ${n}`); }
      else if (s.op === 'expectText') { const t = (await page.locator(s.selector).first().textContent({ timeout: 2000 }).catch(() => '')) || ''; if (!t.includes(s.text)) failures.push(`expected "${s.text}" in ${s.selector}, saw "${t.slice(0, 60)}"`); }
      else if (s.op === 'expectDownload') {
        const got = await Promise.all([page.waitForEvent('download', { timeout: 1500 }).then(() => true, () => false), page.click(s.selector, { timeout: 2000 })]).then((r) => r[0]);
        if (!got) failures.push(`clicking ${s.selector} started no download`);
      } else failures.push(`unknown op ${s.op}`);
    }
  } catch (e) { failures.push(`step error: ${e.message.split('\n')[0]}`); }
  if (shotPath) { fs.mkdirSync(path.dirname(shotPath), { recursive: true }); await page.screenshot({ path: shotPath }).catch(() => {}); }
  await ctx.close();
  return { reproduced: failures.length > 0, failures, consoleErrors, screenshot: shotPath, ms: Date.now() - t0 };
}
