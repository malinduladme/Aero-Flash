# SmartCam — Wireless Flash Trigger: Design Specification

**Date:** 2026-08-26
**Status:** Approved design, ready for implementation planning

---

## 1. Problem statement

A mobile camera application must trigger a remote, battery-powered LED flash unit
over a wireless link at the moment a photograph is taken.

A previous prototype failed: the flash did not coincide with the shutter. The root
cause is that two independent delays stack between the user's tap and the sensor
exposure:

1. **Transport latency** — BLE roughly 30–100 ms, WiFi UDP roughly 5–15 ms.
2. **The phone's capture pipeline** — after `takePhoto()` is called, the camera
   stack runs autofocus and auto-exposure convergence and queues the request
   through the camera HAL. Real shutter lag is typically 100–500 ms and varies
   shot to shot. It is neither observable nor removable from a cross-platform
   application layer.

The second delay dominates and is the reason latency reduction alone cannot solve
the problem. Even at zero transport latency, firing at the instant of the tap
misses the exposure.

A second, initially hidden defect follows from the same cause: a flash that fires
simultaneously with exposure is metered against a *dark* scene, so even a
perfectly timed shot is overexposed.

**Design response.** Fire the flash *before* the capture and hold it lit for a
window long enough to contain the exposure. The shot must land somewhere inside a
300 ms window rather than on a 1 ms target. This resolves sync and metering
together.

---

## 2. Scope

**In scope**

- React Native (bare) camera application, Android and iOS capable.
- ESP32 firmware for a single flash unit, addressable protocol so multiple units
  need no redesign.
- Two selectable transports — BLE and WiFi — with one shared wire protocol.
- Clock synchronisation and scheduled ("fire at time T") triggering.
- On-device latency measurement and CSV export for the project report.

**Out of scope**

- Multiple simultaneous flash units (protocol supports it; hardware and firmware
  fan-out are not built).
- Cloud connectivity, MQTT, remote configuration.
- Photo editing, gallery management beyond saving the captured image.

**Recorded assumptions** (correct these if wrong; they affect scope, not
architecture)

- No macOS machine is available, so the demonstrable target is Android. The
  codebase remains iOS-capable, and this is stated as such rather than claimed as
  a working iOS build.
- A conventional final-year timeline of several months, part-time.
- No grading criterion mandates a specific wireless technology.

---

## 3. Architecture

```
┌─────────────── React Native app (Android / iOS) ──────────────┐
│  UI: camera preview · settings · diagnostics                  │
│                        ↓                                      │
│  CaptureController  ── orchestrates the shot sequence          │
│         ↓                          ↓                          │
│  ClockSync                   FlashTransport «interface»        │
│                               ↙              ↘                │
│                       BleTransport      WifiTransport          │
└───────────────────────────┬───────────────────────────────────┘
                            │  identical binary frames
              BLE GATT write │ or │ UDP datagram
                            ↓
┌──────────────── ESP32 DevKit V1 firmware ─────────────────────┐
│  transport_ble  ─┐                                            │
│                  ├→ protocol → scheduler → flash_driver       │
│  transport_wifi ─┘              ↑              ↓              │
│                              clock      GPIO gate → MOSFET → LED
│  config (NVS: mode, brightness, duration)                     │
└───────────────────────────────────────────────────────────────┘
```

**Transport selection is mode-switched, never concurrent.** The ESP32 has a
single radio shared between BLE and WiFi; running both time-slices that radio,
degrading latency and jitter on both and making measurements unattributable. The
device boots into exactly one mode, persisted in NVS and changed by the onboard
button or a `SET_MODE` command.

### 3.1 Firmware modules

| Module | Responsibility | Depends on |
|---|---|---|
| `protocol` | Encode/decode command frames. Pure logic, no I/O. | — |
| `clock` | Monotonic microsecond time; holds phone↔device offset. | `esp_timer` |
| `scheduler` | "Fire at time T": waits until T, then invokes the driver. | `clock`, `flash_driver` |
| `flash_driver` | GPIO on/off, on-duration, safety interlocks. | driver/gpio |
| `transport_ble` | GATT server: one write characteristic in, one notify out. | `protocol` |
| `transport_wifi` | SoftAP plus UDP socket on a fixed port. | `protocol` |
| `config` | Persists mode, brightness, default duration in NVS. | NVS |

`protocol`, `clock` and `scheduler` contain the non-trivial logic and touch no
radio, so they are unit-testable off-device. Both transports are deliberately
thin — they move bytes only — which is what makes the second transport cheap.

### 3.2 Application modules

| Module | Responsibility |
|---|---|
| `transport/FlashTransport.ts` | Interface: `connect()`, `send(frame)`, `onFrame(cb)`, `disconnect()` |
| `transport/BleTransport.ts` | BLE implementation via `react-native-ble-plx` |
| `transport/WifiTransport.ts` | UDP implementation via `react-native-udp` |
| `protocol/frames.ts` | TypeScript mirror of the firmware codec |
| `sync/ClockSync.ts` | Sync handshake, offset and RTT estimation |
| `capture/CaptureController.ts` | Shot sequence: schedule fire → wait → `takePhoto()` |
| `telemetry/LatencyLog.ts` | Per-shot timings, CSV export |

**Stack:** bare React Native (not Expo Go — BLE and camera are native modules),
TypeScript, `react-native-vision-camera`, `react-native-ble-plx`,
`react-native-udp`.

---

## 4. Timing model

The central idea is to **convert a latency problem into a deadline problem**. The
app does not send "fire now"; it sends "fire at time T" with T slightly in the
future. Transport jitter then becomes irrelevant provided the command arrives
before its deadline, and the ESP32 fires from its own hardware timer with roughly
±1 ms accuracy, independent of the network.

### 4.1 Clock synchronisation

Cristian's algorithm over whichever transport is active:

```
app: t0 = now()             ──SYNC_REQ──►
                                          esp: t_dev = esp_timer_get_time()
app: t1 = now()             ◄─SYNC_RESP(t_dev, session_id)─
     rtt    = t1 - t0
     offset = t_dev - (t0 + rtt/2)
```

Eleven exchanges are performed and the sample with the **smallest RTT** is
selected — not the mean. The fastest exchange is the least polluted by queuing
delay; this is the standard NTP technique and is materially more robust than
averaging. Crystal drift between the two boards is roughly 20–50 ppm, so the
handshake repeats on connect and every 30 s, holding error below one millisecond.

### 4.2 Shot sequence

```
t=0ms    user taps shutter
         app sends FIRE_AT(T = now + LEAD_TIME, duration, brightness)  ──►
         command travels while nothing time-critical is happening

t=120ms  ESP32's local timer fires  ──► LED ON      (jitter absorbed)
t=270ms  app calls takePhoto()      ← scene already lit
t≈270–420ms  the real exposure occurs somewhere in this span
t=420ms  LED OFF by the same local timer  (no second command required)
```

The exposure lands inside the lit window instead of on an instant. Sync no longer
requires knowing the phone's shutter lag, only that it is bounded by the window;
and auto-exposure meters an already-lit scene, so the image is correctly exposed.

### 4.3 Tunable parameters

| Parameter | Default | Trade-off |
|---|---|---|
| `LEAD_TIME` | 120 ms | Must exceed worst-case one-way latency. Too low → missed deadlines; too high → laggy feel |
| `FLASH_DURATION` | 300 ms | Must cover the shutter-lag spread. Too long → wasted energy, LED heat |
| `AE_SETTLE` | 150 ms | Delay from fire to `takePhoto()`. Too low → AE has not adapted |

Brightness is not a software parameter; it is set in hardware on the MT3608 trimpot.
The protocol's `brightness` field is reserved and ignored by the firmware.

These are exposed on a diagnostics screen and are the instrument of the
experiment: sweeping `AE_SETTLE` establishes the minimum reliable value per
handset, and sweeping `LEAD_TIME` against measured latency shows why each
transport needs the headroom it needs.

### 4.4 Missed deadlines

If a command arrives after T, the device fires immediately and sets the `LATE`
flag in its acknowledgement. The app logs the event and raises `LEAD_TIME` by
20 ms, capped at 400 ms. Behaviour degrades to the naive case rather than
dropping the shot, and the `LATE` rate becomes a measured quantity per transport.

### 4.5 Safety interlocks

Implemented in `flash_driver` and mandatory on a Li-ion supply:

- **Maximum duration** 1000 ms — longer requests are clamped and flagged.
- **Minimum cooldown** 500 ms between fires, enforcing LED duty cycle.
- **Hardware watchdog timer** that forces the LED off independently of the main
  loop. A stalled firmware holding a 3 W LED on will overheat the emitter and
  drain the cell.

---

## 5. Wire protocol

One binary format, byte-identical across both transports. BLE characteristic
writes and UDP datagrams both preserve message boundaries, so no length prefix or
delimiter framing is required.

**Header — 4 bytes, little-endian throughout:**

```
byte 0    VERSION   0x01
byte 1    TYPE      opcode
byte 2-3  SEQ       uint16, echoed in the response
byte 4..  PAYLOAD   opcode-specific
```

**Commands (app → device)**

| Op | Name | Payload |
|---|---|---|
| `0x01` | `SYNC_REQ` | — |
| `0x02` | `FIRE_AT` | `uint64 t_fire_us`, `uint16 duration_ms`, `uint8 brightness` |
| `0x03` | `FIRE_NOW` | `uint16 duration_ms`, `uint8 brightness` |
| `0x04` | `CANCEL` | — cancels a pending scheduled fire |
| `0x05` | `GET_STATUS` | — |
| `0x06` | `SET_CONFIG` | `uint16 default_duration`, `uint8 brightness` (persisted to NVS) |
| `0x07` | `SET_MODE` | `uint8 mode` (0 = BLE, 1 = WiFi); persists, then reboots into that radio |

**Responses (device → app)**

| Op | Name | Payload |
|---|---|---|
| `0x81` | `SYNC_RESP` | `uint64 t_dev_us`, `uint32 session_id` |
| `0x82` | `FIRE_ACK` | `uint64 t_actual_us`, `uint32 session_id`, `uint8 flags` |
| `0x83` | `STATUS` | `uint8 mode`, `uint32 session_id`, `uint16 battery_mv`, `uint8 flags`, `uint32 uptime_s`, `uint8 fw_ver` |
| `0x84` | `ERROR` | `uint8 code` |

`FIRE_ACK` flags: bit 0 `LATE`, bit 1 `DURATION_CLAMPED`, bit 2
`COOLDOWN_REJECTED`.

### 5.1 Protocol design notes

- **`FIRE_NOW` is retained deliberately** as the experimental control condition.
  It reproduces the original prototype's behaviour, so naive and scheduled
  triggering can be compared on identical hardware within one application.
- **Every frame fits in 20 bytes.** The largest are `FIRE_ACK` and `STATUS` at 17
  bytes each; `FIRE_AT` is 15. All are below the 23-byte default BLE MTU, so no
  MTU negotiation and no fragmentation occurs on any handset. Frames must not grow
  past this limit without deliberate reconsideration.
- **Timestamps are microseconds since boot, not Unix epoch.** This keeps values
  below 2^53, so JavaScript's `number` represents them exactly and `BigInt` is
  unnecessary in the TypeScript codec. Epoch microseconds would exceed that and
  silently lose precision.
- **`session_id` is a random `uint32` generated at boot.** Because device
  timestamps are relative to boot, an unnoticed reset would invalidate the app's
  offset and cause flashes to fire at grossly wrong times with no error surfaced.
  The app compares `session_id` on every response and re-syncs when it changes.
  This matters most on WiFi, where UDP is connectionless and a reboot is otherwise
  invisible.
- **`FIRE_AT` is transmitted twice.** UDP may drop, and BLE
  write-without-response offers no delivery guarantee. The device deduplicates on
  `SEQ`, making the retry idempotent and approximately squaring the miss
  probability for the cost of one extra packet.

### 5.2 BLE binding

- Custom 128-bit service UUID, generated once and fixed in both codebases.
- RX characteristic: **write without response** — write-with-response would add a
  full round trip to every trigger.
- TX characteristic: notify.
- The device advertises a preferred connection interval of 7.5–15 ms; the app
  calls `requestConnectionPriority(HIGH)` on Android. Connection interval is the
  dominant term in BLE latency.

### 5.3 WiFi binding

- ESP32 runs SoftAP `SmartCam-Flash-XXXX`, WPA2 secured.
- Device at the fixed SoftAP gateway address `192.168.4.1`, UDP port `4210`.
- UDP rather than TCP: TCP retransmission and Nagle buffering introduce exactly
  the unpredictable delay the design exists to eliminate.
- No mDNS discovery is required, as the gateway address is fixed.

---

## 6. Error handling

| Failure | Detection | Response |
|---|---|---|
| Not connected at shutter tap | Transport state | Take the photo regardless; badge the UI "flash unavailable". The camera is never blocked on the accessory |
| Command misses its deadline | `LATE` flag | Fire immediately; raise `LEAD_TIME` by 20 ms (cap 400 ms); log |
| `FIRE_ACK` lost | Ack timeout of `LEAD_TIME + duration + 200 ms` | Mark the shot unconfirmed, keep the photo. Never re-fire — the picture already exists |
| Device rebooted mid-session | `session_id` changed | Invalidate offset, re-run clock sync before the next shot |
| Clock drift | 30 s periodic re-sync | Discard sync samples whose RTT is an outlier |
| Shutter tapped during cooldown | App-side cooldown timer | Disable the shutter for the cooldown; firmware `COOLDOWN_REJECTED` is the backstop |
| Battery low | `battery_mv` in `STATUS` | Warn below 3.4 V; refuse to fire below 3.1 V, protecting the cell and holding brightness constant across an experiment |
| Thermal overload | Sliding-window on-time accumulator in firmware | Refuse further fires until it decays. No temperature sensor required |
| App backgrounded | Lifecycle event | Cancel pending fires, release the camera, drop the transport |

**Android SoftAP routing.** When the phone joins the ESP32's access point,
Android detects that the network lacks internet access and may route UDP traffic
over mobile data instead. The WiFi transport then appears connected while nothing
arrives. The remedy is `ConnectivityManager.requestNetwork()` with a
`NetworkSpecifier` naming the SSID, followed by `bindProcessToNetwork()`. This is
the highest-risk integration item in the project and should be scheduled with
slack.

---

## 7. Hardware design

### 7.1 Power chain

```
18650 Li-ion (3.0–4.2 V)
   ├── TP4056 + DW01A module  → USB charging and over-discharge protection
   ├── MT3608 boost → 5.0 V ──→ ESP32 VIN
   └── LED rail ──→ constant-current driver ──→ LED ──→ MOSFET ──→ GND
```

The ESP32 DevKit V1's AMS1117 regulator requires roughly 4.5 V or more on VIN,
while a Li-ion cell falls from 4.2 V to 3.0 V. Powering VIN directly from the cell
works when freshly charged and then brown-outs as it discharges. The boost
converter is required, not optional.

The TP4056 module must be the variant **with** DW01A + FS8205 protection; the bare
version will discharge the cell below 2.5 V and damage it permanently.

### 7.2 LED drive

**A constant-current driver is required, not a series resistor.** With a resistor,
LED current tracks cell voltage, so flash brightness falls measurably as the
battery discharges. For this project that is not merely cosmetic: brightness
becomes an uncontrolled variable drifting across a test session and contaminating
every measurement. A CC driver (AMC7135 modules or a small buck CC board) holds
current constant from 4.2 V down to cut-off.

**The LED is driven at DC, not PWM.** Phone cameras use rolling shutter, reading
the sensor line by line at roughly 15 µs per line. Any PWM slow enough to drive
comfortably would expose different lines during different parts of the duty cycle,
producing horizontal banding across the photograph. Constant illumination removes
that failure mode by construction: there is no duty cycle for the sensor to beat
against.

An earlier revision of this spec specified 100 kHz PWM at 9-bit resolution to
outrun the line rate. That was written before the MOSFET was identified and is
withdrawn — see below.

**MOSFET.** The build uses the FDP047AN08A0 already fitted to the red "MOS Module"
breakout: an onsemi PowerTrench device rated 75 V, ~80 A, 4.7 mΩ. Strictly it is
not a logic-level part — on-resistance is specified at Vgs = 10 V and the gate
threshold falls in the 2–4 V band — but it is so heavily overspecced for a ~1 A
load that even partial enhancement at 3.3 V leaves on-resistance in the tens of
milliohms, which is negligible here. Verify once at bring-up by measuring V_DS with
the LED lit: below 0.3 V confirms adequate enhancement.

**Why that MOSFET forecloses PWM.** A 4.7 mΩ device has a large die and therefore a
large gate — input capacitance on the order of 10 nF, against roughly 0.4 nF for a
small logic-level part. At 100 kHz each cycle lasts 10 µs, and charging a 10 nF gate
through the module's series gate resistor takes a comparable time, so the gate never
reaches a clean high or low and the device dwells in its linear region dissipating
heat rather than switching. The better MOSFET is precisely what makes
high-frequency PWM impractical. DC drive avoids the problem entirely and plays to
the part's strength: it switches twice per photograph instead of thirty thousand
times.

**Brightness is set in hardware**, once, via the MT3608's trimpot, rather than in
software. The protocol retains its `brightness` field as reserved so the wire format
is unaffected, but the firmware ignores its value. A flash needs one correct
exposure level, not a continuously variable one.

### 7.3 Pin assignment

| Function | Pin | Rationale |
|---|---|---|
| LED gate drive | GPIO26 | Not a strapping pin, no boot-time conflict, pulldown-capable |
| Battery sense | GPIO34 | **Must be ADC1.** ADC2 is unusable while WiFi is active, which would break battery reporting in exactly one of the two modes |
| Mode switch button | GPIO0 | The onboard BOOT button, reusable after startup; no additional parts |
| Status indicator | GPIO2 | Onboard LED; slow blink = BLE, fast blink = WiFi |
| Phototransistor (test rig) | GPIO35 | ADC1, used for Tier 2 hardware-in-the-loop verification |

GPIO 5, 12 and 15 are strapping pins and must be left unloaded; a load on them can
prevent the board from booting.

### 7.4 Robustness measures

1. **100 kΩ pulldown on the MOSFET gate**, plus a 100 Ω series gate resistor.
   During boot the GPIO floats, and a floating gate can partially enable the
   MOSFET, producing a spurious flash at power-up and heating the device. The
   series resistor damps ringing on the switching edges — which matter more here
   than switching *rate*, since the FDP047AN08A0's large gate charge makes each
   individual edge slow and current-hungry.
2. **470–1000 µF bulk capacitor across the LED rail.** Switching roughly 700 mA in
   nanoseconds sags the boost converter output, and that dip can reset the ESP32 —
   the cause of the classic "board reboots whenever the flash fires" symptom.
3. **Star ground at the battery terminal.** The LED's ground return and the
   ESP32's ground must meet at the same physical point rather than daisy-chaining,
   otherwise the LED's current surge shifts the ESP32's ground reference and
   corrupts ADC readings.
4. **Thermal mounting.** A 3 W LED at a 300 ms burst with a 500 ms enforced
   cooldown reaches a worst-case duty cycle near 37%. This requires an aluminium
   plate or small heatsink; bare PCB mounting is inadequate.

---

## 8. Testing and measurement

### 8.1 Tier 1 — off-device unit tests

- **Shared codec vectors.** A single JSON file of frame/bytes pairs executed by
  both the C and the TypeScript test suites. This catches endianness and
  struct-padding divergence between firmware and app, which would otherwise
  surface as erratic mistimed flashes rather than as an obvious decode failure.
- **`ClockSync`** — synthetic RTT samples; assert minimum-RTT selection and offset
  arithmetic.
- **`scheduler`** — fake clock; assert fire-at-T accuracy, the late-arrival path,
  and cancellation.
- **`flash_driver`** — assert duration clamping, cooldown enforcement, watchdog.

### 8.2 Tier 2 — hardware in the loop

A phototransistor on GPIO35 observes the LED, allowing firmware to report actual
light-on time against commanded time. This validates the device half of the system
independently of any phone.

### 8.3 Tier 3 — ground truth

To measure when exposure actually occurred, display a millisecond-resolution timer
on a screen, darken the room, and photograph it using the flash. Because the LED
is the only illumination, the legible number *is* the moment of exposure.
Subtracting the fire timestamp yields true shutter lag, using no special equipment
and producing a photograph as direct evidence for the report.

### 8.4 Principal experiment

|  | BLE | WiFi |
|---|---|---|
| `FIRE_NOW` (naive) | n = 50 | n = 50 |
| `FIRE_AT` (scheduled) | n = 50 | n = 50 |

Measured per cell: percentage of correctly lit shots, exposure correctness, `LATE`
rate, and RTT distribution.

The expected finding — that naive triggering fails frequently and unpredictably
while scheduled triggering approaches complete reliability on *both* transports —
is a stronger result than a simple latency comparison, because it demonstrates
that the architecture solved the problem rather than that one radio happens to be
faster.

### 8.5 Acceptance criteria

- At least 95% correctly lit shots in scheduled mode on both transports.
- Median round-trip time: BLE under 60 ms, WiFi under 20 ms.
- `LATE` rate under 2% at the default `LEAD_TIME`.
- Zero ESP32 resets across 200 consecutive flashes.
- At least 500 flashes per battery charge.

---

## 9. Key design decisions

| Decision | Rationale |
|---|---|
| Pre-fire lit window rather than instantaneous sync | Phone shutter lag is 100–500 ms, variable and unobservable. A window contains it; an instant cannot |
| Scheduled `FIRE_AT` rather than `FIRE_NOW` | Converts a latency problem into a deadline problem, so jitter is absorbed rather than fought |
| Mode-switched transports rather than concurrent | The ESP32 has one radio; concurrency degrades both transports and makes measurements unattributable |
| High-power LED rather than a xenon speedlight | A ~1 ms xenon burst reintroduces the millisecond-target problem that the window design removes |
| UDP rather than TCP | TCP retransmission and Nagle buffering add unpredictable delay |
| Timestamps in µs since boot | Stays within JavaScript's exact-integer range; avoids `BigInt` in the codec |
| Constant-current LED drive | Keeps brightness independent of battery state, so it is not a confounding variable |
| DC drive rather than PWM | Constant light cannot beat against the rolling shutter, so banding is impossible by construction; and the fitted FDP047AN08A0's ~10 nF gate cannot be switched cleanly at 100 kHz from a GPIO |
| Brightness fixed in hardware | Set once on the MT3608 trimpot. A flash needs one correct exposure level, and this removes brightness as a confounding variable across a test session |
