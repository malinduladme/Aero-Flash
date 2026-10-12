# External speedlight compatibility

SmartCam's wireless `FIRE_AT` command is brand-neutral: it schedules an output
event and does not use a flash manufacturer's digital protocol. The user-provided
Aero Flash firmware identifies itself as ESP32-C3 SuperMini firmware and
implements the SmartCam protocol, BLE service/characteristic UUIDs, BLE device
name, and WiFi UDP endpoint expected by the app. It drives GPIO4 to trigger a
PC817 optocoupler for a fixed 500 µs pulse. GPIO3 is the shutter input.

This means the app and the supplied firmware are protocol-compatible. A manual
speedlight such as the Godox TT520 II can be triggered if that firmware is the
firmware actually installed on the Aero PCB and the optocoupler output is
correctly wired to the flash's sync input.

## Hardware safety

The PC817 separates the ESP32-side input from the flash-side output only when the
circuit is wired correctly. Do not connect the flash hot shoe or sync contacts
directly to an ESP32 GPIO. Confirm the exact PC817 part's output voltage/current
ratings and the flash sync voltage, along with the PCB schematic and isolation
clearances, before connecting the flash. This repository does not contain the
Aero PCB schematic, so this document cannot verify its output-side wiring or
electrical ratings.

The supplied brief disagreed about GPIO3 versus GPIO4. The supplied firmware
resolves the intended assignments as GPIO4 for PC817 input and GPIO3 for the
shutter button. Confirm that the firmware matches the actual PCB revision before
use.

## Timing and supported features

The Aero firmware ignores the app's `duration_ms` and `brightness` values for
output control and always emits its fixed 500 µs trigger pulse. In the app,
**Flash duration** is therefore not a speedlight pulse-width setting. **Xenon
flash delay** and **Lead time** affect when the `FIRE_AT` event is scheduled;
tune them empirically for the camera and flash setup.

This provides basic manual sync only. SmartCam does not implement
manufacturer-specific TTL metering, HSS, remote power/zoom control, or radio
pairing with a Godox transmitter/receiver.
