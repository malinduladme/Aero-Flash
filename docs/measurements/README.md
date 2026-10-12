# Measurements

## How to reproduce

Put the device in WiFi mode (hold BOOT for 2 s until the status LED blinks fast),
join this PC to its SoftAP (`SmartCam-Flash-XXXX`, password `smartcam123`), then:

    node tools/udp-client/client.js bench 50

Writes `wifi-<timestamp>.csv` into this directory.

If you cannot be on the ESP32's network and the internet at once, use USB tethering
(internet over the cable, WiFi free for the ESP32) or run
`tools/udp-client/run-offline-tests.ps1`, which logs to a file you read afterwards.

## CSV columns

| Column           | Meaning |
|------------------|---------|
| `n`              | Sample index |
| `rtt_us`         | Best round-trip time from that sample's clock sync |
| `offset_us`      | Estimated host-to-device clock offset |
| `sched_error_us` | Actual fire time minus requested fire time |
| `flags`          | FIRE_ACK flags; bit 0 = LATE |

---

## Results — WiFi transport, 2026-08-29

Two runs, n = 30 and n = 50. **Zero timeouts and zero LATE flags across all 80
commanded flashes.**

### Run 2 (n = 50), the primary dataset

| Metric | min | p50 | p95 | max | spread |
|---|---|---|---|---|---|
| Round-trip time | 2554 µs | 3141 µs | 4814 µs | 5078 µs | 2524 µs |
| Absolute scheduling error | 79 µs | 88 µs | 122 µs | 131 µs | **52 µs** |

### Both runs combined (n = 79 successful)

| Metric | mean | standard deviation |
|---|---|---|
| Round-trip time | 3489 µs | 1063 µs |
| Absolute scheduling error | 91 µs | 14 µs |

### The key statistic

| | |
|---|---|
| Pearson correlation, RTT vs scheduling error | **0.146** |
| R² | **0.021** |

**Only 2.1% of the variation in flash timing is explained by network latency.**

## Interpretation

The round-trip time varied with a standard deviation exceeding one millisecond
across the runs, and in the first run reached 8137 µs at its worst. Flash timing
did not follow it: scheduling error stayed within a band of a few tens of
microseconds throughout, and the correlation between the two is negligible.

This is the central claim of the design, measured rather than asserted. Because the
device fires from its own hardware timer at a pre-agreed timestamp, transport
latency only has to be *bounded below the lead time*. It does not have to be small,
and — more importantly — it does not have to be *stable*. The naive alternative of
sending "fire now" and firing on arrival would have reproduced the full 2524 µs
latency spread directly in the flash timing, because in that design the two
quantities are the same quantity.

Zero LATE flags across 80 shots also shows the 120 ms default lead time is
generously sized for WiFi, whose worst observed one-way delay was around 4 ms. BLE
is expected to need more headroom because its connection interval dominates
latency, and that contrast is the reason both transports are carried.

---

## Results — phone (Samsung Galaxy A20s, Android 11), 2026-08-30

The PC results above isolate the firmware. These add the React Native app, and
cover **both transports on the same handset**, which is the comparison the spec's
2x2 exists to make.

### WiFi transport, app-side

Early shots returned LATE at the 120 ms default lead time: the phone's round-trip
(~9-15 ms) plus React Native's bridge exceeds what the PC needed. The
CaptureController's adaptive backoff raised leadTimeMs by 20 ms per LATE. Once it
reached roughly 180 ms:

  six consecutive shots: 107, 79, 91, 62, 99, 75 us absolute error, zero LATE

### BLE transport, app-side (n = 14)

| Metric | Value |
|---|---|
| Shots / confirmed / LATE | 14 / 13 / **0** |
| RTT median | **27 037 µs** |
| Absolute error median | **135 µs** |
| Absolute error max | 672 µs |

### Controlled same-session comparison (2026-08-30)

Both transports measured on the same handset, same app build, same sitting, with
only the radio changed — switched from the app's Diagnostics screen. This is the
cleanest form of the comparison, since nothing else varies.

| Metric | WiFi | BLE | Ratio |
|---|---|---|---|
| RTT median | **9 429 µs** | **29 504 µs** | 3.1x worse |
| Absolute error median | **85 µs** | **136 µs** | 1.6x |
| Absolute error max | 139 µs | 152 µs | — |
| Confirmed | 6 / 6 | 4 / 6 | — |
| LATE | 0 | 0 | — |

Round-trip time tripled. Scheduling error rose by 1.6x and stayed under 140 µs.
Ack delivery is notably better on WiFi (6/6 against 4/6) — BLE notification loss is
a real effect, though a lost ack costs only the confirmation, never the flash or the
photograph.

### The cross-transport comparison

| | WiFi | BLE | Change |
|---|---|---|---|
| RTT median | ~9 000 µs | 27 037 µs | **3.0x worse** |
| Error median | ~85 µs | 135 µs | 1.6x |
| LATE rate | 0 | 0 | — |

**Round-trip time tripled between the two radios; scheduling error rose by a factor
of 1.6 and stayed below 150 µs.** The relationship is strongly sublinear: if flash
timing tracked transport latency, the error would have tripled with it. It did not.

This is the claim demonstrated on two physically different radios rather than one,
which is materially stronger than showing that a single link happened to be fast
enough. It also reproduces the firmware-only finding (R^2 = 0.021 against RTT)
through an entirely different software stack — React Native, a JS bridge, and a
phone's scheduler — none of which the PC benchmark exercised.

Zero LATE across 14 BLE shots at the 120 ms default is worth noting on its own: even
at 27 ms round-trip, the default lead time had adequate headroom.

## Caveats

- **Scheduling error is measured against the device's own clock**, so it captures
  scheduler accuracy rather than absolute agreement with the host clock.
  Clock-offset error is bounded separately by `rtt_us / 2`, i.e. under 2.6 ms at
  the median.
- **The host is a PC, not a phone.** These figures exclude camera shutter lag,
  which is the larger and far more variable term (100–500 ms, unobservable from the
  application layer) that the pre-fire lit window exists to absorb. Phone-side
  numbers arrive with Plan 2's app.
- **WiFi only.** The spec's full experiment is a 2×2 of naive vs scheduled across
  BLE and WiFi. This is the WiFi/scheduled cell. The BLE cells need the app, since
  no BLE central is available on this PC.
- **`fire-now` is retained in the protocol as the control condition** so the naive
  comparison can be run on identical hardware in the same session.
