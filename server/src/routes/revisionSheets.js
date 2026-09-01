import { Router } from 'express';
import { pool } from '../db.js';
import requireAuth from '../middleware/requireAuth.js';

const router = Router();

router.post('/revision-sheets', requireAuth, async (req, res) => {
  const { title, content } = req.body ?? {};
  const { rows } = await pool.query(
    'INSERT INTO revision_sheets (user_id, title, content) VALUES ($1, $2, $3) RETURNING id',
    [req.userId, title, content]
  );
  res.json({ id: rows[0].id });
});

export default router;
