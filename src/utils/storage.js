import Epub from 'epubjs';
import { apiGet, apiGetBuffer, apiPostForm, apiDelete } from '../lib/api.js';
import { cacheEpub, getCachedEpub, evictBook } from '../lib/bookCache.js';

// Extracts the cover image from an EPUB ArrayBuffer.
// Returns a base64 data URL or null. Always destroys the throwaway Epub instance.
// Hard-capped at 7 s: book.coverUrl() or fetch(coverUrl) can hang indefinitely on
// some EPUBs (blob URL race / missing resource), which would freeze getBook() and
// leave the Reader spinner on-screen forever.
// Exported (not just used internally by saveTranslatedBook) so
// ImportFromDriveModal.jsx can reuse the same extraction logic when
// re-uploading books read back from Drive, which never carry a pre-extracted
// cover the way a fresh upload from Library.jsx's extractMeta() does.
export async function extractCover(arrayBuffer) {
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

function buildBookForm({ title, author, cover, data, addedAt, skipDedupe, language, translatedFrom }) {
  const form = new FormData();
  form.set('title', title || 'Untitled');
  form.set('author', author || 'Unknown author');
  form.set('addedAt', String(addedAt ?? Date.now()));
  if (cover) form.set('cover', cover);
  if (skipDedupe) form.set('skipDedupe', 'true');
  if (language) form.set('language', language);
  if (translatedFrom) form.set('translatedFrom', translatedFrom);
  form.set('epub', new Blob([data], { type: 'application/epub+zip' }), 'book.epub');
  return form;
}

// Saves a book to the backend (see server/src/routes/books.js) and caches the
// EPUB bytes locally so the first open is instant. The backend itself skips
// the upload and returns the existing id if a book with the same title+author
// already exists for this user.
export async function saveBook({ title, author, cover, data, addedAt }) {
  const form = buildBookForm({ title, author, cover, data, addedAt });
  const { id } = await apiPostForm('/books', form);
  await cacheEpub(id, data);
  return id;
}

// Saves a translated copy of a book. Deliberately distinct from saveBook():
// saveBook() skips upload and returns the existing id on a title+author
// match, which would silently point a second translation run at the first
// run's file — a translated copy must always be a genuinely new book row.
export async function saveTranslatedBook({ title, author, data, sourceId, language, addedAt }) {
  const cover = await extractCover(data.slice(0));
  const form = buildBookForm({
    title, author, cover, data, addedAt,
    skipDedupe: true, language, translatedFrom: sourceId,
  });
  const { id } = await apiPostForm('/books', form);
  await cacheEpub(id, data);
  return id;
}

// Returns the full book object including data (ArrayBuffer). Metadata (and
// the cover, persisted server-side at upload time) is always fetched fresh;
// only the EPUB bytes are checked against the IndexedDB cache first.
export async function getBook(id) {
  const meta = await apiGet(`/books/${id}`);

  let data = await getCachedEpub(id);
  if (!data) {
    data = await apiGetBuffer(`/books/${id}/file`);
    await cacheEpub(id, data);
  }

  return { id, title: meta.title, author: meta.author, addedAt: meta.addedAt, cover: meta.cover, data };
}

// Returns all books (metadata + cover, no EPUB data) for the current user.
export async function getAllBooks() {
  return apiGet('/books');
}

export async function deleteBook(id) {
  await apiDelete(`/books/${id}`);
  await evictBook(id);
}
