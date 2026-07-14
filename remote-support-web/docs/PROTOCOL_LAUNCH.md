# Protocol Launch Integration (supportdesk://)

This document shows how a native Windows host viewer can integrate with the server's
protocol launch flow so clicking a `supportdesk://...` link opens the native app and
attaches it to the session without needing to download the installer.

Protocol URI format (issued by server):

supportdesk://launch?token=<protocolToken>&server=<serverOrigin>&launchId=<hostLaunchId>

Steps for native viewer integration
1. The OS opens the native viewer with the URI. The native app extracts `token`, `server`, and `launchId`.
2. Call the claim API to mark the native app as attached:

  POST {server}/api/launch/protocol/claim
  Content-Type: application/json
  Body: { "token": "<protocolToken>" }

  Example (PowerShell):

  $token = '<protocolToken>'
  $server = 'https://your-server.example'
  $claimUrl = "$server/api/launch/protocol/claim"
  try {
    Invoke-RestMethod -Method Post -Uri $claimUrl -ContentType 'application/json' -Body (ConvertTo-Json @{ token = $token }) -ErrorAction Stop
    Write-Host "Protocol token claimed"
  } catch {
    Write-Host "Protocol claim failed: $_"
  }

3. (Optional) Retrieve host launch details using the `launchId` to get agent token + session id:

  GET {server}/api/host-launch/{launchId}

  Example (PowerShell):

  $launchId = '<hostLaunchId>'
  $launchInfo = Invoke-RestMethod -Method Get -Uri "$server/api/host-launch/$launchId"
  # launchInfo contains { sessionId, token }

4. Start the native host viewer process and connect it to the server using the session token:

  Example (PowerShell) launching an exe that accepts arguments:

  $exePath = 'C:\Program Files\SupportDesk\RemoteSupportHost.exe'
  $sessionId = $launchInfo.sessionId
  $token = $launchInfo.token
  Start-Process -FilePath $exePath -ArgumentList "$server","--session",$sessionId,"--token",$token

Automatic protocol handler (PowerShell)

If your installer registers `supportdesk://` as the OS protocol handler, the
native app may be launched by the OS with the full URI passed as the first
argument. The following PowerShell snippet demonstrates a robust handler that:

- Parses the incoming `supportdesk://launch?...` URI
- Calls `/api/launch/protocol/claim` to claim the short-lived token
- Fetches the host launch details and starts the native viewer process

Save this as `SupportDeskProtocolHandler.ps1` and register it during install
as the handler for `supportdesk://` URIs (or embed equivalent logic in your
native process startup code).

PowerShell handler example:

  param(
    [string]$uri
  )

  if (-not $uri) {
    Write-Host "No URI provided to handler"; exit 1
  }

  try {
    $u = [uri]$uri
  } catch {
    Write-Host "Invalid URI: $uri"; exit 1
  }

  $q = $u.Query.TrimStart('?') -split '&' | ForEach-Object {
    $parts = $_ -split '=', 2
    if ($parts.Length -eq 2) {
      @{ Key = [System.Uri]::UnescapeDataString($parts[0]); Value = [System.Uri]::UnescapeDataString($parts[1]) }
    }
  }
  $map = @{}
  foreach ($p in $q) { $map[$p.Key] = $p.Value }

  $token = $map['token']
  $server = $map['server']
  $launchId = $map['launchId']

  if (-not $token -or -not $server) {
    Write-Host "Missing token or server in protocol URI"; exit 1
  }

  # Claim protocol token
  try {
    $claimUrl = "$server/api/launch/protocol/claim"
    Invoke-RestMethod -Method Post -Uri $claimUrl -ContentType 'application/json' -Body (ConvertTo-Json @{ token = $token }) -ErrorAction Stop
    Write-Host "Protocol token claimed"
  } catch {
    Write-Host "Protocol claim failed: $_"
    # Continue — some setups may prefer to try fetching launch info anyway
  }

  # If we have a launchId, fetch host launch details
  if ($launchId) {
    try {
      $launchInfo = Invoke-RestMethod -Method Get -Uri "$server/api/host-launch/$launchId" -ErrorAction Stop
      $sessionId = $launchInfo.sessionId
      $tokenForLaunch = $launchInfo.token
    } catch {
      Write-Host "Could not fetch launch info: $_"
    }
  }

  # Launch the native viewer if available. Adjust path as installed.
  $exePath = 'C:\Program Files\SupportDesk\RemoteSupportHost.exe'
  if (Test-Path $exePath) {
    $args = @($server)
    if ($sessionId) { $args += '--session'; $args += $sessionId }
    if ($tokenForLaunch) { $args += '--token'; $args += $tokenForLaunch }
    Start-Process -FilePath $exePath -ArgumentList $args
    Write-Host "Started native viewer: $exePath"
  } else {
    Write-Host "Native viewer not found at $exePath"
  }

Notes
- The claim endpoint is short-lived; the server issues protocol tokens valid for ~60s.
- If your installer registers the `supportdesk://` protocol, ensure the handler extracts
  the params and follows the flow above.
- For improved UX, call the claim endpoint first, then start the native viewer so the server
  marks the session `nativeConnected` quickly and hosts receive updates.

Security
- The protocol token is single-use and short-lived; do not leak it in logs.
