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
& npx wrangler d1 migrations apply dire-bet-db --remote --yes
if ($LASTEXITCODE -ne 0) { throw 'Remote migrations failed. The D1 database ID remains saved in wrangler.jsonc.' }

function New-SecretValue {
  $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function Set-WranglerSecretFromInput([string] $Name, [string] $Value) {
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = 'cmd.exe'
  $start.Arguments = "/d /s /c `"npx wrangler secret put $Name`""
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  [void]$process.Start()
  $process.StandardInput.WriteLine($Value)
  $process.StandardInput.Close()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout = $stdoutTask.Result
  $stderr = $stderrTask.Result
  if ($process.ExitCode -ne 0) {
    throw "Uploading $Name failed. Wrangler output was: $($stderr.Trim())"
  }
}

Write-Host 'Creating session and webhook secrets in memory and uploading them to Wrangler...'
foreach ($name in @('TELEGRAM_WEBHOOK_SECRET','SESSION_SECRET')) {
  $value = New-SecretValue
  Set-WranglerSecretFromInput -Name $name -Value $value
  $value = $null
  Write-Host "Uploaded $name."
}

$secureSetupKey = Read-Host 'Paste a strong one-time SETUP_KEY from your password manager; keep it until Telegram setup is complete' -AsSecureString
$setupKeyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSetupKey)
try {
  $setupKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($setupKeyPtr)
  if ($setupKey.Length -lt 32) { throw 'SETUP_KEY must be at least 32 characters.' }
  Set-WranglerSecretFromInput -Name 'SETUP_KEY' -Value $setupKey
  Write-Host 'Uploaded SETUP_KEY.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($setupKeyPtr)
  $setupKey = $null
  $secureSetupKey.Dispose()
}

Write-Host ''
Write-Host "OWNER ACTION: run npx wrangler secret put TELEGRAM_BOT_TOKEN and type the bot token only into the Wrangler prompt."
Write-Host 'After a safe deployment, run ./scripts/complete-telegram-setup.ps1 and enter the Worker URL and SETUP_KEY securely.'
Write-Host 'The bot token is not read by this script. Live-money settings remain disabled.'
