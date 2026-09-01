import { Router } from 'express';
import { pool } from '../db.js';
import requireAuth from '../middleware/requireAuth.js';

const router = Router();

function toPublicSettings(row) {
  return { cycleMinutes: row.pomodoro_cycle_minutes, breakMinutes: row.pomodoro_break_minutes };
}

router.get('/pomodoro-settings', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT pomodoro_cycle_minutes, pomodoro_break_minutes FROM users WHERE id = $1',
    [req.userId]
  );
  if (rows.length === 0) return res.status(401).json({ error: 'not_authenticated' });
  res.json(toPublicSettings(rows[0]));
});

router.put('/pomodoro-settings', requireAuth, async (req, res) => {
  const { cycleMinutes, breakMinutes } = req.body ?? {};
  if (!Number.isInteger(cycleMinutes) || cycleMinutes < 1 || cycleMinutes > 180) {
    return res.status(400).json({ error: 'invalid_cycle_minutes' });
  }
  if (!Number.isInteger(breakMinutes) || breakMinutes < 1 || breakMinutes > 60) {
    return res.status(400).json({ error: 'invalid_break_minutes' });
  }
  await pool.query(
    'UPDATE users SET pomodoro_cycle_minutes = $1, pomodoro_break_minutes = $2 WHERE id = $3',
    [cycleMinutes, breakMinutes, req.userId]
  );
  res.status(204).end();
});

export default router;
