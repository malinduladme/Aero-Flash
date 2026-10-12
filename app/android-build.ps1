# Builds and installs the SmartCam app on a connected Android device.
#
#     .\android-build.ps1              # build + install debug APK
#     .\android-build.ps1 -Metro       # ...then start the Metro bundler
#     .\android-build.ps1 -Clean       # clean first (use when Gradle gets confused)
#
# Why this exists rather than `npx react-native run-android`:
#
#   1. The RN CLI invokes `gradlew.bat` bare. CMD searches the current directory
#      for executables; PowerShell does NOT, so the CLI fails with
#      "'gradlew.bat' is not recognized" even though the file is right there.
#      Calling .\gradlew.bat explicitly sidesteps it.
#
#   2. JAVA_HOME and ANDROID_HOME are set at user scope, so a shell started
#      before they were configured will not see them. Setting them here makes the
#      script work from any shell.

param(
    [switch]$Metro,
    [switch]$Clean
)

$env:JAVA_HOME    = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:PATH         = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$android = Join-Path $root "android"

Push-Location $android
try {
    if ($Clean) {
        .\gradlew.bat clean --console=plain
        if ($LASTEXITCODE -ne 0) { Write-Host "Gradle clean failed." -ForegroundColor Red; exit 1 }
    }

    $devices = @(adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\sdevice$" })
    if ($devices.Count -eq 0) {
        Write-Host "No authorised device. Check USB debugging is on and the" -ForegroundColor Red
        Write-Host "'Allow USB debugging?' prompt was accepted on the phone." -ForegroundColor Red
        Write-Host "On Xiaomi/MIUI also enable 'Install via USB' in Developer options." -ForegroundColor Yellow
        exit 1
    }

    .\gradlew.bat app:installDebug --console=plain
    if ($LASTEXITCODE -ne 0) { Write-Host "Gradle failed." -ForegroundColor Red; exit 1 }
} finally {
    Pop-Location
}

# Launch it. Without this the APK is installed but never started.
adb shell monkey -p com.smartcamapp -c android.intent.category.LAUNCHER 1 | Out-Null
Write-Host "Installed and launched." -ForegroundColor Green

if ($Metro) {
    Write-Host "Starting Metro. The app shows a red screen until this is running." -ForegroundColor Cyan
    Push-Location $root
    try { npx react-native start } finally { Pop-Location }
} else {
    Write-Host "Metro is not running. Start it with:  npx react-native start" -ForegroundColor Yellow
}
