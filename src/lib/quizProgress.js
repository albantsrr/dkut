import { loadData, saveData } from './driveStorage.js';
import { flushProgress } from './progress.js';

// In-memory mirror of data.quizProgress, mirrors the pattern in progress.js.
// Shape: { [bookId]: { [chapterHref]: { exercise: Entry, interview: Entry } } }
// where Entry = { questions, generatedAt, bestScore, total, attempts, completed, lastAttemptAt }.
let _quizProgress = null;

async function ensureQuizProgress() {
  if (!_quizProgress) {
    const data = await loadData();
    _quizProgress = data.quizProgress ?? {};
  }
}

async function persistQuizProgress() {
  // Reduce the window for the known read-whole-blob/write-whole-blob race
  // with progress.js's debounced writes (same limitation as customPrompts.js).
  flushProgress();
  const data = await loadData();
  data.quizProgress = _quizProgress;
  await saveData(data);
}

// Returns the cached entry for one book/chapter/mode, or null if no quiz
// has been generated for it yet.
export async function getQuizProgress(bookId, chapterHref, mode) {
  await ensureQuizProgress();
  return _quizProgress[bookId]?.[chapterHref]?.[mode] ?? null;
}

// Returns { [chapterHref]: { exercise, interview } } for one book, used to
// compute completion badges across the whole TOC.
export async function getAllQuizProgress(bookId) {
  await ensureQuizProgress();
  return _quizProgress[bookId] ?? {};
}

function ensureChapterEntry(bookId, chapterHref) {
  if (!_quizProgress[bookId]) _quizProgress[bookId] = {};
  if (!_quizProgress[bookId][chapterHref]) _quizProgress[bookId][chapterHref] = {};
  return _quizProgress[bookId][chapterHref];
}

// Persisted as soon as a quiz is generated, independently of whether the
// user finishes playing it — so a partial session never loses the questions
// (and never triggers a second Gemini call for the same book/chapter/mode).
// Only ever called right after a fresh Gemini generation (first time or an
// explicit "Régénérer") — never to re-cache already-known questions — so
// stats always start over rather than carrying forward the previous set's
// score/attempts, which belonged to different questions.
export async function saveQuizQuestions(bookId, chapterHref, mode, questions) {
  await ensureQuizProgress();
  const chapter = ensureChapterEntry(bookId, chapterHref);
  chapter[mode] = {
    questions,
    generatedAt: new Date().toISOString(),
    bestScore: 0,
    total: questions.length,
    attempts: 0,
    completed: false,
    lastAttemptAt: null,
  };
  await persistQuizProgress();
}

// Called when a quiz playthrough reaches the summary screen.
export async function saveQuizAttempt(bookId, chapterHref, mode, { score, total }) {
  await ensureQuizProgress();
  const chapter = ensureChapterEntry(bookId, chapterHref);
  const existing = chapter[mode] ?? { questions: [], bestScore: 0, attempts: 0 };
  chapter[mode] = {
    ...existing,
    total,
    bestScore: Math.max(existing.bestScore ?? 0, score),
    attempts: (existing.attempts ?? 0) + 1,
    completed: true,
    lastAttemptAt: new Date().toISOString(),
  };
  await persistQuizProgress();
}

// Called on sign-out so a subsequent sign-in with a different account
// starts with a fresh fetch rather than stale data.
export function resetQuizProgress() {
  _quizProgress = null;
}
