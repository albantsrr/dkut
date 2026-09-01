import { apiGet, apiPutJson, apiPostJson } from './api.js';

// Every call hits server/src/routes/quiz.js directly — no in-memory mirror.
// Unlike progress.js this isn't on a hot path (reads happen once per quiz
// open, writes once per generation/attempt), so there's nothing worth
// shielding with a cache, and always-fresh reads are simpler to reason about.

// Returns the cached entry for one book/chapter/mode, or null if no quiz
// has been generated for it yet.
export async function getQuizProgress(bookId, chapterHref, mode) {
  return apiGet(`/books/${bookId}/quiz/${encodeURIComponent(chapterHref)}/${mode}`);
}

// Returns { [chapterHref]: { exercise, interview } } for one book, used to
// compute completion badges across the whole TOC.
export async function getAllQuizProgress(bookId) {
  return apiGet(`/books/${bookId}/quiz`);
}

// Persisted as soon as a quiz is generated, independently of whether the
// user finishes playing it — so a partial session never loses the questions
// (and never triggers a second Gemini call for the same book/chapter/mode).
// Only ever called right after a fresh Gemini generation (first time or an
// explicit "Régénérer") — never to re-cache already-known questions — so
// stats always start over rather than carrying forward the previous set's
// score/attempts, which belonged to different questions.
export async function saveQuizQuestions(bookId, chapterHref, mode, questions) {
  await apiPutJson(`/books/${bookId}/quiz/${encodeURIComponent(chapterHref)}/${mode}`, { questions });
}

// Called when a quiz playthrough reaches the summary screen.
export async function saveQuizAttempt(bookId, chapterHref, mode, { score, total }) {
  await apiPostJson(`/books/${bookId}/quiz/${encodeURIComponent(chapterHref)}/${mode}/attempt`, { score, total });
}

// No-op: nothing is cached in memory here anymore. Kept so AuthContext's
// sign-out sequence doesn't need to change.
export function resetQuizProgress() {}
