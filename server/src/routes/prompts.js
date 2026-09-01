import { Router } from 'express';
import { pool } from '../db.js';
import requireAuth from '../middleware/requireAuth.js';

const router = Router();

function toPublicPrompt(row) {
  return { id: row.id, title: row.title, text: row.content, type: row.type };
}

router.get('/prompts', requireAuth, async (req, res) => {
  const [{ rows: promptRows }, { rows: deletedRows }] = await Promise.all([
    pool.query('SELECT * FROM custom_prompts WHERE user_id = $1 ORDER BY created_at ASC', [req.userId]),
    pool.query('SELECT prompt_id FROM deleted_default_prompt_ids WHERE user_id = $1', [req.userId]),
  ]);
  res.json({
    prompts: promptRows.map(toPublicPrompt),
    deletedDefaultIds: deletedRows.map((r) => r.prompt_id),
  });
});

// Upserts one prompt by id — ids are always client-generated (default prompts
// use fixed ids, user-created ones use `custom-${Date.now()}`, see
// src/components/ChatPanel.jsx), never assigned here.
router.put('/prompts/:id', requireAuth, async (req, res) => {
  const { title, text, type } = req.body ?? {};
  await pool.query(
    `INSERT INTO custom_prompts (user_id, id, type, title, content)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, id) DO UPDATE
       SET type = EXCLUDED.type, title = EXCLUDED.title, content = EXCLUDED.content`,
    [req.userId, req.params.id, type, title, text]
  );
  res.status(204).end();
});

// ?markDeletedDefault=true additionally records the id in
// deleted_default_prompt_ids — the frontend (which alone knows which ids are
// defaults) sets this only when deleting one of its own DEFAULT_PROMPTS, so a
// later default-merge never resurrects a default the user deliberately removed.
router.delete('/prompts/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM custom_prompts WHERE user_id = $1 AND id = $2', [req.userId, req.params.id]);
  if (req.query.markDeletedDefault === 'true') {
    await pool.query(
      `INSERT INTO deleted_default_prompt_ids (user_id, prompt_id) VALUES ($1, $2)
       ON CONFLICT (user_id, prompt_id) DO NOTHING`,
      [req.userId, req.params.id]
    );
  }
  res.status(204).end();
});

export default router;
