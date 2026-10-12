# Shutter lag — ground truth

## Why this measurement matters

Every other number in this project measures something the software can see: network
round-trip, scheduling error, ack rates. This one measures the quantity that
motivated the entire design and that **no camera API will report** — the delay
between calling `takePhoto()` and the sensor actually exposing.

The spec's premise is that this delay is large (100–500 ms), variable shot to shot,
and unobservable from the application layer. If that is true, then reducing
transport latency could never have solved the sync problem, because the dominant
term lives inside the phone. The pre-fire lit window absorbs it; nothing else in the
design could.

This procedure tests that premise directly, with no special equipment.

## Method

A millisecond counter on a screen, photographed in a dark room with the ESP32
flasher as the only illumination. Because the LED is the sole light source, whatever
number is legible in the photograph **is** the moment of exposure. Subtract the
commanded fire time and you have true shutter lag.

Cost: nothing. Evidence: the photographs themselves, which go straight into the
report.

## Setup

1. **Millisecond counter.** Open a stopwatch showing hundredths or thousandths of a
   second, full screen, maximum brightness. <https://www.online-stopwatch.com/> works;
   so does any phone stopwatch app on a second device.
2. **Darken the room.** This is not optional. If ambient light is enough to expose
   the shot on its own, the flash contributes nothing distinguishable and the
   photograph will show a motion-blurred smear rather than a frozen number.
3. **Aim the LED array at the screen**, roughly 30–50 cm away, so the numerals are
   clearly lit when it fires.
4. **Aim the phone at the same screen**, close enough that the counter fills a good
   part of the frame.
5. **Prop both.** Handheld will not work — in a dark room the camera chooses a long
   exposure, and any movement smears the digits beyond reading.

## Procedure

1. Open the app, confirm the badge reads **flash ready**.
2. Start the stopwatch.
3. Take **ten** shots, leaving a couple of seconds between each.
4. After each shot, note the **error** and **rtt** from the on-screen readout, or
   export the CSV afterwards from the Diagnostics screen — it carries
   `t_requested_us` and `t_actual_us` per shot.
5. Open each photograph and read the counter value frozen in it.

## Reading off the lag

For each shot:

```
shutter_lag  =  counter_value_in_photo  −  stopwatch_value_when_flash_fired
```

The flash fire time is `t_actual_us` from the CSV, converted to the same timebase as
your stopwatch. In practice the simpler reading is **relative**: fire ten shots and
look at the *spread* of counter values. The spread is what
`FLASH_DURATION` has to cover, and that is the number the design actually needs.

## Results — bracketing method, 2026-08-30

The stopwatch method above was not needed. A simpler measurement gives the same
answer: sweep `FLASH_DURATION` with everything else fixed and find where the
photograph stops being flash-lit. The window closes at `leadTime + duration`, so the
failure point bounds the lag directly.

**Rig:** Samsung Galaxy A20s, WiFi transport, dark room, white A4 sheet ~30 cm from
the LED array, phone and array both propped and untouched throughout the sweep.
`leadTime` 120 ms, `aeSettle` 150 ms, so `takePhoto()` is called at t = 270 ms.

| Flash duration | Window closes | Result |
|---|---|---|
| 1000 ms | 1120 ms | **Flash-lit** — paper brilliant white, background pure black |
| 650 ms | 770 ms | Not lit — paper dull grey, room visible behind it |
| 450 ms | 570 ms | Not lit |
| 300 ms | 420 ms | Not lit |
| 200 ms | 320 ms | Not lit |

The transition lies between 650 ms and 1000 ms.

### Deriving the lag

```
exposure occurs at   270 ms + lag
650 ms fails    →   270 + lag > 770    →   lag > 500 ms
1000 ms works   →   270 + lag < 1120   →   lag < 850 ms
```

**Shutter lag on this handset: between 500 ms and 850 ms.**

Note this figure is not pure trigger-to-sensor latency. In a dark room the camera
selects a long exposure, so the measured quantity is lag *plus* integration time —
which is exactly what `FLASH_DURATION` must cover, and therefore the number the
design actually needs.

### What this establishes

Transport latency measured **9.4 ms median on WiFi** and **27.0 ms median on BLE**
(see this directory's README). Shutter lag is **500–850 ms**.

**The delay inside the phone is roughly 20 to 90 times larger than the delay on the
wireless link** — and unlike the link, it is invisible to the application layer.

That is the spec's founding premise, confirmed by measurement:

- Reducing transport latency could never have solved the sync problem. Even
  eliminating it entirely would have removed under 3% of the total delay.
- The dominant term lives inside the camera pipeline and cannot be observed, only
  absorbed.
- A lit *window* absorbs it. A lit *instant* — firing on packet arrival, as the
  original prototype did — cannot, at any transport speed.

It also explains the original prototype's behaviour precisely. Firing the flash on
command arrival puts the light hundreds of milliseconds before the exposure, so the
photograph is unlit no matter how fast the link is.

### Caveats

- The bracket is coarse: 500–850 ms, from five samples at one setting each. Tighter
  bounds would need a finer sweep (e.g. 700, 800, 900) with several shots per value.
- Lag is scene-dependent. In a bright room the camera picks a short exposure and the
  effective figure will be much smaller. This measurement is specific to the dark
  conditions the flash is designed for, which is the case that matters.
- One handset. The spec's claim that lag is 100–500 ms across devices is not tested
  here; this device sits at or above the top of that range.

## Setting FLASH_DURATION from the data

The lit window must comfortably contain the exposure:

```
FLASH_DURATION  >  (max_lag − min_lag)  +  margin
```

Use the Diagnostics screen to set it. Start at the measured spread plus 50%, then
reduce until shots begin coming out dark — the last value that is reliably lit is
your answer, and the point at which it fails is itself a result worth reporting.

`AE_SETTLE` should be set so `takePhoto()` is called at least ~min_lag before the
window closes. Too low and auto-exposure has not adapted to the lit scene; too high
and the exposure falls past the end of the window.

## Interpreting it against the rest of the data

Transport latency measured 3489 µs mean on WiFi and 27 037 µs median on BLE (see
this directory's README). If shutter lag proves to be **one to two orders of
magnitude larger and far more variable**, that is the spec's core premise confirmed:

- Latency reduction alone could never have fixed the sync problem.
- The dominant term is inside the phone and invisible to the app.
- A lit *window* absorbs it; a lit *instant* cannot.

If instead the lag turns out small and consistent, that is a genuine finding too —
it would mean this handset's camera pipeline is unusually predictable, and that a
naive `FIRE_NOW` design might have worked on it while failing on others. Either
outcome is worth reporting; only an unmeasured assumption is not.

## Resolved

An earlier revision of this document recorded that no photograph had yet come out
flash-lit. That was a setup problem, and it was resolved on 2026-08-30 in two steps:

1. **Aim.** The camera and the LED array had never been pointed at a common subject —
   every earlier attempt had the phone facing the room while the LEDs faced elsewhere.
2. **Subject.** The first properly-aimed attempts used a matte black case, which
   absorbs nearly all incident light and reflects almost none back to the lens. A
   white A4 sheet made the difference between flash-lit and ambient unmistakable.

Both are worth stating because they cost several rounds of misdiagnosis: a geometric
problem was initially mistaken for a timing one, and a poor subject choice then
masked a working system. The flash chain had been correct throughout — LEDs verified
firing, scheduling error 62–135 µs on both transports.
