// Placeholder for a Cursor agent fixer (not wired: no Cursor CLI/API available in this environment).
// To plug in: implement fix() to hand {issue, repro, files} to a Cursor background agent and return {diff, source:'cursor'}.
// The diff still goes through gate.js + tests, so a Cursor-produced patch gets exactly the same enforcement.
export async function fix() { throw new Error('cursor fixer not configured (stub)'); }
