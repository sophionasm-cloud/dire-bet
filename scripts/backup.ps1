$ErrorActionPreference = 'Stop'
$backupFolder = Join-Path (Get-Location) 'backups'
New-Item -ItemType Directory -Path $backupFolder -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outputFile = Join-Path $backupFolder "dire-bet-db-$stamp.sql"
& npx wrangler d1 export dire-bet-db --remote --output $outputFile
if ($LASTEXITCODE -ne 0) { throw 'D1 export failed. Check Wrangler login and database binding.' }
Write-Host "Database export saved to $outputFile"
