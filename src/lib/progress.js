import { loadData, saveData } from './driveStorage.js';

// In-memory mirror of the progress portion only — populated lazily on first access,
// reset on sign-out. Storing only progress (not books) prevents a stale snapshot
// from overwriting books added by saveBook() after this module was loaded.
let _progress = null;
let _saveTimer = null;

async function ensureProgress() {
  if (!_progress) {
    const data = await loadData();
    _progress = data.progress ?? {};
  }
}

async function persistProgress() {
  const data = await loadData();
  data.progress = _progress;
  await saveData(data);
}

// Returns just the CFI string for Reader resume (handles legacy string format).
export async function getProgress(id) {
  await ensureProgress();
  const val = _progress[id] ?? null;
  if (!val) return null;
  return typeof val === 'string' ? val : val.cfi;
}

// Returns progress data for all books as { [id]: { cfi, pct } }.
export async function getAllProgress() {
  await ensureProgress();
  const out = {};
  for (const [id, val] of Object.entries(_progress)) {
    out[id] = typeof val === 'string' ? { cfi: val, pct: 0 } : val;
  }
  return out;
}

export async function saveProgress(id, cfi, pct) {
  await ensureProgress();
  _progress[id] = { cfi, pct: pct ?? 0 };
  // Debounce: coalesces rapid page turns into one Drive write.
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    persistProgress().catch(console.error);
  }, 1500);
}

// Flush any pending debounced save immediately (call on visibilitychange/unload).
export function flushProgress() {
  if (!_saveTimer || !_progress) return;
  clearTimeout(_saveTimer);
  _saveTimer = null;
  persistProgress().catch(console.error);
}

export async function clearProgress(id) {
  await ensureProgress();
  delete _progress[id];
  await persistProgress();
}

// Called on sign-out so a subsequent sign-in with a different account
// starts with a fresh fetch rather than stale data.
export function resetProgress() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  _progress = null;
}
