// Loads ~/grokathon/.env without ever printing values.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const ENV_FILE = process.env.GROKATHON_ENV || path.join(os.homedir(), 'grokathon', '.env');
try {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
const k = process.env.XAI_API_KEY || '';
export const HAS_KEY = k.length > 10 && !/your-xai-key/i.test(k);
export const MODE = process.env.FORCE_MOCK === '1' || !HAS_KEY ? 'MOCK' : 'REAL';
export const MODEL = process.env.GROK_MODEL || 'grok-4.7';
export const FAST_MODEL = process.env.GROK_FAST_MODEL || 'grok-4.20-0309-non-reasoning'; // classify + repro + breaker: low latency
export const BREAKER_MODEL = process.env.BREAKER_MODEL || FAST_MODEL;
export const BREAKER_TIMEOUT_MS = Number(process.env.BREAKER_TIMEOUT_MS) || 45000;
export const BREAKER_MAX_TOKENS = Number(process.env.BREAKER_MAX_TOKENS) || 1500;
export const CANDIDATE_MODELS = (process.env.CANDIDATE_MODELS || 'grok-4.20-0309-non-reasoning,grok-4.7').split(',').map((s) => s.trim()).filter(Boolean);
export const X_HANDLE = process.env.APP_X_HANDLE || 'jotterapp';
// Honest labelling: a key pointed at a local XAI_BASE_URL is the scripted stub (scripts/stub-xai.js), not Grok.
export const XAI_STUB = MODE === 'REAL' && /^https?:\/\/(localhost|127\.|\[::1\])/.test(process.env.XAI_BASE_URL || '');
export const MODE_LABEL = MODE === 'MOCK' ? 'MOCK' : XAI_STUB ? 'REAL code path, LOCAL STUB endpoint' : 'REAL';
