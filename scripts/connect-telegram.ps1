$ErrorActionPreference = 'Stop'
$workerOrigin = 'https://dire-bet.sophionasm.workers.dev'

$health = Invoke-RestMethod -Uri "$workerOrigin/api/health"
if (-not $health.ok -or $health.mode -ne 'demo' -or $health.realMoneyAvailable) {
  throw 'The DIRE BET Worker is not responding in safe demo mode. Stop and check the deployed Worker.'
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
  if ($process.ExitCode -ne 0) { throw "Uploading $Name failed. $($stderr.Trim())" }
}

function New-SecretValue {
  $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

$secureToken = Read-Host 'Paste the BotFather token for @Dire_Bet_bot here. Typing is hidden; do not send it in chat.' -AsSecureString
$tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
$token = $null
$setupKey = $null
try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
  if ($token -notmatch '^\d{5,}:[A-Za-z0-9_-]{20,}$') { throw 'That does not look like a Telegram bot token. Check it in BotFather and try again.' }

  Set-WranglerSecretFromInput -Name 'TELEGRAM_BOT_TOKEN' -Value $token
  $token = $null
  Write-Host 'Saved the bot token directly to Cloudflare.'

  foreach ($name in @('TELEGRAM_WEBHOOK_SECRET','SESSION_SECRET')) {
    $value = New-SecretValue
    Set-WranglerSecretFromInput -Name $name -Value $value
    $value = $null
    Write-Host "Created $name in Cloudflare."
  }

  $setupKey = New-SecretValue
  Set-WranglerSecretFromInput -Name 'SETUP_KEY' -Value $setupKey
  $response = Invoke-RestMethod -Method Post -Uri "$workerOrigin/telegram/setup" `
    -Headers @{ Authorization = "Bearer $setupKey" } -ContentType 'application/json' -Body '{}'
  if (-not $response.ok) { throw 'The Telegram setup endpoint did not return success.' }
  Write-Host 'Telegram bot is connected. Its /start button and menu now open the DIRE BET demo.'
} catch {
  throw "Telegram setup stopped: $($_.Exception.Message)"
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)
  $secureToken.Dispose()
  $token = $null
  $setupKey = $null
}
