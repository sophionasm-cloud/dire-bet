$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath '.\wrangler.jsonc')) {
  throw 'Run this script from the DIRE BET project folder.'
}

Write-Host 'Checking Cloudflare login and D1 database...'
function Get-D1Databases {
  $output = (& npx wrangler d1 list --json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw 'Wrangler could not list databases. Run npx wrangler login, then try again.' }
  try { return @(ConvertFrom-Json -InputObject $output) }
  catch { throw 'Wrangler returned an unreadable D1 database list. Review npx wrangler d1 list --json.' }
}

$databases = @(Get-D1Databases)
$database = $databases | Where-Object { $_.name -eq 'dire-bet-db' } | Select-Object -First 1
if (-not $database) {
  & npx wrangler d1 create dire-bet-db
  if ($LASTEXITCODE -ne 0) { throw 'D1 database creation failed. Review the Wrangler message and try again.' }
  $databases = @(Get-D1Databases)
  $database = $databases | Where-Object { $_.name -eq 'dire-bet-db' } | Select-Object -First 1
}

$databaseId = $database.uuid
if (-not $databaseId) { $databaseId = $database.id }
if (-not $databaseId) { $databaseId = $database.database_id }
if (-not $databaseId) { throw 'Wrangler did not return the D1 ID. Inspect npx wrangler d1 list --json and set d1_databases[0].database_id manually.' }

$config = Get-Content -LiteralPath '.\wrangler.jsonc' -Raw | ConvertFrom-Json
$config.d1_databases[0].database_id = $databaseId
$configText = $config | ConvertTo-Json -Depth 50
[System.IO.File]::WriteAllText((Resolve-Path '.\wrangler.jsonc'), $configText, [System.Text.UTF8Encoding]::new($false))

Write-Host 'Applying database migrations...'
& npx wrangler d1 migrations apply dire-bet-db --remote
if ($LASTEXITCODE -ne 0) { throw 'Remote migrations failed. The D1 database ID remains saved in wrangler.jsonc.' }

Write-Host ''
Write-Host 'Database setup is complete. Deploy the demo first, then run ./scripts/connect-telegram.ps1.'
Write-Host 'The Telegram script asks for the bot token in a hidden prompt and keeps money features disabled.'
