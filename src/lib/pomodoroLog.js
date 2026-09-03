import { apiGet, apiPostJson } from './api.js';

// Every call hits server/src/routes/pomodoro.js directly — see
// quizProgress.js for why no in-memory mirror is kept here.

// Returns the aggregate entry for one book, or null if no cycle has ever
// been completed for it.
export async function getPomodoroStats(bookId) {
  return apiGet(`/pomodoro/${bookId}`);
}

// Returns the whole { [bookId]: entry } map, for the Stats page.
export async function getAllPomodoroStats() {
  return apiGet('/pomodoro');
}

// Called exactly once per cycle, when the end-of-cycle exercises reach the
// summary screen — this is the only persistence point for the whole feature.
// An interrupted cycle never calls this, so it leaves no trace by construction.
export async function recordCompletedCycle(bookId, { durationMinutes, exercisesAnswered, exercisesCorrect, exercises, chapterLabel }) {
  await apiPostJson(`/pomodoro/${bookId}/cycle`, { durationMinutes, exercisesAnswered, exercisesCorrect, exercises, chapterLabel });
}

// No-op: nothing is cached in memory here anymore. Kept so AuthContext's
// sign-out sequence doesn't need to change.
export function resetPomodoroLog() {}
