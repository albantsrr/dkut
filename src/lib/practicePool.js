import { apiGet } from './api.js';

// Every call hits server/src/routes/practicePool.js directly — no in-memory
// mirror, same reasoning as quizProgress.js/pomodoroLog.js (infrequent reads,
// always-fresh is simpler than a cache).

// Returns { pool: [{ source: 'quiz'|'pomodoro', sourceLabel, exercise }] } —
// every open exercise seen for this book (manual "Exercices" mode + Pomodoro
// cycles), deduplicated server-side. Random sampling for a review session
// happens client-side, in KnowledgeTestModal.jsx.
export async function getPracticePool(bookId) {
  return apiGet(`/books/${bookId}/practice-pool`);
}
