import en from './en.json';
import am from './am.json';
import so from './so.json';
import om from './om.json';

export const dictionaries = { en, am, so, om } as const;
export type Language = keyof typeof dictionaries;
export type TranslationKey = keyof typeof en;

export function translate(language: Language, key: TranslationKey): string {
  return dictionaries[language][key] || en[key];
}

export function languageFromTelegram(code?: string): Language {
  if (code?.toLowerCase().startsWith('am')) return 'am';
  if (code?.toLowerCase().startsWith('so')) return 'so';
  if (code?.toLowerCase().startsWith('om')) return 'om';
  return 'am';
}

export const languageNames: Record<Language, string> = {
  en: 'English', am: 'አማርኛ', so: 'Soomaali', om: 'Afaan Oromoo',
};
