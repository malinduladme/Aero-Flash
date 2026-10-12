# SmartCam Flash Firmware

ESP-IDF **v5.5.5**, installed at `C:\Espressif`.

## Build and flash

`idf.py` only exists inside an activated ESP-IDF environment, and that activation
does not persist between shells. `idf.ps1` handles it, so any shell works:

    .\idf.ps1 build
    .\idf.ps1 -p COM5 flash
    .\idf.ps1 -p COM5 monitor

This board enumerates as **COM5** (Silicon Labs CP210x bridge). Check Device
Manager under "Ports (COM & LPT)" if that ever changes.

**Run one `idf.ps1` command per shell invocation.** Chaining two in the same
PowerShell session re-runs the activation and corrupts the virtualenv lookup,
producing a misleading "not spawned within an ESP-IDF shell environment" error.

## Reading serial without the monitor

`idf.py monitor` is interactive and blocks. To capture a boot log
non-interactively — useful for reading the self-test PASS/FAIL lines — open the
port, pulse RTS to reset the board, and read for a few seconds:

    $p = New-Object System.IO.Ports.SerialPort("COM5",115200,"None",8,"One")
    $p.Open(); $p.DtrEnable=$false; $p.RtsEnable=$true
    Start-Sleep -Milliseconds 120; $p.RtsEnable=$false
    Start-Sleep -Seconds 3; $p.ReadExisting(); $p.Close()

## Pin map

| Function             | Pin    |
|----------------------|--------|
| LED gate (MOSFET)    | GPIO26 |
| Battery sense        | GPIO34 |
| Mode button (BOOT)   | GPIO0  |
| Status LED (onboard) | GPIO2  |

GPIO 5, 12 and 15 are strapping pins — leave them unloaded.

Wiring for the external circuit is in `docs/hardware/smartcam-wiring.drawio`.

## Configuration notes

`sdkconfig.defaults` sets 4 MB flash size and Boya chip support because this
board has both; without them every boot logs two warnings that would clutter the
serial output the self-tests are read from. `sdkconfig` itself is generated —
delete it and rebuild to pick up changes to the defaults.
