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
async function extractCover(arrayBuffer) {
  return new Promise((resolve) => {
    const book = Epub(arrayBuffer.slice(0));
    book.ready.then(async () => {
      let cover = null;
      try {
        const coverUrl = await book.coverUrl();
        if (coverUrl) {
          const resp = await fetch(coverUrl);
          const blob = await resp.blob();
          cover = await new Promise((res) => {
            const fr = new FileReader();
            fr.onloadend = () => res(fr.result);
            fr.readAsDataURL(blob);
          });
        }
      } catch { /* no cover — leave null */ }
      book.destroy();
      resolve(cover);
    }).catch(() => { book.destroy(); resolve(null); });
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
export async function getAllBooks() {
  const driveData = await loadData();
  return Promise.all(
    driveData.books.map(async (meta) => ({
      ...meta,
      cover: await getCachedCover(meta.id),
    }))
  );
}

export async function deleteBook(id) {
  await deleteFile(id);
  await evictBook(id);

  const driveData = await loadData();
  driveData.books = driveData.books.filter((b) => b.id !== id);
  delete driveData.progress[id];
  await saveData(driveData);
}
