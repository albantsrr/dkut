import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';

// Local disk layout (matches MIGRATION_PLAN.md): STORAGE_DIR/{userId}/books/{bookId}.epub
// and STORAGE_DIR/{userId}/covers/{bookId}.<ext>. Defaults to ./data for local
// dev; on the VPS this should point at a persisted volume.
const STORAGE_DIR = process.env.STORAGE_DIR ?? './data';

function userDir(userId) {
  return path.join(STORAGE_DIR, userId);
}

export function epubPath(userId, bookId) {
  return path.join(userDir(userId), 'books', `${bookId}.epub`);
}

function coverPath(userId, bookId, ext) {
  return path.join(userDir(userId), 'covers', `${bookId}.${ext}`);
}

export async function writeEpub(userId, bookId, buffer) {
  const p = epubPath(userId, bookId);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, buffer);
  return p;
}

// `dataUrl` is a `data:image/<ext>;base64,<data>` string, as produced by the
// epubjs-based cover extraction that already runs client-side (see
// src/utils/storage.js) — the backend never parses EPUBs itself.
export async function writeCover(userId, bookId, dataUrl) {
  const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl ?? '');
  if (!match) return null;
  const [, ext, base64] = match;
  const p = coverPath(userId, bookId, ext);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, Buffer.from(base64, 'base64'));
  return p;
}

export async function readCoverAsDataUrl(coverFilePath) {
  if (!coverFilePath) return null;
  try {
    const buffer = await readFile(coverFilePath);
    const ext = path.extname(coverFilePath).slice(1);
    return `data:image/${ext};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function deleteBookFiles(filePath, coverFilePath) {
  await Promise.all([
    unlink(filePath).catch(() => {}),
    coverFilePath ? unlink(coverFilePath).catch(() => {}) : Promise.resolve(),
  ]);
}
