import { loadData, saveData } from './driveStorage.js';

const DEFAULT_PROMPTS = [
  { id: 'default-revision-sheet', title: 'Create a revision sheet', text: 'Create a revision sheet', type: 'revision-sheet' },
  { id: 'default-revision-set', title: 'Générer les fiches de révision du chapitre', text: '', type: 'revision-set' },
  { id: 'default-explain-terms', title: 'Explain difficult terms', text: 'Explain difficult terms', type: 'chat' },
  { id: 'default-comprehension', title: 'Create 3 comprehension questions', text: 'Create 3 comprehension questions', type: 'chat' },
  { id: 'default-simplify', title: 'Simplify this passage', text: 'Simplify this passage', type: 'chat' },
];

// In-memory mirror, mirrors the pattern in progress.js. Writes here are
// infrequent (user-triggered add/edit/delete), so no debounce is needed.
let _prompts = null;

async function ensurePrompts() {
  if (_prompts) return;
  const data = await loadData();
  if (data.customPrompts) {
    // Merge in any DEFAULT_PROMPTS added after this user's data file already
    // existed (matched by id) — otherwise a newly introduced default prompt
    // would never appear for existing users, since only a missing
    // `customPrompts` triggers the full-seed branch below.
    const existingIds = new Set(data.customPrompts.map(p => p.id));
    const missingDefaults = DEFAULT_PROMPTS.filter(p => !existingIds.has(p.id));
    _prompts = missingDefaults.length > 0 ? [...data.customPrompts, ...missingDefaults] : data.customPrompts;
    if (missingDefaults.length > 0) {
      data.customPrompts = _prompts;
      await saveData(data);
    }
  } else {
    // First load on a Drive data file created before this feature existed —
    // seed with today's defaults and persist once so they become editable.
    _prompts = DEFAULT_PROMPTS;
    data.customPrompts = _prompts;
    await saveData(data);
  }
}

async function persistPrompts() {
  const data = await loadData();
  data.customPrompts = _prompts;
  await saveData(data);
}

export async function getAllPrompts() {
  await ensurePrompts();
  return _prompts;
}

// Adds a new prompt, or replaces an existing one by id.
export async function savePrompt(prompt) {
  await ensurePrompts();
  const idx = _prompts.findIndex(p => p.id === prompt.id);
  _prompts = idx >= 0
    ? _prompts.map((p, i) => (i === idx ? prompt : p))
    : [..._prompts, prompt];
  await persistPrompts();
  return _prompts;
}

export async function deletePrompt(id) {
  await ensurePrompts();
  _prompts = _prompts.filter(p => p.id !== id);
  await persistPrompts();
  return _prompts;
}

// Called on sign-out so a subsequent sign-in with a different account
// starts with a fresh fetch rather than stale data.
export function resetCustomPrompts() {
  _prompts = null;
}
