# SmartCam — wireless camera flash

A React Native camera app that fires a remote ESP32-driven LED flash over **BLE or
WiFi**, timed so the exposure lands inside the lit window regardless of how slow or
jittery the wireless link is.

## The problem

Trigger a remote flash from a phone camera app and the photograph comes out unlit.
Two delays stack between the shutter tap and the sensor exposing:

1. **Transport latency** — measured here at 9.4 ms median over WiFi, 27.0 ms over BLE.
2. **The phone's capture pipeline** — measured here at **500–850 ms**, variable shot
   to shot, and not observable from the application layer.

The second dominates by one to two orders of magnitude. **Reducing transport latency
cannot solve this**: eliminating the link entirely would remove under 3% of the total
delay.

## The approach

The app starts the camera request first and fixes the intended fire timestamp at
`camera request + Xenon flash delay`. It sends `FIRE_AT` at the latest point allowed
by the current **Lead time** (`target - lead`), sending immediately if that point
has already passed. Lead time is manual-only: RTT changes, LATE acknowledgements,
and successful captures do not change it. Changing Lead time changes dispatch time,
not the target timestamp. The default Xenon delay is 500 ms, leaving time for a
scheduled command to reach the ESP32 while calibration begins.

Calibration starts after the first valid, on-time capture and reacts to that latest
capture rather than waiting for a multi-shot average. Each capture sets a target by
comparing request-to-shutter with request-to-flash. While connected, every one-second
link-quality update reapplies the exact target from the latest valid capture; RTT
does not shift the target because scheduled `FIRE_AT` separates command delivery
from the fire timestamp. Later valid captures replace the target with their latest
timing pair. Diagnostics manual-adjustment buttons remain limited to 10 ms per press.
Late, cooldown-rejected,
unacknowledged, or reboot-crossing captures do not train it. The camera shutter
callback is an alignment proxy, not direct evidence of sensor exposure.
Diagnostics reports request-to-shutter and request-to-flash separately, alongside
ESP32 scheduling error and command-to-ACK elapsed time.
Use **Reset auto timing to default** to clear the sample window, set Xenon flash
delay to **500 ms**, clear the auto-tuned state, and hide the previous calibration
result. A fresh install also starts at 500 ms; the next confirmed, scheduled, on-time
capture starts adjusting it immediately.

Diagnostics also reports recent WiFi/BLE clock-sync RTT and probe loss, refreshed
once per second using one probe per update and a rolling window of the latest ten
quality probes. The full multi-sample clock sync remains responsible for clock
calibration; quality probes do not change the clock offset used for scheduled firing.
The starting **Lead time** is 40 ms and is manually configurable in Diagnostics; it
does not automatically react to RTT or LATE acknowledgements. Link quality is an
application-level latency/loss estimate, not a radio signal-strength or distance
measurement. Lead time controls dispatch headroom, while the Xenon delay controls
the fire target relative to the camera request. RTT can affect whether the command
arrives before its deadline, but does not otherwise shift a shot's scheduled fire
timestamp or the capture-measured Xenon alignment target.

```
tap  →  app calls takePhoto() and records camera-request time
       →  camera shutter callback records the shutter event
       →  choose fixed target T = request time + Xenon flash delay
T-lead → send FIRE_AT(T) (or send now if dispatch deadline has passed)
T    →  ESP32's hardware timer triggers or reports a rejected fire
later→  camera finishes processing and returns the photo
```

The camera shutter event, requested/actual ESP32 fire times, and camera completion
time are logged separately. ESP32 scheduling error describes device timing accuracy;
it does not by itself establish when the camera sensor exposed. Sweep Xenon flash
delay on the target phone to compare the flash event with the camera shutter callback.
An ACK only proves a response arrived: `COOLDOWN_REJECTED` explicitly means the
flash did not fire, while no ACK leaves firing status unknown.

## Android development over Wi-Fi

The Android debug app loads JavaScript from Metro, so Metro must be running on the
development PC. To use the app without a USB cable, pair the phone once from
**Developer options → Wireless debugging → Pair device with pairing code**. The
phone and PC must be on the same Wi-Fi network. In VS Code, open one terminal in
`app` and run:

```powershell
npx react-native start --port 8081
```

In a second terminal, run:

```powershell
.\android-wifi-debug.ps1
```

The helper discovers the paired phone, connects over wireless ADB, forwards
Metro's port, and launches SmartCam. If more than one phone is paired, pass the
wireless ADB `IP:PORT` shown by `adb mdns services`:

```powershell
.\android-wifi-debug.ps1 -DeviceAddress 192.168.1.25:41237
```

After a phone reboot or Wi-Fi network change, rerun the helper; wireless debugging
may advertise a new port. The debug app still needs Metro and the phone-PC Wi-Fi
connection. A standalone release build embeds JavaScript and does not need Metro.
To install an already-built debug APK over Wi-Fi as well, pass its path to the
helper:

```powershell
.\android-wifi-debug.ps1 -ApkPath .\android\app\build\outputs\apk\debug\app-debug.apk
```

## Photo storage

Each capture is kept in SmartCam's in-app gallery and copied to the Android
device photo library under **DCIM/SmartCam**. Removing a photo from SmartCam's
in-app gallery does not delete the separate copy from the phone gallery.

## Results

Measured on real hardware — full data and caveats in [`docs/measurements/`](docs/measurements/).

| Metric | WiFi | BLE |
|---|---|---|
| Round-trip time (median) | 9 429 µs | 29 504 µs |
| **Scheduling error (median)** | **85 µs** | **136 µs** |
| LATE rate | 0 | 0 |

**Tripling the link latency moved flash timing by 1.6×.** Both stay under 150 µs.

Firmware-only benchmark over 79 samples: **Pearson R² = 0.021** between round-trip
time and scheduling error — network latency explains 2.1% of the variation in flash
timing.

## Repository layout

```
firmware/       ESP-IDF firmware (C). Protocol codec, clock, scheduler,
                flash driver, BLE + WiFi transports, NVS config.
app/            Bare React Native app (TypeScript). Camera, transports,
                clock sync, capture controller, diagnostics, gallery.
protocol/       vectors.json — the frozen wire-format contract. Both the C
                and TypeScript codecs are tested against this same file.
tools/          Node UDP client for benchmarking without the phone.
docs/           Design spec, implementation plans, measurements.
sim/            Wokwi browser simulation for firmware logic.
```

## Design notes worth knowing

- **One radio at a time.** The ESP32 shares a single radio between BLE and WiFi;
  running both time-slices it and makes latency comparisons unattributable. Hold the
  BOOT button for two seconds to switch; the choice persists in NVS.
- **DC drive, not PWM.** The fitted MOSFET (FDP047AN08A0, 4.7 mΩ) has ~10 nF of gate
  capacitance, which cannot be switched cleanly at high frequency from a GPIO.
  Constant light also makes rolling-shutter banding impossible by construction.
- **Frames are ≤ 20 bytes**, under the default BLE MTU, so nothing fragments.
- **Timestamps are µs since boot**, staying under 2⁵³ so JavaScript handles them
  exactly without `BigInt`.
- **`FIRE_AT` is sent twice** with the same sequence number; the firmware
  deduplicates, so the retry is free and roughly squares delivery odds.

## Building

**Firmware** (ESP-IDF v5.3+):
```
cd firmware
./idf.ps1 build
./idf.ps1 -p COM5 flash monitor
```

**App** (JDK 17 + Android SDK):
```
cd app
npm install
npx jest              # 69 tests
./android-build.ps1   # build + install on a connected device
```

Wiring for the flasher circuit is in [`docs/hardware/`](docs/hardware/).
The user's supplied Aero Flash firmware implements a PC817-isolated manual
speedlight trigger using a fixed 500 µs pulse. See the
[external speedlight compatibility and safety note](docs/hardware/external-speedlight.md)
for protocol compatibility, firmware pin assignments, and hardware checks.
The checked-in ESP-IDF firmware is for a different LED/MOSFET board and is not
the Aero firmware. TTL, HSS, and brand-specific flash control are not supported.
