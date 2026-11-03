import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRISTINE = path.join(ROOT, 'app');
export const LIVE = path.join(ROOT, 'live');
export const STAGING = path.join(ROOT, '.staging');
export const RUNS = path.join(ROOT, 'runs');
export const APP_PORT = Number(process.env.APP_PORT) || 4000;
export const STAGING_PORT = Number(process.env.STAGING_PORT) || 4001;
export const CONTROL_PORT = Number(process.env.CONTROL_PORT) || 4100;
export const ARENA_REF = path.join(ROOT, '.arena-ref'); // live copy + hidden reference fix (referee only)
export const REFERENCE_FIXES = path.join(ROOT, 'arena', 'reference'); // never shown to the Fixer or the Breaker
export const ARENA_REF_PORT = Number(process.env.ARENA_REF_PORT) || STAGING_PORT + 50;
