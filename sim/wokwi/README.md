# Wokwi simulation rig

A browser-based ESP32 you can run firmware on before the hardware exists.
Free, no install, no toolchain.

## What this is

**Not a model of the flasher circuit.** It has no TP4056, no MT3608 and no MOS
module, because Wokwi has no parts for them and a fake stand-in would teach you
something false. Build the real thing from `docs/hardware/smartcam-wiring.drawio`.

This is a **code runner**. It is deliberately minimal — one LED so you can see
GPIO26 toggle, one potentiometer so you can sweep the simulated battery voltage.
Anything more just clutters the canvas without testing anything extra.

## Usage

1. <https://wokwi.com> → New Project → ESP32.
2. Open the `diagram.json` tab, `Ctrl+A`, paste this file over it.
3. Paste firmware into the code tab, press play. Serial output appears below.

Drag parts around if you want; Wokwi saves positions back into the JSON.

## What actually works here

| Plan task | Simulates? | Notes |
|---|---|---|
| Task 2 — protocol codec | **Fully** | Vector self-test prints PASS/FAIL exactly as on hardware. Pure logic. |
| Task 6 — dispatch | **Fully** | Pure logic over the codec. |
| Task 4 — flash driver | Behaviour only | Duration clamp and cooldown interlock work, and the LED shows the GPIO state. ISR timing is not faithfully modelled. |
| Task 5 — scheduler | Logic only | Dedupe, LATE path and cancel all exercise correctly. **The ±2 ms accuracy assertion is meaningless here** — that number must come from real hardware. |
| Task 9 — battery | Yes | Turn the potentiometer to sweep cell voltage and watch the low-voltage interlock engage. |
| Task 3 — clock | Smoke test | Simulated time is not wall-clock accurate. |
| Tasks 7, 8 — transports | **No** | No BLE at all, and no SoftAP. Real hardware only. |
| Tasks 11, 12 — optical rig, benchmark | **No** | Both need real hardware. |

## Differences from the real build

| Real hardware | Simulation |
|---|---|
| GPIO26 → MOSFET gate → 4-LED array | GPIO26 → 220 Ω → one LED |
| GPIO34 ← resistor divider from cell | GPIO34 ← potentiometer wiper (sweeps the full range by hand) |

The pin numbers match the real build, so firmware developed here needs no pin
changes when you move to hardware.
