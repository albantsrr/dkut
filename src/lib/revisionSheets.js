import { apiPostJson } from './api.js';

// Saves a revision sheet markdown document (see server/src/routes/revisionSheets.js).
// Returns the new row's id — currently unused by callers (ChatPanel.jsx only
// cares whether the save succeeded), kept for parity with saveBook()/etc.
export async function saveNotesheet(title, markdownContent) {
  const { id } = await apiPostJson('/revision-sheets', { title, content: markdownContent });
  return id;
}
