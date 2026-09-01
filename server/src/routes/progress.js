import { Router } from 'express';
import { pool } from '../db.js';
import requireAuth from '../middleware/requireAuth.js';

const router = Router();

router.get('/progress', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT book_id, cfi, pct FROM progress WHERE user_id = $1',
    [req.userId]
  );
  const out = {};
  for (const row of rows) out[row.book_id] = { cfi: row.cfi, pct: row.pct };
  res.json(out);
});

router.put('/progress/:bookId', requireAuth, async (req, res) => {
  const { cfi, pct } = req.body ?? {};
  await pool.query(
    `INSERT INTO progress (user_id, book_id, cfi, pct, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id, book_id) DO UPDATE
       SET cfi = EXCLUDED.cfi, pct = EXCLUDED.pct, updated_at = now()`,
    [req.userId, req.params.bookId, cfi ?? null, pct ?? 0]
  );
  res.status(204).end();
});

router.delete('/progress/:bookId', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM progress WHERE user_id = $1 AND book_id = $2', [req.userId, req.params.bookId]);
  res.status(204).end();
});

export default router;
