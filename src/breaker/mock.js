// MOCK Breaker: hand-written adversarial tests per bug signature and round. Demonstrates the arena plumbing and the
// referee, NOT Grok's ability to find holes. Round 1 for export includes one deliberately INVALID attack
// (it asserts a quoting style the spec does not require) so the referee has something to reject.
const T = {
  export: {
    1: [
      { name: 'a note containing a comma stays one CSV field', kind: 'unit',
        code: "const out = lib.toCSV([{ id: '1', text: 'eggs, milk' }]);\nassert.equal(out, 'text\\n\"eggs, milk\"\\n');" },
      { name: 'exporting zero notes gives just the header row', kind: 'unit',
        code: "assert.equal(lib.toCSV([]), 'text\\n');" },
      { name: 'every field is wrapped in double quotes', kind: 'unit',
        code: "assert.equal(lib.toCSV([{ id: '1', text: 'alpha' }]), 'text\\n\"alpha\"\\n');" },
    ],
    2: [
      { name: 'quotes are doubled and a line break stays inside one field', kind: 'unit',
        code: "const out = lib.toCSV([{ id: '1', text: 'say \"hi\"\\nbye' }]);\nassert.equal(out, 'text\\n\"say \"\"hi\"\"\\nbye\"\\n');" },
    ],
  },
  'add-note': {
    1: [
      { name: 'two notes added back to back both stay on the page', kind: 'browser',
        plan: [{ op: 'goto', path: '/' }, { op: 'fill', selector: '#note-input', value: 'first' }, { op: 'click', selector: '#add-btn' }, { op: 'wait', ms: 300 },
          { op: 'fill', selector: '#note-input', value: 'second' }, { op: 'click', selector: '#add-btn' }, { op: 'wait', ms: 300 }, { op: 'expectCount', selector: '#list li', count: 2 }] },
    ],
  },
  search: {
    1: [
      { name: 'mixed-case query matches mixed-case note', kind: 'unit',
        code: "const n = [{ id: '1', text: 'buy MILK' }, { id: '2', text: 'call mom' }];\nassert.equal(lib.searchNotes(n, 'Milk').length, 1);" },
      { name: 'empty query still returns every note', kind: 'unit',
        code: "const n = [{ id: '1', text: 'a' }, { id: '2', text: 'b' }];\nassert.equal(lib.searchNotes(n, '').length, 2);" },
    ],
  },
};
export const name = 'mock';
export async function attack({ issue, round }) {
  const tests = T[issue.signature]?.[round] || [];
  return { tests: structuredClone(tests), source: 'MOCK canned Breaker tests', ms: 0 };
}
