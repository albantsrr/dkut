import { apiGet, apiPutJson } from './api.js';

const DEFAULTS = { cycleMinutes: 25, breakMinutes: 5 };

// In-memory mirror, mirrors the pattern in customPrompts.js — infrequent
// reads/writes (Profile page only), so a simple lazy-fetched cache is enough.
let _settings = null;

export async function getPomodoroSettings() {
  if (!_settings) {
    _settings = await apiGet('/pomodoro-settings').catch(() => DEFAULTS);
  }
  return _settings;
}

export async function savePomodoroSettings({ cycleMinutes, breakMinutes }) {
  await apiPutJson('/pomodoro-settings', { cycleMinutes, breakMinutes });
  _settings = { cycleMinutes, breakMinutes };
  return _settings;
}

// Called on sign-out so a subsequent sign-in with a different account starts
// with a fresh fetch rather than stale data.
export function resetPomodoroSettings() {
  _settings = null;
}
