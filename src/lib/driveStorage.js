import {
  searchFiles, createFolder, listFiles,
  uploadFile, downloadJsonFile, updateJsonFile,
} from './driveApi.js';

const ROOT_NAME     = 'dkut';
const DATA_FILENAME = 'bibliotheque-data.json';
const FOLDER_MIME   = 'application/vnd.google-apps.folder';

// Session-level cache — avoids redundant Drive API calls
let _rootId       = null;
let _libraryId    = null;
let _notesheetId  = null;
let _dataFileId   = null;

const emptyData = () => ({ books: [], progress: {}, customPrompts: [] });

async function ensureRoot() {
  if (_rootId) return _rootId;
  const results = await searchFiles(
    `name='${ROOT_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`
  );
  if (results.length > 0) {
    _rootId = results[0].id;
  } else {
    const folder = await createFolder(ROOT_NAME);
    _rootId = folder.id;
  }
  return _rootId;
}

async function ensureSubfolder(name, parentId) {
  const files = await listFiles(parentId, `name='${name}' and mimeType='${FOLDER_MIME}'`);
  if (files.length > 0) return files[0].id;
  const folder = await createFolder(name, parentId);
  return folder.id;
}

async function ensureLibraryFolder() {
  if (_libraryId) return _libraryId;
  const rootId = await ensureRoot();
  _libraryId = await ensureSubfolder('library', rootId);
  return _libraryId;
}

async function ensureNotesheetFolder() {
  if (_notesheetId) return _notesheetId;
  const rootId = await ensureRoot();
  _notesheetId = await ensureSubfolder('revision-sheet', rootId);
  return _notesheetId;
}

async function findOrCreateDataFile(folderId) {
  if (_dataFileId) return _dataFileId;
  const files = await listFiles(folderId, `name='${DATA_FILENAME}'`);
  if (files.length > 0) {
    _dataFileId = files[0].id;
  } else {
    const blob = new Blob([JSON.stringify(emptyData())], { type: 'application/json' });
    const file = await uploadFile(folderId, DATA_FILENAME, blob, 'application/json');
    _dataFileId = file.id;
  }
  return _dataFileId;
}

export async function loadData() {
  const rootId = await ensureRoot();
  const fileId = await findOrCreateDataFile(rootId);
  return downloadJsonFile(fileId);
}

export async function saveData(data) {
  const rootId = await ensureRoot();
  const fileId = await findOrCreateDataFile(rootId);
  await updateJsonFile(fileId, data);
}

// Returns the library subfolder ID — used by storage.js for EPUB uploads
export async function getLibraryFolderId() {
  return ensureLibraryFolder();
}

// Saves a revision sheet markdown file to dkut/notesheet/
export async function saveNotesheet(title, markdownContent) {
  const folderId = await ensureNotesheetFolder();
  const safeName = title.replace(/[^\w\s\-–]/g, '').trim() || 'revision-sheet';
  const filename = `${safeName}.md`;
  const blob = new Blob([markdownContent], { type: 'text/plain' });
  const file = await uploadFile(folderId, filename, blob, 'text/plain');
  return file.id;
}

// Call on sign-out to reset the session cache
export function resetDriveStorage() {
  _rootId      = null;
  _libraryId   = null;
  _notesheetId = null;
  _dataFileId  = null;
}
