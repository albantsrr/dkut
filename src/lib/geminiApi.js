// Thin HTTP client for the backend's Gemini endpoints (server/src/gemini.js,
// server/src/routes/ai.js) — see MIGRATION_PLAN.md phase 4. The Gemini API
// key itself now lives only server-side; no VITE_GEMINI_API_KEY here anymore.
// Every exported function below keeps the exact same name/shape it had when
// it called @google/generative-ai directly, so every call site (ChatPanel,
// QuizModal, PomodoroModal, TranslateBookModal/epubTranslator) was updated to
// just stop passing `apiKey`, nothing else.

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

// Error codes (NO_API_KEY, NO_PAGE_TEXT, EMPTY_QUIZ, EMPTY_PLAN, ...) are
// carried in the JSON error body's `error` field and re-thrown as the
// Error's `message`, so every existing `err.message === 'NO_API_KEY'`-style
// check at the call sites keeps working unchanged.
async function postAI(path, body, signal) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let code = 'NETWORK';
    try { code = (await res.json())?.error || code; } catch { /* non-JSON error body */ }
    throw new Error(code);
  }
  return res;
}

async function* readNdjson(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

/**
 * Streams a chat reply, yielding text chunks — see POST /ai/chat.
 */
export async function* streamChatMessage({
  userMessage,
  pageText,
  bookTitle,
  bookAuthor,
  chapterName,
  history = [],
  signal,
}) {
  const res = await postAI('/ai/chat', { userMessage, pageText, bookTitle, bookAuthor, chapterName, history }, signal);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}

/**
 * Generates a full revision sheet document (non-streaming).
 * Returns a markdown string.
 */
export async function generateRevisionSheet({ pageText, bookTitle, bookAuthor, chapterName }) {
  const res = await postAI('/ai/revision-sheet', { pageText, bookTitle, bookAuthor, chapterName });
  const { text } = await res.json();
  return text;
}

/**
 * Generates a single revision sheet for one planned concept (non-streaming).
 * Exported standalone so a single failed card can be retried without
 * re-running the whole set.
 */
export async function generateSheetForConcept({ pageText, bookTitle, bookAuthor, chapterName, sheet, signal }) {
  const res = await postAI('/ai/revision-sheet-concept', { pageText, bookTitle, bookAuthor, chapterName, sheet }, signal);
  const { text } = await res.json();
  return text;
}

/**
 * Plans then generates a full set of concept-based revision sheets for the
 * current chapter — see POST /ai/revision-set (NDJSON stream, one event per
 * line). Async generator yielding progress events:
 *   { type: 'planning' }
 *   { type: 'plan', sheets: [{ slug, title, sourceHeading }, ...] }
 *   { type: 'sheet-start', index }
 *   { type: 'sheet-done', index, text }
 *   { type: 'sheet-error', index, error }
 *   { type: 'plan-error', error }
 *   { type: 'aborted', fromIndex? }
 *   { type: 'done' }
 */
export async function* generateRevisionSet({ pageText, bookTitle, bookAuthor, chapterName, signal }) {
  const res = await postAI('/ai/revision-set', { pageText, bookTitle, bookAuthor, chapterName }, signal);
  yield* readNdjson(res);
}

/**
 * Generates a multiple-choice quiz (mode: 'exercise' | 'interview') for the
 * current chapter, as a single call. Returns a validated array of questions.
 */
export async function generateQuiz({ mode, pageText, bookTitle, bookAuthor, chapterName, signal }) {
  const res = await postAI('/ai/quiz', { mode, pageText, bookTitle, bookAuthor, chapterName }, signal);
  const { questions } = await res.json();
  return questions;
}

/**
 * Generates 2-3 short practice exercises grounded in the text read during one
 * Pomodoro reading cycle. Deliberately not cached anywhere (unlike
 * generateQuiz) — each cycle asks a fresh question, and nothing is persisted
 * until the whole cycle is scored (see pomodoroLog.js).
 */
export async function generateSessionExercises({ pageText, bookTitle, bookAuthor, chapterName, signal }) {
  const res = await postAI('/ai/session-exercises', { pageText, bookTitle, bookAuthor, chapterName }, signal);
  const { questions } = await res.json();
  return questions;
}

/**
 * Translates a batch of independent text segments in one call. Raw call
 * only — no validation against the request is performed here (see
 * validateBatch in epubTranslator.js, which never trusts this blindly).
 */
export async function translateSegments({ segments, targetLangLabel, signal }) {
  const res = await postAI('/ai/translate-segments', { segments, targetLangLabel }, signal);
  const { translations } = await res.json();
  return translations;
}
