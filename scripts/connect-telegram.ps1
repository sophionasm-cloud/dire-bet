param([switch] $ReplaceBotToken)

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
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 32
  try {
    $rng.GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    $rng.Dispose()
  }
}

$secretListOutput = (& npx wrangler secret list --name dire-bet 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Could not check Cloudflare secrets. Run npx wrangler login and try again.' }
try { $secretNames = @((ConvertFrom-Json -InputObject $secretListOutput) | ForEach-Object { $_.name }) }
catch { throw 'Cloudflare returned an unreadable secret list. Stop and check the Wrangler setup.' }

$secureToken = $null
$tokenPtr = $null
$token = $null
$setupKey = $null
try {
  if ($ReplaceBotToken -or ($secretNames -notcontains 'TELEGRAM_BOT_TOKEN')) {
    $secureToken = Read-Host 'Paste the BotFather token for @Dire_Bet_bot here. Typing is hidden; do not send it in chat.' -AsSecureString
    $tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
    if ($token -notmatch '^\d{5,}:[A-Za-z0-9_-]{20,}$') { throw 'That does not look like a Telegram bot token. Check it in BotFather and try again.' }
    Set-WranglerSecretFromInput -Name 'TELEGRAM_BOT_TOKEN' -Value $token
    $token = $null
    Write-Host 'Saved the bot token directly to Cloudflare.'
  } else {
    Write-Host 'Found the saved bot token in Cloudflare; reusing it without asking you to type it again.'
  }

  foreach ($name in @('TELEGRAM_WEBHOOK_SECRET','SESSION_SECRET')) {
    if ($secretNames -notcontains $name) {
      $value = New-SecretValue
      Set-WranglerSecretFromInput -Name $name -Value $value
      $value = $null
      Write-Host "Created $name in Cloudflare."
    } else {
      Write-Host "Reusing saved $name."
    }
  }

  $setupKey = New-SecretValue
  Set-WranglerSecretFromInput -Name 'SETUP_KEY' -Value $setupKey
  $response = Invoke-RestMethod -Method Post -Uri "$workerOrigin/telegram/setup" `
    -Headers @{ Authorization = "Bearer $setupKey" } -ContentType 'application/json' -Body '{}'
  if (-not $response.ok) { throw 'The Telegram setup endpoint did not return success.' }
  Write-Host 'Telegram bot connection is current. Its /start button and menu open DIRE BET.'
} catch {
  throw "Telegram setup stopped: $($_.Exception.Message)"
} finally {
  if ($tokenPtr) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr) }
  if ($secureToken) { $secureToken.Dispose() }
  $token = $null
  $setupKey = $null
}
