import { Router } from 'express';
import { pool } from '../db.js';
import requireAuth from '../middleware/requireAuth.js';

const router = Router();

function toEntry(row) {
  if (!row) return null;
  return {
    questions: row.questions_json,
    generatedAt: row.generated_at,
    bestScore: row.best_score,
    total: row.total,
    attempts: row.attempts,
    completed: row.completed,
    lastAttemptAt: row.last_attempt_at,
    chapterLabel: row.chapter_label,
  };
}

// :chapterHref is a full section href (may itself contain slashes), so the
// frontend encodeURIComponent()s it into a single path segment (see
// src/lib/quizProgress.js) — Express decodes it back into req.params as usual.
router.get('/books/:bookId/quiz', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM quiz_progress WHERE user_id = $1 AND book_id = $2',
    [req.userId, req.params.bookId]
  );
  const out = {};
  for (const row of rows) {
    out[row.chapter_href] ??= {};
    out[row.chapter_href][row.mode] = toEntry(row);
  }
  res.json(out);
});

router.get('/books/:bookId/quiz/:chapterHref/:mode', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM quiz_progress WHERE user_id = $1 AND book_id = $2 AND chapter_href = $3 AND mode = $4',
    [req.userId, req.params.bookId, req.params.chapterHref, req.params.mode]
  );
  res.json(toEntry(rows[0]));
});

// Only ever called right after a fresh Gemini generation — always resets
// stats to zero rather than carrying forward a previous question set's score.
router.put('/books/:bookId/quiz/:chapterHref/:mode', requireAuth, async (req, res) => {
  const { questions, chapterLabel } = req.body ?? {};
  await pool.query(
    `INSERT INTO quiz_progress (user_id, book_id, chapter_href, mode, questions_json, generated_at, best_score, total, attempts, completed, last_attempt_at, chapter_label)
     VALUES ($1, $2, $3, $4, $5, now(), 0, $6, 0, false, NULL, $7)
     ON CONFLICT (user_id, book_id, chapter_href, mode) DO UPDATE
       SET questions_json = EXCLUDED.questions_json, generated_at = now(),
           best_score = 0, total = EXCLUDED.total, attempts = 0, completed = false, last_attempt_at = NULL,
           chapter_label = EXCLUDED.chapter_label`,
    [req.userId, req.params.bookId, req.params.chapterHref, req.params.mode, JSON.stringify(questions), questions.length, chapterLabel ?? null]
  );
  res.status(204).end();
});

// Called when a playthrough reaches the summary screen.
router.post('/books/:bookId/quiz/:chapterHref/:mode/attempt', requireAuth, async (req, res) => {
  const { score, total } = req.body ?? {};
  await pool.query(
    `UPDATE quiz_progress
       SET best_score = GREATEST(best_score, $5), total = $6, attempts = attempts + 1,
           completed = true, last_attempt_at = now()
     WHERE user_id = $1 AND book_id = $2 AND chapter_href = $3 AND mode = $4`,
    [req.userId, req.params.bookId, req.params.chapterHref, req.params.mode, score, total]
  );
  res.status(204).end();
});

export default router;
