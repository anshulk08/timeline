// Orchestrator: Listener -> Gatekeeper -> Reproducer -> Fixer -> Diff gate + tests -> Shipper -> reply draft.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { MODE } from './env.js';
import { classify } from './gatekeeper.js';
import { makePlan, runPlan } from './reproducer.js';
import { getFixer } from './fixers/index.js';
import { gateAndTest, deploy, readAllowlisted, startLive, stopLive } from './shipper.js';
import { runAppTests } from './tests.js';
import { LIVE, APP_PORT, STAGING_PORT, RUNS, CONTROL_PORT } from './paths.js';
import { reset as resetApp } from '../scripts/reset.js';

let seq = 0;
export class Pipeline extends EventEmitter {
  constructor({ fixer } = {}) {
    super();
    this.fixer = fixer && typeof fixer === 'object' ? fixer : getFixer(fixer);
    this.mode = MODE;
    this.records = [];
    this.issues = new Map();
    this.queue = Promise.resolve();
    fs.mkdirSync(RUNS, { recursive: true });
  }

  log(rec, stage, msg) {
    const e = { t: Date.now(), postId: rec?.id, stage, msg };
    fs.appendFileSync(path.join(RUNS, 'actions.jsonl'), JSON.stringify(e) + '\n');
    this.emit('log', e);
  }
  update(rec) { this.emit('update', rec); }

  async init({ reset = false } = {}) {
    await stopLive();
    if (reset) { resetApp(); this.issues.clear(); this.records = []; }
    if (!(await startLive())) throw new Error('live app failed to start');
    this.baseline = await runAppTests(LIVE, STAGING_PORT);
    this.log(null, 'boot', `${this.mode} mode, fixer=${this.fixer.name}. live app on :${APP_PORT}. baseline tests: ${this.baseline.pass.length} pass / ${this.baseline.fail.length} fail [${this.baseline.fail.join(', ')}]`);
    this.emit('reset');
  }

  async timed(rec, name, fn) {
    const t0 = Date.now();
    rec.stages[name] = { status: 'running', start: t0 };
    this.update(rec);
    try {
      const out = await fn();
      rec.stages[name] = { ...rec.stages[name], status: out?.__status || 'ok', ms: Date.now() - t0 };
      return out;
    } catch (e) {
      rec.stages[name] = { ...rec.stages[name], status: 'error', ms: Date.now() - t0, error: e.message };
      this.log(rec, name, `error: ${e.message}`);
      throw e;
    } finally { this.update(rec); }
  }

  // post: {text, author, createdAt(ms), source, url?, externalId?}
  async handlePost(post) {
    const receivedAt = Date.now();
    const rec = { id: `p${++seq}`, post, mode: this.mode, receivedAt, stages: {}, status: 'received' };
    rec.stages.detect = { status: 'ok', ms: Math.max(0, receivedAt - (post.createdAt || receivedAt)), note: post.source === 'inject' ? 'inject (no X latency)' : 'X search' };
    this.records.push(rec);
    this.log(rec, 'detect', `[${post.source}] @${post.author}: ${post.text}`);
    this.update(rec);
    try {
      const open = [...this.issues.values()];
      const v = await this.timed(rec, 'classify', () => classify(post, open));
      rec.verdict = v;
      this.log(rec, 'classify', `${v.category.toUpperCase()} (${v.mode})${v.signature ? ` sig=${v.signature}` : ''}: ${v.reason || ''}`);
      if (v.category === 'attack') {
        rec.status = 'refused';
        rec.reply = `@${post.author} Not doing that. Requests that touch accounts, permissions, data or our safety checks are refused automatically.`;
        this.log(rec, 'refuse', 'REFUSED by gatekeeper; nothing reproduced, patched or deployed');
        return this.finish(rec);
      }
      if (v.category !== 'bug') {
        rec.status = v.category === 'feature' ? 'logged-feature' : 'ignored';
        return this.finish(rec);
      }
      const existing = this.issues.get(v.signature);
      if (existing && existing.status !== 'not-reproduced' && existing.status !== 'failed') {
        rec.status = 'duplicate'; rec.duplicateOf = existing.firstPostId;
        rec.reply = existing.sha ? `@${post.author} Already fixed: ${existing.link}` : `@${post.author} Thanks, already on it (same as ${existing.firstPostId}).`;
        this.log(rec, 'classify', `duplicate of ${existing.firstPostId} (sig=${v.signature})`);
        return this.finish(rec);
      }
      const issue = { signature: v.signature, summary: v.summary, text: post.text, firstPostId: rec.id, status: 'queued' };
      this.issues.set(v.signature, issue);
      rec.status = 'queued'; this.update(rec);
      const job = this.queue.then(() => this.fixJob(rec, issue));
      this.queue = job.catch(() => {});
      return job;
    } catch (e) {
      rec.status = 'error'; rec.error = e.message;
      return this.finish(rec);
    }
  }

  async fixJob(rec, issue) {
    try {
      issue.status = 'in-progress'; rec.status = 'reproducing';
      const liveUrl = `http://127.0.0.1:${APP_PORT}`;
      const shot = path.join(RUNS, `${rec.id}-repro.png`);
      const { plan, repro } = await this.timed(rec, 'reproduce', async () => {
        const p = await makePlan(issue, liveUrl);
        if (!p.plan) return { plan: null, repro: { reproduced: false, failures: ['no plan'] } };
        const r = await runPlan(p.plan, liveUrl, shot);
        return { plan: p.plan, planSource: p.source, repro: r };
      });
      rec.plan = plan; rec.repro = repro; rec.screenshot = repro.screenshot ? `/runs/${path.basename(shot)}` : null;
      this.log(rec, 'reproduce', repro.reproduced ? `REPRODUCED (Playwright stand-in for Grok Bot): ${repro.failures.join('; ')}${repro.consoleErrors?.length ? ` | console: ${repro.consoleErrors[0]}` : ''}` : `NOT reproduced: ${repro.failures.join('; ') || 'all expectations held'} -> stop`);
      if (!repro.reproduced) { issue.status = rec.status = 'not-reproduced'; rec.reply = `@${rec.post.author} Thanks! We couldn't reproduce that. Mind sharing steps?`; return this.finish(rec); }

      rec.status = 'fixing';
      let fix, gt, previousError;
      for (let attempt = 1; attempt <= (this.fixer.name === 'mock' ? 1 : 2); attempt++) {
        fix = await this.timed(rec, 'fix', () => this.fixer.fix({ issue, repro, files: readAllowlisted(), previousError }));
        rec.diff = fix.diff;
        this.log(rec, 'fix', `patch from ${fix.source} (attempt ${attempt}, ${fix.diff.split('\n').length} lines)`);
        rec.status = 'testing';
        gt = await this.timed(rec, 'gate_test', () => gateAndTest(fix.diff, { baseline: this.baseline, plan, log: (s, m) => this.log(rec, s, m) }));
        if (gt.ok || gt.stage !== 'apply') break;
        previousError = gt.reasons.join('; ');
      }
      rec.gate = { ok: gt.ok, stage: gt.stage, reasons: gt.reasons };
      if (!gt.ok) {
        issue.status = rec.status = gt.stage === 'gate' || gt.stage === 'tree' ? 'blocked' : 'failed';
        rec.stages.gate_test.status = 'fail';
        this.log(rec, 'ship', `NOT deployed: ${gt.reasons.join('; ')}`);
        return this.finish(rec);
      }
      rec.status = 'deploying';
      const d = await this.timed(rec, 'deploy', () => deploy(gt.changed, { plan, message: `fix(${issue.signature}): ${issue.summary}\n\nReported on X by @${rec.post.author}: ${rec.post.text}`, log: (s, m) => this.log(rec, s, m) }));
      if (!d.ok) { issue.status = rec.status = 'rolled-back'; rec.stages.deploy.status = 'fail'; return this.finish(rec); }
      this.baseline = gt.tests;
      issue.status = 'fixed'; issue.sha = d.sha; issue.link = `http://localhost:${CONTROL_PORT}/changes/${d.sha}`;
      rec.sha = d.sha; rec.status = 'shipped';
      const total = ((Date.now() - (rec.post.createdAt || rec.receivedAt)) / 1000).toFixed(1);
      rec.reply = `@${rec.post.author} Reproduced and fixed in ${total}s. Change ${d.sha}: ${issue.link}`;
      return this.finish(rec);
    } catch (e) {
      issue.status = 'failed'; rec.status = 'error'; rec.error = e.message;
      return this.finish(rec);
    }
  }

  finish(rec) {
    rec.doneAt = Date.now();
    rec.totalMs = rec.doneAt - (rec.post.createdAt || rec.receivedAt);
    if (rec.reply) { rec.stages.reply = { status: 'draft', ms: 0 }; this.log(rec, 'reply', `DRAFT (not posted): ${rec.reply}`); }
    this.log(rec, 'done', `${rec.status} in ${(rec.totalMs / 1000).toFixed(2)}s`);
    this.update(rec);
    fs.appendFileSync(path.join(RUNS, 'records.jsonl'), JSON.stringify({ ...rec, diff: undefined }) + '\n');
    return rec;
  }
}
