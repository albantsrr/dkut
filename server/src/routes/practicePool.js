import { Router } from 'express';
import { pool } from '../db.js';
import requireAuth from '../middleware/requireAuth.js';

const router = Router();

function normalizePrompt(prompt) {
  return (prompt || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Combines both sources of open exercises for a book into one flat pool for
// "Tester ses connaissances" (KnowledgeTestModal.jsx): the manual Exercices
// mode (quiz_progress, one row per chapter, only the latest generation kept)
// and Pomodoro cycles (pomodoro_exercises, one row appended per completed
// cycle — see pomodoro.js). Deduplicated by normalized prompt text: repeated
// Pomodoro cycles over the same passage can otherwise generate near-identical
// exercises across many rows. Random sampling of the returned pool happens
// client-side (see practicePool.js on the frontend), not here.
router.get('/books/:bookId/practice-pool', requireAuth, async (req, res) => {
  const { userId } = req;
  const { bookId } = req.params;

  const [quizRows, pomodoroRows] = await Promise.all([
    pool.query(
      `SELECT chapter_href, chapter_label, questions_json FROM quiz_progress
       WHERE user_id = $1 AND book_id = $2 AND mode = 'exercise'`,
      [userId, bookId]
    ),
    pool.query(
      `SELECT chapter_label, questions_json FROM pomodoro_exercises
       WHERE user_id = $1 AND book_id = $2 ORDER BY generated_at DESC LIMIT 200`,
      [userId, bookId]
    ),
  ]);

  const seen = new Set();
  const items = [];

  for (const row of quizRows.rows) {
    const label = row.chapter_label || row.chapter_href;
    for (const exercise of row.questions_json ?? []) {
      const key = normalizePrompt(exercise.prompt);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push({ source: 'quiz', sourceLabel: label, exercise });
    }
  }

  for (const row of pomodoroRows.rows) {
    const label = row.chapter_label || 'Session Pomodoro';
    for (const exercise of row.questions_json ?? []) {
      const key = normalizePrompt(exercise.prompt);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push({ source: 'pomodoro', sourceLabel: label, exercise });
    }
  }

  res.json({ pool: items });
});

export default router;
