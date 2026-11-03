import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const URL = process.env.APP_URL || 'http://localhost:4000';
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

test('adding a note keeps it on the page', async () => {
  const page = await browser.newPage();
  await page.goto(URL);
  await page.fill('#note-input', 'hello world');
  await page.click('#add-btn');
  await page.waitForTimeout(400);
  await page.waitForLoadState('load');
  assert.equal(await page.locator('#list li').count(), 1);
  assert.equal(await page.locator('#count').textContent(), '1 note');
  await page.close();
});

test('export button downloads notes as CSV', async () => {
  const page = await browser.newPage();
  await page.goto(URL + '/?seed=alpha,beta');
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 2000 }),
    page.click('#export-btn'),
  ]);
  const path = await dl.path();
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(path, 'utf8');
  assert.equal(text, 'text\nalpha\nbeta\n');
  await page.close();
});
