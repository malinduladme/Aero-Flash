# Runs the full WiFi transport verification while the PC is joined to the ESP32's
# SoftAP, writing everything to a log file.
#
# Use this when you cannot be on the ESP32's network and the internet at the same
# time:
#   1. Connect this PC to SmartCam-Flash-XXXX  (password: smartcam123)
#   2. Right-click this file -> Run with PowerShell
#      (or:  powershell -ExecutionPolicy Bypass -File .\run-offline-tests.ps1)
#   3. Reconnect to your normal network
#   4. The results are in tools/udp-client/offline-test-results.txt

$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $here "offline-test-results.txt"

function Log($text) {
    Write-Host $text
    Add-Content -Path $log -Value $text -Encoding utf8
}

Set-Content -Path $log -Value "SmartCam WiFi transport test - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -Encoding utf8
Log ("=" * 60)

# Confirm we are actually on the SoftAP before blaming the firmware for silence.
$ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -like '192.168.4.*' }

if (-not $ip) {
    Log "NOT CONNECTED to the ESP32 SoftAP."
    Log "This PC has no 192.168.4.x address, so nothing can reach the device."
    Log "Join SmartCam-Flash-XXXX (password smartcam123) and run this again."
    Log ""
    Log "Current addresses:"
    Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -ne '127.0.0.1' } |
        ForEach-Object { Log ("  " + $_.IPAddress + "  (" + $_.InterfaceAlias + ")") }
    Read-Host "`nPress Enter to close"
    exit 1
}

Log ("Connected to SoftAP as " + ($ip.IPAddress -join ', '))
Log ""

foreach ($test in @(
    @{ Name = "STATUS      - device reachable over the air"; Args = @("status") },
    @{ Name = "SYNC        - clock handshake, round-trip time"; Args = @("sync") },
    @{ Name = "FIRE-NOW    - naive immediate fire (control)"; Args = @("fire-now") },
    @{ Name = "FIRE-AT 120 - scheduled fire, 120ms lead"; Args = @("fire-at", "120") },
    @{ Name = "FIRE-AT 250 - scheduled fire, 250ms lead"; Args = @("fire-at", "250") }
)) {
    Log ("-" * 60)
    Log $test.Name
    Log ("-" * 60)
    $out = & node (Join-Path $here "client.js") @($test.Args) 2>&1
    $out | ForEach-Object { Log ("  " + $_) }
    Log ""
    Start-Sleep -Milliseconds 900   # respect the 500ms firmware cooldown
}

Log ("=" * 60)
Log "Done. Reconnect to your normal network; the results are in:"
Log $log

Read-Host "`nPress Enter to close"
