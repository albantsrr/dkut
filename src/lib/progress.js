import { apiGet, apiPutJson, apiDelete } from './api.js';

// In-memory mirror of all progress rows for the current user — populated
// lazily on first access, reset on sign-out.
let _progress = null;
// One debounce timer per book (in practice only one book is ever open in the
// Reader at a time, but this stays correct even if that ever changes).
const _saveTimers = new Map();

async function ensureProgress() {
  if (!_progress) {
    _progress = await apiGet('/progress');
  }
}

// Returns just the CFI string for Reader resume.
export async function getProgress(id) {
  await ensureProgress();
  return _progress[id]?.cfi ?? null;
}

// Returns the full { cfi, pct } entry or null.
// Used by Reader to restore position via percentage rather than raw CFI,
// so a stale CFI can never kill epubjs's render queue.
export async function getProgressFull(id) {
  await ensureProgress();
  return _progress[id] ?? null;
}

// Returns progress data for all books as { [id]: { cfi, pct } }.
export async function getAllProgress() {
  await ensureProgress();
  return _progress;
}

function persistOne(id) {
  const entry = _progress[id];
  if (!entry) return;
  apiPutJson(`/progress/${id}`, entry).catch(console.error);
}

export async function saveProgress(id, cfi, pct) {
  await ensureProgress();
  _progress[id] = { cfi, pct: pct ?? 0 };
  // Debounce: coalesces rapid page turns into one backend write.
  clearTimeout(_saveTimers.get(id));
  _saveTimers.set(id, setTimeout(() => {
    _saveTimers.delete(id);
    persistOne(id);
  }, 1500));
}

// Flush any pending debounced saves immediately (call on visibilitychange/unload).
export function flushProgress() {
  for (const [id, timer] of _saveTimers) {
    clearTimeout(timer);
    persistOne(id);
  }
  _saveTimers.clear();
}

export async function clearProgress(id) {
  await ensureProgress();
  delete _progress[id];
  clearTimeout(_saveTimers.get(id));
  _saveTimers.delete(id);
  await apiDelete(`/progress/${id}`);
}

// Called on sign-out so a subsequent sign-in with a different account
// starts with a fresh fetch rather than stale data.
export function resetProgress() {
  for (const timer of _saveTimers.values()) clearTimeout(timer);
  _saveTimers.clear();
  _progress = null;
}
