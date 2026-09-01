import { Router } from 'express';
import { pool } from '../db.js';
import requireAuth from '../middleware/requireAuth.js';

const router = Router();

function toEntry(row) {
  if (!row) return null;
  return {
    sessionsCompleted: row.sessions_completed,
    totalMinutes: row.total_minutes,
    exercisesAnswered: row.exercises_answered,
    exercisesCorrect: row.exercises_correct,
    firstSessionAt: row.first_session_at,
    lastSessionAt: row.last_session_at,
  };
}

router.get('/pomodoro', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pomodoro_log WHERE user_id = $1', [req.userId]);
  const out = {};
  for (const row of rows) out[row.book_id] = toEntry(row);
  res.json(out);
});

router.get('/pomodoro/:bookId', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM pomodoro_log WHERE user_id = $1 AND book_id = $2',
    [req.userId, req.params.bookId]
  );
  res.json(toEntry(rows[0]));
});

// Called exactly once per completed cycle — an interrupted cycle never calls
// this, so it leaves no trace by construction (see PomodoroModal.jsx).
router.post('/pomodoro/:bookId/cycle', requireAuth, async (req, res) => {
  const { durationMinutes, exercisesAnswered, exercisesCorrect } = req.body ?? {};
  await pool.query(
    `INSERT INTO pomodoro_log (user_id, book_id, sessions_completed, total_minutes, exercises_answered, exercises_correct, first_session_at, last_session_at)
     VALUES ($1, $2, 1, $3, $4, $5, now(), now())
     ON CONFLICT (user_id, book_id) DO UPDATE SET
       sessions_completed = pomodoro_log.sessions_completed + 1,
       total_minutes = pomodoro_log.total_minutes + EXCLUDED.total_minutes,
       exercises_answered = pomodoro_log.exercises_answered + EXCLUDED.exercises_answered,
       exercises_correct = pomodoro_log.exercises_correct + EXCLUDED.exercises_correct,
       last_session_at = now()`,
    [req.userId, req.params.bookId, durationMinutes, exercisesAnswered, exercisesCorrect]
  );
  res.status(204).end();
});

export default router;
