export function addNote(notes, text) {
  const t = String(text || '').trim();
  if (!t) return notes;
  return [...notes, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: t }];
}

export function deleteNote(notes, id) {
  return notes.filter((n) => n.id !== id);
}

export function searchNotes(notes, query) {
  if (!query) return notes;
  return notes.filter((n) => n.text.includes(query));
}

export function toMarkdown(notes) {
  return ['# My notes', ...notes.map((n) => `- ${n.text}`)].join('\n') + '\n';
}
