import { spawnSync } from 'node:child_process';

if (process.argv.includes('--remote') || process.argv.includes('--env') || process.env.WRANGLER_ENV === 'production' || process.env.ENVIRONMENT === 'production') {
  console.error('Demo seed refused: it can only write to the local D1 database.');
  process.exit(1);
}
const result = spawnSync('npx', ['wrangler', 'd1', 'execute', 'dire-bet-db', '--local', '--file=seeds/demo.sql'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) {
  console.error('Could not start Wrangler. Run npm install first.');
  process.exit(1);
}
process.exit(result.status ?? 1);
