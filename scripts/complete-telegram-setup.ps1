$ErrorActionPreference = 'Stop'

$workerAddress = Read-Host 'Enter the deployed HTTPS Worker URL'
$workerUri = $null
if (-not [Uri]::TryCreate($workerAddress, [UriKind]::Absolute, [ref]$workerUri) -or $workerUri.Scheme -ne 'https') {
  throw 'Enter the deployed Worker origin beginning with https://.'
}

$secureSetupKey = Read-Host 'Enter the one-time SETUP_KEY securely' -AsSecureString
$setupKeyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSetupKey)
try {
  $setupKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($setupKeyPtr)
  if ($setupKey.Length -lt 32) { throw 'SETUP_KEY must be at least 32 characters.' }
  $response = Invoke-RestMethod -Method Post -Uri "$($workerUri.GetLeftPart([UriPartial]::Authority))/telegram/setup" `
    -Headers @{ Authorization = "Bearer $setupKey" } -ContentType 'application/json' -Body '{}'
  if (-not $response.ok) { throw 'Telegram setup did not return success. Review Worker secrets and deployment status.' }
  Write-Host 'Telegram webhook, commands and menu are configured.'
} catch {
  throw 'Telegram setup failed. Verify the Worker URL, setup key, bot token, webhook secret and database migration, then try again.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($setupKeyPtr)
  $setupKey = $null
  $secureSetupKey.Dispose()
}
