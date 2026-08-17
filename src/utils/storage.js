import Epub from 'epubjs';
import { uploadFile, downloadFile, deleteFile } from '../lib/driveApi.js';
import { loadData, saveData, getLibraryFolderId } from '../lib/driveStorage.js';
import {
  cacheEpub, getCachedEpub,
  cacheCover, getCachedCover,
  evictBook,
} from '../lib/bookCache.js';

// Extracts the cover image from an EPUB ArrayBuffer.
// Returns a base64 data URL or null. Always destroys the throwaway Epub instance.
// Hard-capped at 7 s: book.coverUrl() or fetch(coverUrl) can hang indefinitely on
// some EPUBs (blob URL race / missing resource), which would freeze getBook() and
// leave the Reader spinner on-screen forever.
async function extractCover(arrayBuffer) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (val) => { if (!settled) { settled = true; resolve(val); } };
    // Safety net: if nothing resolves within 7 s, give up and return null.
    const timer = setTimeout(() => settle(null), 7000);

    const book = Epub(arrayBuffer.slice(0));
    book.ready.then(async () => {
      let cover = null;
      try {
        const coverUrl = await book.coverUrl();
        if (coverUrl && !settled) {
          const resp = await fetch(coverUrl);
          const blob = await resp.blob();
          if (!settled) {
            cover = await new Promise((res) => {
              const fr = new FileReader();
              fr.onloadend = () => res(fr.result);
              fr.readAsDataURL(blob);
            });
          }
        }
      } catch { /* no cover — leave null */ }
      clearTimeout(timer);
      book.destroy();
      settle(cover);
    }).catch(() => { clearTimeout(timer); book.destroy(); settle(null); });
  });
}

// Saves a book to Google Drive and updates bibliotheque-data.json.
// The `id` field from Library.jsx's processFiles is ignored — the Drive file ID
// becomes the canonical book ID.
export async function saveBook({ title, author, cover, data, addedAt }) {
  const folderId = await getLibraryFolderId();
  const normalTitle  = title  || 'Untitled';
  const normalAuthor = author || 'Unknown author';

  // Skip upload if a book with the same title+author already exists
  const driveData = await loadData();
  const existing = driveData.books.find(
    b => b.title === normalTitle && b.author === normalAuthor
  );
  if (existing) return existing.id;

  const safeName = normalTitle.replace(/[^\w\s-]/g, '').trim() || 'book';
  const filename  = `${safeName}-${Date.now()}.epub`;

  const blob      = new Blob([data], { type: 'application/epub+zip' });
  const driveFile = await uploadFile(folderId, filename, blob, 'application/epub+zip');
  const driveId   = driveFile.id;

  // Cache epub locally so the first open is instant (no re-download)
  await cacheEpub(driveId, data);

  // Cache cover: use the one extracted by Library if available, else extract fresh
  const resolvedCover = cover ?? await extractCover(data);
  if (resolvedCover) await cacheCover(driveId, resolvedCover);

  driveData.books.push({
    id: driveId,
    title: normalTitle,
    author: normalAuthor,
    addedAt: addedAt ?? Date.now(),
  });
  await saveData(driveData);

  return driveId;
}

// Saves a translated copy of a book to Drive. Deliberately distinct from
// saveBook(): saveBook() skips upload and returns the existing id when a
// title+author match is found, which would silently point a second
// translation run at the first run's file — a translated copy must always
// be a genuinely new artifact.
export async function saveTranslatedBook({ title, author, data, sourceId, language, addedAt }) {
  const folderId = await getLibraryFolderId();
  const normalTitle  = title  || 'Untitled';
  const normalAuthor = author || 'Unknown author';

  const safeName = normalTitle.replace(/[^\w\s-]/g, '').trim() || 'book';
  const filename  = `${safeName}-${Date.now()}.epub`;

  const blob      = new Blob([data], { type: 'application/epub+zip' });
  const driveFile = await uploadFile(folderId, filename, blob, 'application/epub+zip');
  const driveId   = driveFile.id;

  await cacheEpub(driveId, data);
  const cover = await extractCover(data.slice(0));
  if (cover) await cacheCover(driveId, cover);

  const driveData = await loadData();
  driveData.books.push({
    id: driveId,
    title: normalTitle,
    author: normalAuthor,
    addedAt: addedAt ?? Date.now(),
    language,
    translatedFrom: sourceId,
  });
  await saveData(driveData);

  return driveId;
}

// Returns the full book object including data (ArrayBuffer).
// Checks IndexedDB cache before downloading from Drive.
export async function getBook(id) {
  const driveData = await loadData();
  const meta = driveData.books.find((b) => b.id === id);
  if (!meta) return undefined;

  let data = await getCachedEpub(id);
  if (!data) {
    data = await downloadFile(id);
    await cacheEpub(id, data);
  }

  let cover = await getCachedCover(id);
  if (!cover) {
    cover = await extractCover(data.slice(0));
    if (cover) await cacheCover(id, cover);
  }

  return { id, title: meta.title, author: meta.author, addedAt: meta.addedAt, cover, data };
}

// Returns all books without the data (ArrayBuffer) field — only metadata + cached cover.
// Dedupes by Drive file id only — that's a book's one true identity. Two
// entries sharing title+author (e.g. a translated copy alongside its source,
// or a book re-imported from elsewhere with unchanged metadata) are
// legitimately distinct Drive files and must both stay visible; an earlier
// version of this function deduped by title+author instead and silently
// dropped (and persisted the removal of) whichever entry lost the tie —
// exactly the kind of pair a translation produces.
export async function getAllBooks() {
  const driveData = await loadData();

  const seen = new Map();
  for (const book of driveData.books) {
    const existing = seen.get(book.id);
    if (!existing || book.addedAt > existing.addedAt) seen.set(book.id, book);
  }
  const deduped = Array.from(seen.values());

  if (deduped.length !== driveData.books.length) {
    driveData.books = deduped;
    saveData(driveData).catch(() => {});
  }

  return Promise.all(
    deduped.map(async (meta) => ({
      ...meta,
      cover: await getCachedCover(meta.id),
    }))
  );
}

// Scans dkut/library/ on Drive and registers any EPUB not already in bibliotheque-data.json.
// Returns the number of newly registered books.
export async function syncLibrary() {
  const folderId = await getLibraryFolderId();
  const driveData = await loadData();
  const knownIds = new Set(driveData.books.map((b) => b.id));

  const files = await (await import('../lib/driveApi.js')).listFiles(
    folderId,
    `mimeType='application/epub+zip' or name contains '.epub'`
  );

  let added = 0;
  for (const file of files) {
    if (knownIds.has(file.id)) continue;

    let data;
    try { data = await downloadFile(file.id); } catch { continue; }

    await cacheEpub(file.id, data);

    let title = file.name.replace(/[-_]\d+\.epub$/i, '').replace(/\.epub$/i, '') || 'Untitled';
    let author = 'Unknown author';
    try {
      const meta = await new Promise((resolve) => {
        const book = Epub(data.slice(0));
        // Only load metadata — never call coverUrl() which triggers the rendering pipeline
        book.loaded.metadata.then((m) => {
          book.destroy();
          resolve({ title: m.title || title, author: m.creator || author });
        }).catch(() => { book.destroy(); resolve({ title, author }); });
      });
      title = meta.title;
      author = meta.author;
    } catch { /* keep filename-derived title */ }

    driveData.books.push({ id: file.id, title, author, addedAt: Date.now() });
    added++;
  }

  if (added > 0) await saveData(driveData);
  return added;
}

export async function deleteBook(id) {
  try {
    await deleteFile(id);
  } catch (err) {
    // Truly gone (404) or inaccessible (403) — still fine to drop it from our
    // own catalog below. Any other failure (expired token, network blip,
    // transient 5xx) must NOT be swallowed: silently proceeding would remove
    // the catalog entry while the file is still sitting in Drive, and the
    // next "Sync Drive" would resurrect it as if it were a brand-new book.
    if (!/\b40[34]\b/.test(err.message || '')) throw err;
  }
  await evictBook(id);

  const driveData = await loadData();
  driveData.books = driveData.books.filter((b) => b.id !== id);
  delete driveData.progress[id];
  await saveData(driveData);
}
