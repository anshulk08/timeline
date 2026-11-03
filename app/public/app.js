import { addNote, deleteNote, searchNotes, toCSV } from './lib/notes.js';

const $ = (id) => document.getElementById(id);
const seed = new URLSearchParams(location.search).get('seed');
let notes = seed ? seed.split(',').reduce(addNote, []) : [];
let query = '';

function render() {
  const list = $('list');
  list.innerHTML = '';
  for (const n of searchNotes(notes, query)) {
    const li = document.createElement('li');
    li.className = 'note';
    const span = document.createElement('span');
    span.textContent = n.text;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete note');
    del.addEventListener('click', () => { notes = deleteNote(notes, n.id); render(); });
    li.append(span, del);
    list.append(li);
  }
  $('count').textContent = `${notes.length} note${notes.length === 1 ? '' : 's'}`;
}

$('add-form').addEventListener('submit', (e) => {
  notes = addNote(notes, $('note-input').value);
  $('note-input').value = '';
  render();
});

$('search').addEventListener('input', (e) => { query = e.target.value; render(); });

function exportNotes() {
  const blob = new Blob(toCSV(notes), { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'notes.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('export-btn').addEventListener('click', exportNotes);
render();
