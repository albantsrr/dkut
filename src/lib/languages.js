export const LANGUAGES = [
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'ja', label: '日本語' },
  { code: 'zh-CN', label: '中文 (简体)' },
  { code: 'zh-TW', label: '中文 (繁體)' },
  { code: 'ko', label: '한국어' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ar', label: 'العربية' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'sv', label: 'Svenska' },
  { code: 'da', label: 'Dansk' },
  { code: 'fi', label: 'Suomi' },
];

export function languageLabel(code) {
  return LANGUAGES.find(l => l.code === code)?.label || code;
}
