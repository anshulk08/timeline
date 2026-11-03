import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNote, deleteNote, searchNotes, toCSV } from '../public/lib/notes.js';

test('search is case-insensitive', () => {
  const notes = addNote(addNote([], 'Buy Milk'), 'Call mom');
  assert.equal(searchNotes(notes, 'milk').length, 1);
  assert.equal(searchNotes(notes, 'MOM').length, 1);
});

test('add/delete/csv basics', () => {
  let notes = addNote([], '  hi ');
  assert.equal(notes[0].text, 'hi');
  assert.equal(addNote(notes, '   ').length, 1);
  assert.equal(toCSV(notes), 'text\nhi\n');
  notes = deleteNote(notes, notes[0].id);
  assert.equal(notes.length, 0);
});
