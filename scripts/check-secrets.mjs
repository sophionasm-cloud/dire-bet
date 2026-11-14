import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
const telegramToken = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/;
const privateKey = new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----');
const allowedText = new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.json','.jsonc','.md','.txt','.css','.html','.sql','.ps1','.toml','.yaml','.yml','.svg','.xml','.example']);
const findings = [];

for (const file of files) {
  if (!allowedText.has(extname(file).toLowerCase())) continue;
  let contents;
  try { contents = readFileSync(resolve(root, file), 'utf8'); } catch { continue; }
  if (telegramToken.test(contents)) findings.push(`${file}: possible Telegram bot token`);
  if (privateKey.test(contents)) findings.push(`${file}: possible private key`);
}

if (findings.length) {
  console.error(`Secret scan failed:\n${findings.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed for ${files.length} repository files.`);
}
