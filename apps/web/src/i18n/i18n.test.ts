import { describe, expect, it } from 'vitest';
import { dictionaries, languageFromTelegram, translate, type Language } from './index';

describe('translations', () => {
  it('keeps identical keys across all four language files', () => {
    const reference = Object.keys(dictionaries.en).sort();
    for (const language of ['am','so','om'] as Language[]) {
      expect(Object.keys(dictionaries[language]).sort()).toEqual(reference);
    }
  });
  it('maps Telegram language codes and falls back to English', () => {
    expect(languageFromTelegram('am')).toBe('am');
    expect(languageFromTelegram('so')).toBe('so');
    expect(languageFromTelegram('om')).toBe('om');
    expect(languageFromTelegram('fr')).toBe('en');
    expect(translate('en','testMode')).toBe('PAYMENTS LOCKED');
  });
});
