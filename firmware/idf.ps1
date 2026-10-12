# Activates ESP-IDF v5.5.5 and forwards all arguments to idf.py.
#
# ESP-IDF needs three environment variables and its own bundled Python on PATH,
# none of which persist between shells. Rather than remembering that, run:
#
#     .\idf.ps1 build
#     .\idf.ps1 -p COM5 flash monitor
#
# Equivalent to the "ESP-IDF PowerShell" shortcut, but works from any shell.
#
# Note: ErrorActionPreference is deliberately left at Continue. export.ps1 writes
# progress text to stderr, and under Windows PowerShell 5.1 a "Stop" preference
# turns that harmless output into a terminating NativeCommandError.

$env:IDF_TOOLS_PATH = "C:\Espressif"
$env:IDF_PATH       = "C:\Espressif\frameworks\esp-idf-v5.5.5"
$env:PATH           = "C:\Espressif\tools\idf-python\3.11.2;$env:PATH"

. "$env:IDF_PATH\export.ps1" 2>&1 | Out-Null

idf.py @args
