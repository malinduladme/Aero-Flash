# Reconnect a paired Android phone over Wi-Fi, forward Metro, and launch SmartCam.
#
# Run Metro in another terminal first:
#   npx react-native start --port 8081
#
# Then run:
#   .\android-wifi-debug.ps1
# If more than one phone is paired, pass its wireless ADB endpoint:
#   .\android-wifi-debug.ps1 -DeviceAddress 192.168.1.25:41237
# To install a previously built APK over Wi-Fi before launching:
#   .\android-wifi-debug.ps1 -ApkPath .\android\app\build\outputs\apk\debug\app-debug.apk

param(
    [string]$DeviceAddress,
    [string]$ApkPath
)

$ErrorActionPreference = "Stop"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$adb = Join-Path $env:ANDROID_HOME "platform-tools\adb.exe"

if (-not (Test-Path $adb)) {
    throw "Android platform tools were not found at $adb."
}

if (-not $DeviceAddress) {
    $services = @(& $adb mdns services)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not discover Android wireless debugging services."
    }

    $addresses = @()
    foreach ($service in $services) {
        if ($service -match '_adb-tls-connect\._tcp\s+(\S+)') {
            $addresses += [string]$Matches[1]
        }
    }
    $addresses = @($addresses | Sort-Object -Unique)

    if ($addresses.Count -eq 0) {
        $devices = @(& $adb devices)
        $addresses = @()
        foreach ($device in ($devices | Select-Object -Skip 1)) {
            if ($device -match '^\s*(\d{1,3}(?:\.\d{1,3}){3}:\d+)\s+device(?:\s|$)') {
                $addresses += [string]$Matches[1]
            }
        }
        $addresses = @($addresses | Sort-Object -Unique)
    }

    if ($addresses.Count -eq 0) {
        throw "No paired phone found. Enable Wireless debugging on the phone, pair it with this PC once, then retry."
    }
    if ($addresses.Count -gt 1) {
        throw "More than one paired phone was found. Retry with -DeviceAddress IP:PORT."
    }
    $DeviceAddress = $addresses[0]
}

$connectionOutput = @(& $adb connect $DeviceAddress 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw "Could not connect to $DeviceAddress over Wi-Fi: $($connectionOutput -join ' ')"
}

$deviceState = & $adb -s $DeviceAddress get-state
if ($LASTEXITCODE -ne 0 -or $deviceState -ne "device") {
    throw "Wireless ADB connection to $DeviceAddress is not authorized or ready."
}

try {
    $metroStatus = & curl.exe --fail --silent --show-error --max-time 5 `
        "http://127.0.0.1:8081/status" 2>&1 | Out-String
    $metroExitCode = $LASTEXITCODE
    if ($metroExitCode -ne 0 -or $metroStatus -notmatch "packager-status:running") {
        throw "Metro did not report ready."
    }
} catch {
    throw "Metro is not responding on port 8081. Start it in the app folder with: npx react-native start --port 8081"
}

& $adb -s $DeviceAddress reverse tcp:8081 tcp:8081
if ($LASTEXITCODE -ne 0) {
    throw "Could not forward Metro over the wireless ADB connection."
}

if ($ApkPath) {
    $resolvedApkPath = Resolve-Path -LiteralPath $ApkPath -ErrorAction Stop
    & $adb -s $DeviceAddress install -r $resolvedApkPath.Path
    if ($LASTEXITCODE -ne 0) {
        throw "Could not install $($resolvedApkPath.Path) over the wireless ADB connection."
    }
}

& $adb -s $DeviceAddress shell am force-stop com.smartcamapp
if ($LASTEXITCODE -ne 0) {
    throw "Could not stop SmartCam on the phone."
}

& $adb -s $DeviceAddress shell monkey -p com.smartcamapp -c android.intent.category.LAUNCHER 1
if ($LASTEXITCODE -ne 0) {
    throw "Could not launch SmartCam on the phone."
}

Write-Host "SmartCam launched over Wi-Fi debugging ($DeviceAddress). Keep Metro running." -ForegroundColor Green
