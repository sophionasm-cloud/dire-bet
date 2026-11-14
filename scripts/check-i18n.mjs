import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps/web/src/i18n');
const languages = ['en','am','so','om'];
const dictionaries = Object.fromEntries(languages.map((language) => [language, JSON.parse(readFileSync(resolve(root, `${language}.json`), 'utf8'))]));
const keys = Object.keys(dictionaries.en).sort();
const missing = [];
for (const language of languages.slice(1)) {
  const actual = Object.keys(dictionaries[language]).sort();
  if (JSON.stringify(keys) !== JSON.stringify(actual)) {
    missing.push(`${language}: missing [${keys.filter((key) => !actual.includes(key)).join(', ')}], extra [${actual.filter((key) => !keys.includes(key)).join(', ')}]`);
  }
}
if (missing.length) {
  console.error(`Translation key check failed:\n${missing.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Translation key check passed: ${keys.length} keys in ${languages.length} languages.`);
}
