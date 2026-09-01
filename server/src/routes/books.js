import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { pool } from '../db.js';
import requireAuth from '../middleware/requireAuth.js';
import { writeEpub, writeCover, readCoverAsDataUrl, deleteBookFiles, epubPath } from '../storage.js';

// fieldSize governs non-file fields (title, author, cover, ...) and defaults
// to just 1MB — too small for the `cover` field, a base64 data URL that can
// easily exceed that for a full-resolution EPUB cover image.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024, fieldSize: 15 * 1024 * 1024 },
});
const router = Router();

function toPublicBook(row, cover) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    addedAt: new Date(row.added_at).getTime(),
    language: row.language,
    translatedFrom: row.translated_from,
    cover,
  };
}

router.get('/books', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM books WHERE user_id = $1 ORDER BY added_at DESC',
    [req.userId]
  );
  const books = await Promise.all(rows.map(async (row) => {
    const cover = await readCoverAsDataUrl(row.cover_path);
    return toPublicBook(row, cover);
  }));
  res.json(books);
});

router.get('/books/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM books WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  const cover = await readCoverAsDataUrl(rows[0].cover_path);
  res.json(toPublicBook(rows[0], cover));
});

router.get('/books/:id/file', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT file_path FROM books WHERE id = $1 AND user_id = $2',
    [req.params.id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  res.type('application/epub+zip').sendFile(path.resolve(rows[0].file_path), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'file_missing' });
  });
});

// multipart/form-data: title, author, addedAt (epoch ms), epub (file),
// cover (optional data: URL, extracted client-side), skipDedupe (optional
// 'true' — used by translated copies, see saveTranslatedBook in storage.js),
// language / translatedFrom (optional, translated copies only).
router.post('/books', requireAuth, upload.single('epub'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'missing_epub' });
  const title = req.body.title || 'Untitled';
  const author = req.body.author || 'Unknown author';
  const addedAt = req.body.addedAt ? new Date(Number(req.body.addedAt)) : new Date();
  const skipDedupe = req.body.skipDedupe === 'true';
  const language = req.body.language || null;
  const translatedFrom = req.body.translatedFrom || null;

  if (!skipDedupe) {
    const { rows: existing } = await pool.query(
      'SELECT id FROM books WHERE user_id = $1 AND title = $2 AND author = $3',
      [req.userId, title, author]
    );
    if (existing.length > 0) return res.json({ id: existing[0].id });
  }

  const bookId = crypto.randomUUID();
  await writeEpub(req.userId, bookId, req.file.buffer);
  const coverFilePath = req.body.cover ? await writeCover(req.userId, bookId, req.body.cover) : null;

  await pool.query(
    `INSERT INTO books (id, user_id, title, author, added_at, language, translated_from, file_path, cover_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [bookId, req.userId, title, author, addedAt, language, translatedFrom, epubPath(req.userId, bookId), coverFilePath]
  );

  res.json({ id: bookId });
});

router.delete('/books/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM books WHERE id = $1 AND user_id = $2 RETURNING file_path, cover_path',
    [req.params.id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  await deleteBookFiles(rows[0].file_path, rows[0].cover_path);
  res.status(204).end();
});

export default router;
