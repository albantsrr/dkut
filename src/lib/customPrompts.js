import { apiGet, apiPutJson, apiDelete } from './api.js';

const DEFAULT_PROMPTS = [
  { id: 'default-revision-sheet', title: 'Create a revision sheet', text: 'Create a revision sheet', type: 'revision-sheet' },
  { id: 'default-revision-set', title: 'Générer les fiches de révision du chapitre', text: '', type: 'revision-set' },
  { id: 'default-explain-terms', title: 'Explain difficult terms', text: 'Explain difficult terms', type: 'chat' },
  { id: 'default-comprehension', title: 'Create 3 comprehension questions', text: 'Create 3 comprehension questions', type: 'chat' },
  { id: 'default-simplify', title: 'Simplify this passage', text: 'Simplify this passage', type: 'chat' },
];

// Ids of defaults that used to exist (free-text exercises/interview prep,
// replaced by the QCM quiz reachable from the Reader toolbar — see
// QuizModal.jsx).
const RETIRED_DEFAULT_IDS = ['default-interview-prep', 'default-learning-package'];

// In-memory mirror, mirrors the pattern in progress.js. Writes here are
// infrequent (user-triggered add/edit/delete), so no debounce is needed.
let _prompts = null;
// Default-prompt ids the user deliberately deleted — without this, deleting
// a default prompt never "sticks": the next ensurePrompts() backfill would
// see its id missing from customPrompts and re-seed it, indistinguishable
// from a default introduced after the user's account was created.
let _deletedDefaultIds = null;

async function ensurePrompts() {
  if (_prompts) return;
  const { prompts, deletedDefaultIds } = await apiGet('/prompts');
  _deletedDefaultIds = new Set(deletedDefaultIds || []);

  const existingIds = new Set(prompts.map(p => p.id));
  const missingDefaults = DEFAULT_PROMPTS.filter(p => !existingIds.has(p.id) && !_deletedDefaultIds.has(p.id));
  const retiredPresent = prompts.filter(p => RETIRED_DEFAULT_IDS.includes(p.id));
  const withoutRetired = prompts.filter(p => !RETIRED_DEFAULT_IDS.includes(p.id));

  _prompts = [...withoutRetired, ...missingDefaults];

  // Backfill any default added after this user's account already existed
  // (matched by id) — a brand new account has an empty `prompts` array, so
  // this same path also seeds all of DEFAULT_PROMPTS on first load.
  await Promise.all(missingDefaults.map(p =>
    apiPutJson(`/prompts/${p.id}`, { title: p.title, text: p.text, type: p.type })
  ));
  // Actively drop any retired default still sitting in storage from before
  // the Quiz feature replaced it.
  await Promise.all(retiredPresent.map(p => apiDelete(`/prompts/${p.id}`)));
}

export async function getAllPrompts() {
  await ensurePrompts();
  return _prompts;
}

// Adds a new prompt, or replaces an existing one by id.
export async function savePrompt(prompt) {
  await ensurePrompts();
  await apiPutJson(`/prompts/${prompt.id}`, { title: prompt.title, text: prompt.text, type: prompt.type });
  const idx = _prompts.findIndex(p => p.id === prompt.id);
  _prompts = idx >= 0
    ? _prompts.map((p, i) => (i === idx ? prompt : p))
    : [..._prompts, prompt];
  return _prompts;
}

export async function deletePrompt(id) {
  await ensurePrompts();
  const isDefault = DEFAULT_PROMPTS.some(p => p.id === id);
  await apiDelete(`/prompts/${id}${isDefault ? '?markDeletedDefault=true' : ''}`);
  _prompts = _prompts.filter(p => p.id !== id);
  if (isDefault) _deletedDefaultIds.add(id);
  return _prompts;
}

// Called on sign-out so a subsequent sign-in with a different account
// starts with a fresh fetch rather than stale data.
export function resetCustomPrompts() {
  _prompts = null;
  _deletedDefaultIds = null;
}
