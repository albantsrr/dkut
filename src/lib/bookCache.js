// Local IndexedDB cache for EPUB ArrayBuffers and cover base64 strings.
// Keys: epub-{driveId}, cover-{driveId}
// NOTE: IDB returns a structured-clone copy of the stored ArrayBuffer on each
// get(), so the cache entry is never consumed even if epubjs transfers the
// returned buffer. Callers must still .slice(0) before passing to epubjs.

const DB_NAME    = 'bibliotheque-cache';
const DB_VERSION = 1;
const STORE      = 'resources';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    tx.objectStore(STORE).get(key).onsuccess = (e) => resolve(e.target.result ?? null);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record).onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key).onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function cacheEpub(id, arrayBuffer) {
  await idbPut({ key: `epub-${id}`, data: arrayBuffer, cachedAt: Date.now() });
}

export async function getCachedEpub(id) {
  const record = await idbGet(`epub-${id}`);
  return record?.data ?? null;
}

export async function cacheCover(id, base64) {
  await idbPut({ key: `cover-${id}`, data: base64, cachedAt: Date.now() });
}

export async function getCachedCover(id) {
  const record = await idbGet(`cover-${id}`);
  return record?.data ?? null;
}

export async function evictBook(id) {
  await Promise.all([idbDel(`epub-${id}`), idbDel(`cover-${id}`)]);
}

export async function clearAllCache() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear().onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
