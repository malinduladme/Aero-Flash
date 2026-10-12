# SmartCam Firmware & Protocol — Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build ESP32 firmware that fires a high-power LED at a precisely scheduled instant, commanded over either BLE or WiFi, verified end-to-end without any phone application.

**Architecture:** A pure-C `protocol` codec is shared by two thin transports (BLE GATT, WiFi UDP), which feed a `scheduler` that fires `flash_driver` from a local hardware timer. Because the device fires off its own timer rather than on packet arrival, network jitter never reaches the LED. Only one radio runs at a time — the ESP32 has a single radio, and time-slicing it would degrade and confound both transports.

**Tech Stack:** ESP-IDF v5.3+ (C99, NimBLE, GPIO, esp_timer, NVS), Node.js 24 for the host-side UDP test client, nRF Connect (Android/iOS app) for BLE verification.

**Spec:** `docs/superpowers/specs/2026-08-26-smartcam-flash-design.md`

## Global Constraints

- **Protocol version byte is `0x01`.** Every frame begins with it.
- **All multi-byte fields are little-endian.**
- **No frame may exceed 20 bytes.** Largest are `FIRE_ACK` and `STATUS` at 17 bytes. This keeps every frame under the 23-byte default BLE MTU, so no MTU negotiation and no fragmentation occurs on any handset.
- **Timestamps are `uint64` microseconds since boot**, never Unix epoch. This keeps values below 2^53 so the TypeScript codec in Plan 2 can use `number` exactly, without `BigInt`.
- **`session_id` is a random `uint32` regenerated at every boot** and included in `SYNC_RESP`, `FIRE_ACK` and `STATUS`.
- **The LED is switched DC, not PWM.** Constant light cannot beat against the phone's rolling shutter, so banding is impossible by construction. The fitted MOSFET is an FDP047AN08A0 (75 V, 80 A, 4.7 mΩ) whose ~10 nF gate cannot be switched cleanly at high frequency from a GPIO. Brightness is set in hardware on the MT3608 trimpot; the protocol's `brightness` field is **reserved and ignored by firmware**.
- **Pin assignment is fixed:** GPIO26 = LED gate drive, GPIO34 = battery sense (ADC1 — ADC2 is unusable while WiFi is active), GPIO0 = mode button (onboard BOOT), GPIO2 = status LED (onboard), GPIO35 = phototransistor (ADC1).
- **Safety interlocks are mandatory:** max duration 1000 ms, minimum cooldown 500 ms, hardware watchdog forcing LED off.
- **Firmware version byte (`fw_ver`) is `0x01`** for all of Plan 1.

---

## File Structure

```
protocol/
  vectors.json              Canonical frame/bytes contract. Authored once from
                            the spec; consumed by BOTH the C self-test and the
                            TypeScript tests in Plan 2. Single source of truth.

firmware/
  CMakeLists.txt            ESP-IDF project root
  sdkconfig.defaults        NimBLE on, 160MHz, brownout tuned
  main/
    CMakeLists.txt
    main.c                  Boot, mode selection, module wiring. No logic.
  components/
    protocol/               Pure C99, zero ESP dependencies. Encode/decode only.
      include/protocol.h
      protocol.c
      vectors_embedded.h    Generated from protocol/vectors.json at build time
      protocol_selftest.c   Runs vectors at boot, logs PASS/FAIL
    clk/                    Monotonic µs time + session_id
      include/clk.h
      clk.c
    flash_driver/           GPIO on/off, duration, interlocks, watchdog
      include/flash_driver.h
      flash_driver.c
    scheduler/              "Fire at T" — the timing core
      include/scheduler.h
      scheduler.c
    config_store/           NVS persistence for mode/brightness/duration
      include/config_store.h
      config_store.c
    battery/                ADC1 sampling + voltage conversion
      include/battery.h
      battery.c
    transport_ble/          NimBLE GATT server. Byte movement only.
      include/transport_ble.h
      transport_ble.c
    transport_wifi/         SoftAP + UDP socket. Byte movement only.
      include/transport_wifi.h
      transport_wifi.c
  tools/
    gen_vectors.js          vectors.json -> vectors_embedded.h

tools/
  udp-client/
    package.json
    client.js               Node CLI: sync, fire-at, fire-now, status over UDP
```

**Boundary rationale:** `protocol`, `clk`, `flash_driver` and `scheduler` hold all the interesting logic and touch no radio. Both transports are deliberately dumb — they receive bytes, hand them to `protocol`, and write bytes back. That asymmetry is what makes adding the second transport cheap, and it is why a bug in BLE cannot produce different flash timing than the same bug in WiFi.

---

## Task 1: Toolchain, project skeleton, and blink

**Files:**
- Create: `firmware/CMakeLists.txt`, `firmware/sdkconfig.defaults`, `firmware/main/CMakeLists.txt`, `firmware/main/main.c`
- Create: `firmware/README.md`

**Interfaces:**
- Consumes: nothing
- Produces: a buildable, flashable ESP-IDF project. Later tasks add components under `firmware/components/`.

This task is hardware and toolchain bring-up, so its verification is observational rather than a unit test. Every later task is test-first.

- [ ] **Step 1: Install ESP-IDF**

Download and run the **ESP-IDF Windows Installer (offline, v5.3 or newer)** from
https://dl.espressif.com/dl/esp-idf/ — choose the ESP32 target. It bundles Python, CMake, Ninja and the Xtensa toolchain, so none of the missing tools need installing separately.

After installation, use the **"ESP-IDF PowerShell"** shortcut it creates. `idf.py` only exists inside that shell.

Verify:
```
idf.py --version
```
Expected: `ESP-IDF v5.3` or newer.

- [ ] **Step 2: Create the project root CMakeLists**

`firmware/CMakeLists.txt`:
```cmake
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(smartcam_flash)
```

- [ ] **Step 3: Create sdkconfig defaults**

`firmware/sdkconfig.defaults`:
```
CONFIG_IDF_TARGET="esp32"
CONFIG_ESP_MAIN_TASK_STACK_SIZE=8192
CONFIG_FREERTOS_HZ=1000
CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_160=y

# NimBLE is far smaller than Bluedroid and gives direct control over
# connection interval, which dominates BLE latency.
CONFIG_BT_ENABLED=y
CONFIG_BT_NIMBLE_ENABLED=y
CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1

# The LED current surge can dip the rail; keep brownout detection on but
# at the lowest threshold so a legitimate flash does not reset the board.
CONFIG_ESP_BROWNOUT_DET=y
CONFIG_ESP_BROWNOUT_DET_LVL_SEL_2=y

# Lets the flash off-timer run from the timer ISR rather than a task, so no
# amount of task starvation can leave the LED array switched on.
CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=y
```

- [ ] **Step 4: Create main component**

`firmware/main/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "main.c"
                       INCLUDE_DIRS ".")
```

`firmware/main/main.c`:
```c
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_log.h"

static const char *TAG = "main";

#define PIN_STATUS_LED 2

void app_main(void)
{
    ESP_LOGI(TAG, "SmartCam flash unit booting, fw_ver=0x01");

    gpio_config_t io = {
        .pin_bit_mask = 1ULL << PIN_STATUS_LED,
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&io));

    while (1) {
        gpio_set_level(PIN_STATUS_LED, 1);
        vTaskDelay(pdMS_TO_TICKS(500));
        gpio_set_level(PIN_STATUS_LED, 0);
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
```

- [ ] **Step 5: Build and flash**

From the ESP-IDF PowerShell, in `firmware/`:
```
idf.py set-target esp32
idf.py build
idf.py -p COM3 flash monitor
```
Replace `COM3` with the port shown in Device Manager under "Ports (COM & LPT)". If no port appears, install the CP210x or CH340 USB driver — DevKit V1 boards use one or the other.

Expected: serial log shows `SmartCam flash unit booting, fw_ver=0x01` and the onboard blue LED blinks once per second. Exit the monitor with `Ctrl+]`.

- [ ] **Step 6: Write firmware README**

`firmware/README.md`:
```markdown
# SmartCam Flash Firmware

## Prerequisites
ESP-IDF v5.3+ (Windows offline installer). Use the "ESP-IDF PowerShell" shortcut.

## Build and flash
    idf.py set-target esp32
    idf.py build
    idf.py -p COM3 flash monitor

## Pin map
| Function            | Pin    |
|---------------------|--------|
| LED gate (MOSFET)   | GPIO26 |
| Battery sense       | GPIO34 |
| Mode button (BOOT)  | GPIO0  |
| Status LED (onboard)| GPIO2  |
| Phototransistor     | GPIO35 |

GPIO 5, 12 and 15 are strapping pins — leave them unloaded.
```

- [ ] **Step 7: Commit**

```bash
git add firmware/ .gitignore
git commit -m "feat(firmware): ESP-IDF skeleton with status LED blink"
```

---

## Task 2: Protocol vectors and C codec

**Files:**
- Create: `protocol/vectors.json`
- Create: `firmware/components/protocol/include/protocol.h`
- Create: `firmware/components/protocol/protocol.c`
- Create: `firmware/components/protocol/protocol_selftest.c`
- Create: `firmware/components/protocol/CMakeLists.txt`
- Create: `firmware/tools/gen_vectors.js`
- Modify: `firmware/main/main.c`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `proto_frame_t` struct, `proto_op_t` enum, `proto_err_t` enum
  - `proto_err_t proto_decode(const uint8_t *buf, size_t len, proto_frame_t *out)`
  - `int proto_encode(const proto_frame_t *f, uint8_t *buf, size_t cap)` — returns byte count, or `-1` on failure
  - `bool proto_selftest_run(void)` — runs embedded vectors, logs each, returns overall pass
  - `protocol/vectors.json` — the frame/bytes contract that Plan 2's TypeScript codec must also satisfy

- [ ] **Step 1: Author the vector contract**

This file is the single source of truth for the wire format. Both the C and (in Plan 2) TypeScript codecs are tested against it. Byte strings are space-separated lowercase hex.

`protocol/vectors.json`:
```json
{
  "protocol_version": 1,
  "note": "Canonical frame/bytes contract. Little-endian. Header: ver(1) op(1) seq(2).",
  "vectors": [
    {
      "name": "sync_req",
      "direction": "app_to_device",
      "frame": { "op": "SYNC_REQ", "seq": 1 },
      "bytes": "01 01 01 00"
    },
    {
      "name": "fire_at",
      "direction": "app_to_device",
      "frame": { "op": "FIRE_AT", "seq": 258, "t_fire_us": 4886718345, "duration_ms": 300, "brightness": 255 },
      "bytes": "01 02 02 01 89 67 45 23 01 00 00 00 2c 01 ff"
    },
    {
      "name": "fire_now",
      "direction": "app_to_device",
      "frame": { "op": "FIRE_NOW", "seq": 7, "duration_ms": 300, "brightness": 128 },
      "bytes": "01 03 07 00 2c 01 80"
    },
    {
      "name": "cancel",
      "direction": "app_to_device",
      "frame": { "op": "CANCEL", "seq": 9 },
      "bytes": "01 04 09 00"
    },
    {
      "name": "get_status",
      "direction": "app_to_device",
      "frame": { "op": "GET_STATUS", "seq": 10 },
      "bytes": "01 05 0a 00"
    },
    {
      "name": "set_config",
      "direction": "app_to_device",
      "frame": { "op": "SET_CONFIG", "seq": 11, "default_duration_ms": 300, "brightness": 200 },
      "bytes": "01 06 0b 00 2c 01 c8"
    },
    {
      "name": "set_mode_wifi",
      "direction": "app_to_device",
      "frame": { "op": "SET_MODE", "seq": 12, "mode": 1 },
      "bytes": "01 07 0c 00 01"
    },
    {
      "name": "sync_resp",
      "direction": "device_to_app",
      "frame": { "op": "SYNC_RESP", "seq": 1, "t_dev_us": 4886718345, "session_id": 3735928559 },
      "bytes": "01 81 01 00 89 67 45 23 01 00 00 00 ef be ad de"
    },
    {
      "name": "fire_ack_ok",
      "direction": "device_to_app",
      "frame": { "op": "FIRE_ACK", "seq": 258, "t_actual_us": 4886718345, "session_id": 3735928559, "flags": 0 },
      "bytes": "01 82 02 01 89 67 45 23 01 00 00 00 ef be ad de 00"
    },
    {
      "name": "fire_ack_late",
      "direction": "device_to_app",
      "frame": { "op": "FIRE_ACK", "seq": 259, "t_actual_us": 4886718345, "session_id": 3735928559, "flags": 1 },
      "bytes": "01 82 03 01 89 67 45 23 01 00 00 00 ef be ad de 01"
    },
    {
      "name": "status",
      "direction": "device_to_app",
      "frame": { "op": "STATUS", "seq": 10, "mode": 0, "session_id": 3735928559, "battery_mv": 3900, "flags": 0, "uptime_s": 42, "fw_ver": 1 },
      "bytes": "01 83 0a 00 00 ef be ad de 3c 0f 00 2a 00 00 00 01"
    },
    {
      "name": "error_bad_opcode",
      "direction": "device_to_app",
      "frame": { "op": "ERROR", "seq": 13, "code": 3 },
      "bytes": "01 84 0d 00 03"
    }
  ]
}
```

Verify by hand that `fire_at` is 15 bytes and `fire_ack_ok` and `status` are 17 — the global 20-byte ceiling depends on it.

- [ ] **Step 2: Write the vector-to-header generator**

`firmware/tools/gen_vectors.js`:
```js
// Converts protocol/vectors.json into a C header of raw byte arrays so the
// firmware can self-test its codec on-device. Run from the repo root:
//   node firmware/tools/gen_vectors.js
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'protocol', 'vectors.json');
const dst = path.join(__dirname, '..', 'components', 'protocol', 'vectors_embedded.h');

const doc = JSON.parse(fs.readFileSync(src, 'utf8'));

let out = '// GENERATED by firmware/tools/gen_vectors.js - DO NOT EDIT\n';
out += '#pragma once\n#include <stdint.h>\n#include <stddef.h>\n\n';
out += 'typedef struct { const char *name; const uint8_t *bytes; size_t len; } proto_vector_t;\n\n';

doc.vectors.forEach((v, i) => {
  const bytes = v.bytes.trim().split(/\s+/).map(b => '0x' + b);
  out += `static const uint8_t vec_${i}_bytes[] = { ${bytes.join(', ')} };\n`;
});

out += '\nstatic const proto_vector_t proto_vectors[] = {\n';
doc.vectors.forEach((v, i) => {
  out += `    { "${v.name}", vec_${i}_bytes, sizeof(vec_${i}_bytes) },\n`;
});
out += '};\n\n';
out += `#define PROTO_VECTOR_COUNT ${doc.vectors.length}\n`;

fs.writeFileSync(dst, out);
console.log(`Wrote ${doc.vectors.length} vectors to ${dst}`);
```

Run it:
```
node firmware/tools/gen_vectors.js
```
Expected: `Wrote 12 vectors to ...vectors_embedded.h`

- [ ] **Step 3: Write the failing self-test**

The self-test decodes each vector's bytes, re-encodes the resulting struct, and asserts the bytes round-trip identically. This catches endianness and field-order errors, which are the failures that would otherwise show up as erratic flash timing rather than as an obvious decode error.

`firmware/components/protocol/protocol_selftest.c`:
```c
#include <string.h>
#include "esp_log.h"
#include "protocol.h"
#include "vectors_embedded.h"

static const char *TAG = "proto_test";

bool proto_selftest_run(void)
{
    bool all_ok = true;

    for (size_t i = 0; i < PROTO_VECTOR_COUNT; i++) {
        const proto_vector_t *v = &proto_vectors[i];
        proto_frame_t f;
        uint8_t buf[PROTO_MAX_FRAME];

        proto_err_t err = proto_decode(v->bytes, v->len, &f);
        if (err != PROTO_OK) {
            ESP_LOGE(TAG, "FAIL %-16s decode err=%d", v->name, err);
            all_ok = false;
            continue;
        }

        int n = proto_encode(&f, buf, sizeof(buf));
        if (n < 0 || (size_t)n != v->len || memcmp(buf, v->bytes, v->len) != 0) {
            ESP_LOGE(TAG, "FAIL %-16s roundtrip mismatch (got %d bytes, want %u)",
                     v->name, n, (unsigned)v->len);
            all_ok = false;
            continue;
        }

        ESP_LOGI(TAG, "PASS %-16s %u bytes", v->name, (unsigned)v->len);
    }

    /* Negative cases: malformed input must be rejected, not silently accepted. */
    proto_frame_t f;
    const uint8_t too_short[] = { 0x01, 0x01 };
    if (proto_decode(too_short, sizeof(too_short), &f) != PROTO_ERR_SHORT) {
        ESP_LOGE(TAG, "FAIL short-frame not rejected");
        all_ok = false;
    }
    const uint8_t bad_version[] = { 0x02, 0x01, 0x01, 0x00 };
    if (proto_decode(bad_version, sizeof(bad_version), &f) != PROTO_ERR_VERSION) {
        ESP_LOGE(TAG, "FAIL bad-version not rejected");
        all_ok = false;
    }
    const uint8_t bad_opcode[] = { 0x01, 0x7f, 0x01, 0x00 };
    if (proto_decode(bad_opcode, sizeof(bad_opcode), &f) != PROTO_ERR_OPCODE) {
        ESP_LOGE(TAG, "FAIL bad-opcode not rejected");
        all_ok = false;
    }
    const uint8_t truncated_fire_at[] = { 0x01, 0x02, 0x01, 0x00, 0x89, 0x67 };
    if (proto_decode(truncated_fire_at, sizeof(truncated_fire_at), &f) != PROTO_ERR_LENGTH) {
        ESP_LOGE(TAG, "FAIL truncated payload not rejected");
        all_ok = false;
    }

    ESP_LOGI(TAG, "===== SELFTEST %s =====", all_ok ? "PASS" : "FAIL");
    return all_ok;
}
```

- [ ] **Step 4: Write the header**

`firmware/components/protocol/include/protocol.h`:
```c
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define PROTO_VERSION    0x01
#define PROTO_MAX_FRAME  20
#define PROTO_HDR_LEN    4

typedef enum {
    OP_SYNC_REQ   = 0x01,
    OP_FIRE_AT    = 0x02,
    OP_FIRE_NOW   = 0x03,
    OP_CANCEL     = 0x04,
    OP_GET_STATUS = 0x05,
    OP_SET_CONFIG = 0x06,
    OP_SET_MODE   = 0x07,
    OP_SYNC_RESP  = 0x81,
    OP_FIRE_ACK   = 0x82,
    OP_STATUS     = 0x83,
    OP_ERROR      = 0x84,
} proto_op_t;

/* FIRE_ACK flag bits */
#define ACK_FLAG_LATE               (1u << 0)
#define ACK_FLAG_DURATION_CLAMPED   (1u << 1)
#define ACK_FLAG_COOLDOWN_REJECTED  (1u << 2)

/* ERROR codes */
#define PROTO_ERRCODE_SHORT    1
#define PROTO_ERRCODE_VERSION  2
#define PROTO_ERRCODE_OPCODE   3
#define PROTO_ERRCODE_LENGTH   4
#define PROTO_ERRCODE_BATTERY  5
#define PROTO_ERRCODE_THERMAL  6

typedef enum {
    PROTO_OK = 0,
    PROTO_ERR_SHORT,
    PROTO_ERR_VERSION,
    PROTO_ERR_OPCODE,
    PROTO_ERR_LENGTH,
} proto_err_t;

typedef struct {
    uint8_t  op;
    uint16_t seq;
    union {
        struct { uint64_t t_fire_us; uint16_t duration_ms; uint8_t brightness; } fire_at;
        struct { uint16_t duration_ms; uint8_t brightness; } fire_now;
        struct { uint16_t default_duration_ms; uint8_t brightness; } set_config;
        struct { uint8_t mode; } set_mode;
        struct { uint64_t t_dev_us; uint32_t session_id; } sync_resp;
        struct { uint64_t t_actual_us; uint32_t session_id; uint8_t flags; } fire_ack;
        struct {
            uint8_t  mode;
            uint32_t session_id;
            uint16_t battery_mv;
            uint8_t  flags;
            uint32_t uptime_s;
            uint8_t  fw_ver;
        } status;
        struct { uint8_t code; } error;
    } u;
} proto_frame_t;

proto_err_t proto_decode(const uint8_t *buf, size_t len, proto_frame_t *out);

/* Returns encoded length, or -1 if the frame does not fit in cap. */
int proto_encode(const proto_frame_t *f, uint8_t *buf, size_t cap);

bool proto_selftest_run(void);
```

- [ ] **Step 5: Register the component and run to verify it fails**

`firmware/components/protocol/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "protocol.c" "protocol_selftest.c"
                       INCLUDE_DIRS "include" ".")
```

Build now, with `protocol.c` not yet written:
```
idf.py build
```
Expected: FAIL — linker errors for undefined `proto_decode` and `proto_encode`.

- [ ] **Step 6: Implement the codec**

Explicit byte-at-a-time serialisation is used rather than `memcpy` of packed structs. It costs a few lines and removes any dependence on compiler struct layout or host endianness — the exact class of bug the vectors exist to catch.

`firmware/components/protocol/protocol.c`:
```c
#include <string.h>
#include "protocol.h"

static uint16_t rd_u16(const uint8_t *p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}
static uint32_t rd_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8)
         | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint64_t rd_u64(const uint8_t *p) {
    return (uint64_t)rd_u32(p) | ((uint64_t)rd_u32(p + 4) << 32);
}
static void wr_u16(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)(v); p[1] = (uint8_t)(v >> 8);
}
static void wr_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v);       p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
static void wr_u64(uint8_t *p, uint64_t v) {
    wr_u32(p, (uint32_t)(v & 0xFFFFFFFFu));
    wr_u32(p + 4, (uint32_t)(v >> 32));
}

/* Payload length for each opcode, or -1 if the opcode is unknown. */
static int payload_len(uint8_t op)
{
    switch (op) {
    case OP_SYNC_REQ:   return 0;
    case OP_FIRE_AT:    return 11;  /* u64 + u16 + u8 */
    case OP_FIRE_NOW:   return 3;   /* u16 + u8 */
    case OP_CANCEL:     return 0;
    case OP_GET_STATUS: return 0;
    case OP_SET_CONFIG: return 3;   /* u16 + u8 */
    case OP_SET_MODE:   return 1;
    case OP_SYNC_RESP:  return 12;  /* u64 + u32 */
    case OP_FIRE_ACK:   return 13;  /* u64 + u32 + u8 */
    case OP_STATUS:     return 13;  /* u8 + u32 + u16 + u8 + u32 + u8 */
    case OP_ERROR:      return 1;
    default:            return -1;
    }
}

proto_err_t proto_decode(const uint8_t *buf, size_t len, proto_frame_t *out)
{
    if (len < PROTO_HDR_LEN) return PROTO_ERR_SHORT;
    if (buf[0] != PROTO_VERSION) return PROTO_ERR_VERSION;

    int plen = payload_len(buf[1]);
    if (plen < 0) return PROTO_ERR_OPCODE;
    if (len != (size_t)(PROTO_HDR_LEN + plen)) return PROTO_ERR_LENGTH;

    memset(out, 0, sizeof(*out));
    out->op  = buf[1];
    out->seq = rd_u16(&buf[2]);

    const uint8_t *p = &buf[PROTO_HDR_LEN];
    switch (out->op) {
    case OP_FIRE_AT:
        out->u.fire_at.t_fire_us   = rd_u64(p);
        out->u.fire_at.duration_ms = rd_u16(p + 8);
        out->u.fire_at.brightness  = p[10];
        break;
    case OP_FIRE_NOW:
        out->u.fire_now.duration_ms = rd_u16(p);
        out->u.fire_now.brightness  = p[2];
        break;
    case OP_SET_CONFIG:
        out->u.set_config.default_duration_ms = rd_u16(p);
        out->u.set_config.brightness          = p[2];
        break;
    case OP_SET_MODE:
        out->u.set_mode.mode = p[0];
        break;
    case OP_SYNC_RESP:
        out->u.sync_resp.t_dev_us   = rd_u64(p);
        out->u.sync_resp.session_id = rd_u32(p + 8);
        break;
    case OP_FIRE_ACK:
        out->u.fire_ack.t_actual_us = rd_u64(p);
        out->u.fire_ack.session_id  = rd_u32(p + 8);
        out->u.fire_ack.flags       = p[12];
        break;
    case OP_STATUS:
        out->u.status.mode       = p[0];
        out->u.status.session_id = rd_u32(p + 1);
        out->u.status.battery_mv = rd_u16(p + 5);
        out->u.status.flags      = p[7];
        out->u.status.uptime_s   = rd_u32(p + 8);
        out->u.status.fw_ver     = p[12];
        break;
    case OP_ERROR:
        out->u.error.code = p[0];
        break;
    default:
        break; /* zero-payload opcodes */
    }
    return PROTO_OK;
}

int proto_encode(const proto_frame_t *f, uint8_t *buf, size_t cap)
{
    int plen = payload_len(f->op);
    if (plen < 0) return -1;

    size_t total = PROTO_HDR_LEN + (size_t)plen;
    if (total > cap || total > PROTO_MAX_FRAME) return -1;

    buf[0] = PROTO_VERSION;
    buf[1] = f->op;
    wr_u16(&buf[2], f->seq);

    uint8_t *p = &buf[PROTO_HDR_LEN];
    switch (f->op) {
    case OP_FIRE_AT:
        wr_u64(p, f->u.fire_at.t_fire_us);
        wr_u16(p + 8, f->u.fire_at.duration_ms);
        p[10] = f->u.fire_at.brightness;
        break;
    case OP_FIRE_NOW:
        wr_u16(p, f->u.fire_now.duration_ms);
        p[2] = f->u.fire_now.brightness;
        break;
    case OP_SET_CONFIG:
        wr_u16(p, f->u.set_config.default_duration_ms);
        p[2] = f->u.set_config.brightness;
        break;
    case OP_SET_MODE:
        p[0] = f->u.set_mode.mode;
        break;
    case OP_SYNC_RESP:
        wr_u64(p, f->u.sync_resp.t_dev_us);
        wr_u32(p + 8, f->u.sync_resp.session_id);
        break;
    case OP_FIRE_ACK:
        wr_u64(p, f->u.fire_ack.t_actual_us);
        wr_u32(p + 8, f->u.fire_ack.session_id);
        p[12] = f->u.fire_ack.flags;
        break;
    case OP_STATUS:
        p[0] = f->u.status.mode;
        wr_u32(p + 1, f->u.status.session_id);
        wr_u16(p + 5, f->u.status.battery_mv);
        p[7] = f->u.status.flags;
        wr_u32(p + 8, f->u.status.uptime_s);
        p[12] = f->u.status.fw_ver;
        break;
    case OP_ERROR:
        p[0] = f->u.error.code;
        break;
    default:
        break;
    }
    return (int)total;
}
```

- [ ] **Step 7: Call the self-test from main**

Replace the body of `app_main` in `firmware/main/main.c` (keep the includes, add `#include "protocol.h"`):
```c
void app_main(void)
{
    ESP_LOGI(TAG, "SmartCam flash unit booting, fw_ver=0x01");

    gpio_config_t io = {
        .pin_bit_mask = 1ULL << PIN_STATUS_LED,
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&io));

    bool ok = proto_selftest_run();

    while (1) {
        /* Fast blink signals a self-test failure, so a bad build is
           obvious from across the bench without a serial monitor. */
        gpio_set_level(PIN_STATUS_LED, 1);
        vTaskDelay(pdMS_TO_TICKS(ok ? 500 : 100));
        gpio_set_level(PIN_STATUS_LED, 0);
        vTaskDelay(pdMS_TO_TICKS(ok ? 500 : 100));
    }
}
```

Add `protocol` to `firmware/main/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "main.c"
                       INCLUDE_DIRS "."
                       REQUIRES protocol)
```

- [ ] **Step 8: Build, flash, verify the tests pass**

```
idf.py build && idf.py -p COM3 flash monitor
```
Expected: twelve `PASS` lines, one per vector, then `===== SELFTEST PASS =====`, and a slow blink.

- [ ] **Step 9: Commit**

```bash
git add protocol/ firmware/
git commit -m "feat(protocol): frame codec with on-device vector self-test"
```

---

## Task 3: Clock and session identity

**Files:**
- Create: `firmware/components/clk/include/clk.h`, `firmware/components/clk/clk.c`, `firmware/components/clk/CMakeLists.txt`
- Modify: `firmware/main/main.c`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `void clk_init(void)` — seeds `session_id` from hardware RNG
  - `uint64_t clk_now_us(void)` — monotonic microseconds since boot
  - `uint32_t clk_session_id(void)`
  - `uint32_t clk_uptime_s(void)`

- [ ] **Step 1: Write the failing test**

Create `firmware/components/clk/clk_selftest.c`:
```c
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "clk.h"

static const char *TAG = "clk_test";

bool clk_selftest_run(void)
{
    bool ok = true;

    if (clk_session_id() == 0) {
        ESP_LOGE(TAG, "FAIL session_id is zero (RNG not seeded?)");
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS session_id=0x%08x", (unsigned)clk_session_id());
    }

    /* Monotonicity: time must strictly advance across a known delay,
       and the measured interval must be within 5% of the requested one. */
    uint64_t t0 = clk_now_us();
    vTaskDelay(pdMS_TO_TICKS(100));
    uint64_t t1 = clk_now_us();
    int64_t delta_us = (int64_t)(t1 - t0);

    if (delta_us < 95000 || delta_us > 105000) {
        ESP_LOGE(TAG, "FAIL 100ms delay measured as %lld us", (long long)delta_us);
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS 100ms delay measured as %lld us", (long long)delta_us);
    }

    ESP_LOGI(TAG, "===== CLK SELFTEST %s =====", ok ? "PASS" : "FAIL");
    return ok;
}
```

- [ ] **Step 2: Write the header**

`firmware/components/clk/include/clk.h`:
```c
#pragma once
#include <stdint.h>
#include <stdbool.h>

void     clk_init(void);
uint64_t clk_now_us(void);
uint32_t clk_session_id(void);
uint32_t clk_uptime_s(void);
bool     clk_selftest_run(void);
```

- [ ] **Step 3: Run to verify it fails**

`firmware/components/clk/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "clk.c" "clk_selftest.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_timer esp_hw_support)
```
Add `clk` to the main component's `REQUIRES`, call `clk_init()` then `clk_selftest_run()` in `app_main` before the blink loop, and build:
```
idf.py build
```
Expected: FAIL — undefined references to `clk_init`, `clk_now_us`, `clk_session_id`, `clk_uptime_s`.

- [ ] **Step 4: Implement**

`firmware/components/clk/clk.c`:
```c
#include "esp_timer.h"
#include "esp_random.h"
#include "clk.h"

static uint32_t s_session_id;

void clk_init(void)
{
    /* Regenerated every boot. The app compares this on every response; a
       change means the device reset and its timebase restarted at zero,
       so any offset the app holds is stale and must be re-synced. */
    do {
        s_session_id = esp_random();
    } while (s_session_id == 0);   /* zero is reserved for "unknown" */
}

uint64_t clk_now_us(void)
{
    return (uint64_t)esp_timer_get_time();
}

uint32_t clk_session_id(void)
{
    return s_session_id;
}

uint32_t clk_uptime_s(void)
{
    return (uint32_t)(clk_now_us() / 1000000ULL);
}
```

- [ ] **Step 5: Build, flash, verify it passes**

```
idf.py build && idf.py -p COM3 flash monitor
```
Expected: `PASS session_id=0x...` (non-zero, and different on each reboot — press EN and confirm it changes), `PASS 100ms delay measured as ~100000 us`, `===== CLK SELFTEST PASS =====`.

- [ ] **Step 6: Commit**

```bash
git add firmware/components/clk firmware/main
git commit -m "feat(clk): monotonic microsecond clock and per-boot session id"
```

---

## Task 4: Flash driver with safety interlocks

**Files:**
- Create: `firmware/components/flash_driver/include/flash_driver.h`, `flash_driver.c`, `flash_selftest.c`, `CMakeLists.txt`
- Modify: `firmware/main/main.c`

**Interfaces:**
- Consumes: `clk_now_us()` from Task 3
- Produces:
  - `void flash_init(void)`
  - `flash_result_t flash_fire(uint16_t duration_ms, uint8_t brightness)` — returns a struct carrying `t_actual_us` and `flags` (`ACK_FLAG_DURATION_CLAMPED`, `ACK_FLAG_COOLDOWN_REJECTED`)
  - `bool flash_is_on(void)`
  - `typedef struct { uint64_t t_actual_us; uint8_t flags; bool fired; } flash_result_t;`

**Spec §4.5 is now fully satisfied.** An earlier revision of this plan recorded a
deviation here: the spec asks for a watchdog that forces the LED off independently
of the main loop, but `ledc_set_duty()` is not ISR-safe, so the off-timer had to run
as a task rather than in the timer interrupt.

Moving to DC drive removes that constraint. `gpio_set_level()` **is** IRAM-safe, so
the off-timer now uses `ESP_TIMER_ISR` dispatch and fires from the timer interrupt
itself. Nothing short of a halted CPU can leave the LED array energised — no task
starvation, no priority inversion, no scheduler dependency. Two safeguards remain in
addition: the timer is armed *before* the LED is switched on, so a failed arm means
the LED never lights; and the GPIO is configured with a pulldown so a floating gate
through boot cannot part-enable the MOSFET.

This requires `CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=y`, added to
`sdkconfig.defaults` in Task 1. The ISR callback must stay IRAM-safe: no logging, no
allocation, no non-IRAM calls inside it.

- [ ] **Step 1: Write the failing test**

`firmware/components/flash_driver/flash_selftest.c`:
```c
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "flash_driver.h"
#include "protocol.h"

static const char *TAG = "flash_test";

bool flash_selftest_run(void)
{
    bool ok = true;

    /* A normal short fire must succeed and report no flags. */
    flash_result_t r = flash_fire(50, 255);
    if (!r.fired || r.flags != 0) {
        ESP_LOGE(TAG, "FAIL normal fire: fired=%d flags=0x%02x", r.fired, r.flags);
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS normal fire");
    }

    /* Firing again immediately must be rejected by the cooldown interlock. */
    r = flash_fire(50, 255);
    if (r.fired || !(r.flags & ACK_FLAG_COOLDOWN_REJECTED)) {
        ESP_LOGE(TAG, "FAIL cooldown not enforced: fired=%d flags=0x%02x", r.fired, r.flags);
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS cooldown enforced");
    }

    /* After the cooldown elapses, firing must work again. */
    vTaskDelay(pdMS_TO_TICKS(FLASH_COOLDOWN_MS + 50));
    r = flash_fire(50, 255);
    if (!r.fired) {
        ESP_LOGE(TAG, "FAIL fire after cooldown rejected");
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS fire after cooldown");
    }

    /* An over-long duration must be clamped, not honoured — an unbounded
       on-time would cook the LED and drain the cell. */
    vTaskDelay(pdMS_TO_TICKS(FLASH_COOLDOWN_MS + 50));
    r = flash_fire(5000, 255);
    if (!r.fired || !(r.flags & ACK_FLAG_DURATION_CLAMPED)) {
        ESP_LOGE(TAG, "FAIL duration not clamped: flags=0x%02x", r.flags);
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS duration clamped to %d ms", FLASH_MAX_DURATION_MS);
    }

    /* The LED must switch itself off when the duration expires. */
    vTaskDelay(pdMS_TO_TICKS(FLASH_MAX_DURATION_MS + 100));
    if (flash_is_on()) {
        ESP_LOGE(TAG, "FAIL LED still on after duration expired");
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS LED auto-off");
    }

    ESP_LOGI(TAG, "===== FLASH SELFTEST %s =====", ok ? "PASS" : "FAIL");
    return ok;
}
```

- [ ] **Step 2: Write the header**

`firmware/components/flash_driver/include/flash_driver.h`:
```c
#pragma once
#include <stdint.h>
#include <stdbool.h>

#define FLASH_MAX_DURATION_MS  1000
#define FLASH_COOLDOWN_MS      500
#define PIN_LED_GATE           26

typedef struct {
    uint64_t t_actual_us;   /* when the LED actually turned on */
    uint8_t  flags;         /* ACK_FLAG_* bits from protocol.h */
    bool     fired;
} flash_result_t;

void           flash_init(void);

/* `brightness` is accepted for wire-format compatibility and IGNORED. The LED
   is driven DC; its level is set in hardware on the MT3608 trimpot. Keeping the
   parameter means scheduler and dispatch need no change if software dimming is
   ever reintroduced via a gate driver. */
flash_result_t flash_fire(uint16_t duration_ms, uint8_t brightness);
bool           flash_is_on(void);
bool           flash_selftest_run(void);
```

- [ ] **Step 3: Run to verify it fails**

`firmware/components/flash_driver/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "flash_driver.c" "flash_selftest.c"
                       INCLUDE_DIRS "include"
                       REQUIRES driver esp_timer esp_common clk protocol)
```
Add `flash_driver` to main's `REQUIRES`, call `flash_init()` and `flash_selftest_run()` in `app_main`, and build:
```
idf.py build
```
Expected: FAIL — undefined references to `flash_init`, `flash_fire`, `flash_is_on`.

- [ ] **Step 4: Implement**

`firmware/components/flash_driver/flash_driver.c`:
```c
#include "driver/gpio.h"
#include "esp_timer.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "flash_driver.h"
#include "protocol.h"
#include "clk.h"

static const char *TAG = "flash";

static esp_timer_handle_t s_off_timer;
static volatile bool      s_on;
static volatile uint64_t  s_last_fire_end_us;

/* Runs in ISR context: only IRAM-safe calls, and no logging. */
static void IRAM_ATTR off_timer_cb(void *arg)
{
    (void)arg;
    gpio_set_level(PIN_LED_GATE, 0);
    s_on = false;
    s_last_fire_end_us = (uint64_t)esp_timer_get_time();
}

void flash_init(void)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << PIN_LED_GATE,
        .mode         = GPIO_MODE_OUTPUT,
        /* Held low through boot so a floating gate cannot part-enable the
           MOSFET and fire the LED at power-up. */
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&io));
    gpio_set_level(PIN_LED_GATE, 0);

    const esp_timer_create_args_t targs = {
        .callback = off_timer_cb,
        .name     = "flash_off",
        /* ISR dispatch, not task dispatch. gpio_set_level() is IRAM-safe, so
           the off edge fires from the timer interrupt itself and cannot be
           delayed or starved by any application task. This is the hardware
           watchdog the spec requires: nothing short of a halted CPU can leave
           a 3 W LED array energised. Requires
           CONFIG_ESP_TIMER_SUPPORTS_ISR_DISPATCH_METHOD=y. */
        .dispatch_method = ESP_TIMER_ISR,
    };
    ESP_ERROR_CHECK(esp_timer_create(&targs, &s_off_timer));

    s_on = false;
    s_last_fire_end_us = 0;
    ESP_LOGI(TAG, "flash init: GPIO%d, DC drive, ISR-dispatched auto-off", PIN_LED_GATE);
}

flash_result_t flash_fire(uint16_t duration_ms, uint8_t brightness)
{
    flash_result_t r = { .t_actual_us = 0, .flags = 0, .fired = false };
    uint64_t now = clk_now_us();

    if (s_on) {
        r.flags |= ACK_FLAG_COOLDOWN_REJECTED;
        return r;
    }
    if (s_last_fire_end_us != 0 &&
        (now - s_last_fire_end_us) < (uint64_t)FLASH_COOLDOWN_MS * 1000ULL) {
        r.flags |= ACK_FLAG_COOLDOWN_REJECTED;
        return r;
    }

    if (duration_ms > FLASH_MAX_DURATION_MS) {
        duration_ms = FLASH_MAX_DURATION_MS;
        r.flags |= ACK_FLAG_DURATION_CLAMPED;
    }
    if (duration_ms == 0) duration_ms = 1;

    (void)brightness;   /* DC drive; level is set on the MT3608 trimpot */

    /* Arm the off-timer BEFORE switching on. If arming fails the LED must
       never have been lit — an LED with no scheduled off is exactly the
       failure that destroys the emitter. */
    esp_timer_stop(s_off_timer);
    esp_err_t err = esp_timer_start_once(s_off_timer, (uint64_t)duration_ms * 1000ULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "off-timer arm failed (%d); refusing to fire", err);
        return r;
    }

    gpio_set_level(PIN_LED_GATE, 1);
    s_on = true;
    r.t_actual_us = clk_now_us();
    r.fired = true;
    return r;
}

bool flash_is_on(void)
{
    return s_on;
}
```

- [ ] **Step 5: Build, flash, verify it passes**

Connect the LED, MOSFET and pulldown per the spec first, or observe with a multimeter on GPIO26.
```
idf.py build && idf.py -p COM3 flash monitor
```
Expected: `PASS normal fire`, `PASS cooldown enforced`, `PASS fire after cooldown`, `PASS duration clamped to 1000 ms`, `PASS LED auto-off`, `===== FLASH SELFTEST PASS =====`. Visually: three short flashes then one one-second flash.

- [ ] **Step 6: Commit**

```bash
git add firmware/components/flash_driver firmware/main
git commit -m "feat(flash): DC gate driver with cooldown, clamp and ISR auto-off"
```

---

## Task 5: Scheduler — fire at a future timestamp

**Files:**
- Create: `firmware/components/scheduler/include/scheduler.h`, `scheduler.c`, `scheduler_selftest.c`, `CMakeLists.txt`
- Modify: `firmware/main/main.c`

**Interfaces:**
- Consumes: `clk_now_us()` (Task 3), `flash_fire()` (Task 4)
- Produces:
  - `void sched_init(void)`
  - `void sched_fire_at(uint64_t t_fire_us, uint16_t duration_ms, uint8_t brightness, uint16_t seq, sched_ack_cb_t cb)`
  - `void sched_cancel(void)`
  - `bool sched_is_duplicate(uint16_t seq)` — the `SEQ` dedupe that makes the doubled `FIRE_AT` idempotent
  - `typedef void (*sched_ack_cb_t)(uint16_t seq, uint64_t t_actual_us, uint8_t flags);`

This is the heart of the design: the device fires from its own timer, so transport jitter cannot reach the LED.

- [ ] **Step 1: Write the failing test**

`firmware/components/scheduler/scheduler_selftest.c`:
```c
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "scheduler.h"
#include "clk.h"
#include "protocol.h"

static const char *TAG = "sched_test";

static volatile uint64_t s_cb_t_actual;
static volatile uint8_t  s_cb_flags;
static volatile uint16_t s_cb_seq;
static volatile int      s_cb_count;

static void test_ack(uint16_t seq, uint64_t t_actual_us, uint8_t flags)
{
    s_cb_seq = seq;
    s_cb_t_actual = t_actual_us;
    s_cb_flags = flags;
    s_cb_count++;
}

bool sched_selftest_run(void)
{
    bool ok = true;

    /* Scheduling 200ms out must fire within 2ms of the requested instant.
       This tolerance is the whole premise of the design: if local timer
       accuracy were not far better than network jitter, scheduling would
       buy nothing over firing on arrival. */
    s_cb_count = 0;
    uint64_t target = clk_now_us() + 200000ULL;
    sched_fire_at(target, 50, 255, 100, test_ack);
    vTaskDelay(pdMS_TO_TICKS(400));

    if (s_cb_count != 1) {
        ESP_LOGE(TAG, "FAIL expected 1 ack, got %d", s_cb_count);
        ok = false;
    } else {
        int64_t err_us = (int64_t)(s_cb_t_actual - target);
        if (err_us < -2000 || err_us > 2000) {
            ESP_LOGE(TAG, "FAIL timing error %lld us (limit +/-2000)", (long long)err_us);
            ok = false;
        } else {
            ESP_LOGI(TAG, "PASS scheduled fire, error %lld us", (long long)err_us);
        }
    }

    /* A duplicate SEQ must be suppressed. FIRE_AT is deliberately sent
       twice by the app for reliability, so the second copy must not
       produce a second flash. */
    vTaskDelay(pdMS_TO_TICKS(600));
    s_cb_count = 0;
    uint64_t t2 = clk_now_us() + 150000ULL;
    sched_fire_at(t2, 50, 255, 101, test_ack);
    if (sched_is_duplicate(101)) {
        ESP_LOGI(TAG, "PASS duplicate seq detected");
    } else {
        ESP_LOGE(TAG, "FAIL duplicate seq not detected");
        ok = false;
    }
    vTaskDelay(pdMS_TO_TICKS(300));
    if (s_cb_count != 1) {
        ESP_LOGE(TAG, "FAIL duplicate produced %d acks", s_cb_count);
        ok = false;
    }

    /* A target already in the past must fire immediately AND report LATE,
       so the app can raise its lead time rather than silently degrading. */
    vTaskDelay(pdMS_TO_TICKS(600));
    s_cb_count = 0;
    uint64_t past = clk_now_us() - 50000ULL;
    sched_fire_at(past, 50, 255, 102, test_ack);
    vTaskDelay(pdMS_TO_TICKS(200));
    if (s_cb_count != 1 || !(s_cb_flags & ACK_FLAG_LATE)) {
        ESP_LOGE(TAG, "FAIL late path: count=%d flags=0x%02x", s_cb_count, s_cb_flags);
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS late target fired immediately with LATE flag");
    }

    /* Cancellation must prevent the fire entirely. */
    vTaskDelay(pdMS_TO_TICKS(600));
    s_cb_count = 0;
    sched_fire_at(clk_now_us() + 200000ULL, 50, 255, 103, test_ack);
    sched_cancel();
    vTaskDelay(pdMS_TO_TICKS(400));
    if (s_cb_count != 0) {
        ESP_LOGE(TAG, "FAIL cancel did not prevent fire (%d acks)", s_cb_count);
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS cancel");
    }

    ESP_LOGI(TAG, "===== SCHED SELFTEST %s =====", ok ? "PASS" : "FAIL");
    return ok;
}
```

- [ ] **Step 2: Write the header**

`firmware/components/scheduler/include/scheduler.h`:
```c
#pragma once
#include <stdint.h>
#include <stdbool.h>

#define SCHED_SEQ_HISTORY 8

typedef void (*sched_ack_cb_t)(uint16_t seq, uint64_t t_actual_us, uint8_t flags);

void sched_init(void);
void sched_fire_at(uint64_t t_fire_us, uint16_t duration_ms,
                   uint8_t brightness, uint16_t seq, sched_ack_cb_t cb);
void sched_cancel(void);
bool sched_is_duplicate(uint16_t seq);
bool sched_selftest_run(void);
```

- [ ] **Step 3: Run to verify it fails**

`firmware/components/scheduler/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "scheduler.c" "scheduler_selftest.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_timer clk flash_driver protocol)
```
Add `scheduler` to main's `REQUIRES`, call `sched_init()` and `sched_selftest_run()`, then build:
```
idf.py build
```
Expected: FAIL — undefined references to `sched_init`, `sched_fire_at`, `sched_cancel`, `sched_is_duplicate`.

- [ ] **Step 4: Implement**

`firmware/components/scheduler/scheduler.c`:
```c
#include <string.h>
#include "esp_timer.h"
#include "esp_log.h"
#include "scheduler.h"
#include "clk.h"
#include "flash_driver.h"
#include "protocol.h"

static const char *TAG = "sched";

static esp_timer_handle_t s_fire_timer;
static sched_ack_cb_t     s_cb;
static uint16_t           s_seq;
static uint16_t           s_duration_ms;
static uint8_t            s_brightness;
static uint8_t            s_pending_flags;

/* Small ring of recently accepted sequence numbers. FIRE_AT is sent twice
   by the app to survive packet loss, so the duplicate must be swallowed
   here rather than producing a second flash. */
static uint16_t s_seen[SCHED_SEQ_HISTORY];
static uint8_t  s_seen_idx;
static bool     s_seen_valid[SCHED_SEQ_HISTORY];

static void do_fire(void)
{
    flash_result_t r = flash_fire(s_duration_ms, s_brightness);
    uint8_t flags = s_pending_flags | r.flags;
    if (s_cb) {
        s_cb(s_seq, r.fired ? r.t_actual_us : clk_now_us(), flags);
    }
}

static void fire_timer_cb(void *arg)
{
    (void)arg;
    do_fire();
}

void sched_init(void)
{
    const esp_timer_create_args_t targs = {
        .callback = fire_timer_cb,
        .name     = "sched_fire",
        .dispatch_method = ESP_TIMER_TASK,
    };
    ESP_ERROR_CHECK(esp_timer_create(&targs, &s_fire_timer));
    memset(s_seen_valid, 0, sizeof(s_seen_valid));
    s_seen_idx = 0;
    ESP_LOGI(TAG, "scheduler ready");
}

bool sched_is_duplicate(uint16_t seq)
{
    for (int i = 0; i < SCHED_SEQ_HISTORY; i++) {
        if (s_seen_valid[i] && s_seen[i] == seq) return true;
    }
    return false;
}

static void remember_seq(uint16_t seq)
{
    s_seen[s_seen_idx] = seq;
    s_seen_valid[s_seen_idx] = true;
    s_seen_idx = (uint8_t)((s_seen_idx + 1) % SCHED_SEQ_HISTORY);
}

void sched_fire_at(uint64_t t_fire_us, uint16_t duration_ms,
                   uint8_t brightness, uint16_t seq, sched_ack_cb_t cb)
{
    if (sched_is_duplicate(seq)) {
        ESP_LOGD(TAG, "seq %u already scheduled, ignoring duplicate", seq);
        return;
    }
    remember_seq(seq);

    s_cb           = cb;
    s_seq          = seq;
    s_duration_ms  = duration_ms;
    s_brightness   = brightness;
    s_pending_flags = 0;

    uint64_t now = clk_now_us();
    esp_timer_stop(s_fire_timer);

    if (t_fire_us <= now) {
        /* The deadline has already passed. Fire immediately and flag it:
           degrading to the naive behaviour is better than dropping the
           shot, and the LATE rate is a measured quantity the app uses to
           raise its lead time. */
        s_pending_flags |= ACK_FLAG_LATE;
        ESP_LOGW(TAG, "seq %u late by %lld us", seq, (long long)(now - t_fire_us));
        do_fire();
        return;
    }

    esp_timer_start_once(s_fire_timer, t_fire_us - now);
}

void sched_cancel(void)
{
    esp_timer_stop(s_fire_timer);
}
```

- [ ] **Step 5: Build, flash, verify it passes**

```
idf.py build && idf.py -p COM3 flash monitor
```
Expected: `PASS scheduled fire, error <n> us` with |n| under 2000, `PASS duplicate seq detected`, `PASS late target fired immediately with LATE flag`, `PASS cancel`, `===== SCHED SELFTEST PASS =====`.

Record the reported timing error — it is the device-side accuracy figure for your report.

- [ ] **Step 6: Commit**

```bash
git add firmware/components/scheduler firmware/main
git commit -m "feat(scheduler): timer-accurate scheduled fire with seq dedupe"
```

---

## Task 6: Command dispatch layer

**Files:**
- Create: `firmware/components/dispatch/include/dispatch.h`, `firmware/components/dispatch/dispatch.c`, `firmware/components/dispatch/dispatch_selftest.c`, `firmware/components/dispatch/CMakeLists.txt`
- Modify: `firmware/main/CMakeLists.txt`, `firmware/main/main.c`

**Dispatch is its own component, not part of `main`.** Both transports call
`dispatch_handle()`, and `main` depends on both transports. Putting dispatch inside
`main` would make `transport_wifi` require `main` while `main` requires
`transport_wifi` — a circular component dependency that ESP-IDF rejects at configure
time. The dependency order is `main → {dispatch, transport_wifi, transport_ble}`,
`transport_* → dispatch`, `dispatch → {protocol, clk, flash_driver, scheduler,
battery}`.

**Interfaces:**
- Consumes: `proto_decode`/`proto_encode` (Task 2), `clk_*` (Task 3), `flash_fire` (Task 4), `sched_*` (Task 5)
- Produces:
  - `typedef void (*dispatch_send_fn)(const uint8_t *buf, size_t len);`
  - `void dispatch_init(dispatch_send_fn send);`
  - `void dispatch_handle(const uint8_t *buf, size_t len);`

This is where "both transports behave identically" is actually enforced: each transport passes raw bytes to `dispatch_handle` and supplies a `send` function. Neither transport contains any protocol logic.

- [ ] **Step 1: Write the failing test**

`firmware/components/dispatch/dispatch_selftest.c`:
```c
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "dispatch.h"
#include "protocol.h"
#include "clk.h"

static const char *TAG = "disp_test";

static uint8_t s_sent[PROTO_MAX_FRAME];
static size_t  s_sent_len;
static int     s_sent_count;

static void capture_send(const uint8_t *buf, size_t len)
{
    memcpy(s_sent, buf, len);
    s_sent_len = len;
    s_sent_count++;
}

bool dispatch_selftest_run(void)
{
    bool ok = true;
    dispatch_init(capture_send);

    /* SYNC_REQ must produce a SYNC_RESP echoing the sequence number and
       carrying this boot's session_id. */
    s_sent_count = 0;
    const uint8_t sync_req[] = { 0x01, 0x01, 0x2a, 0x00 };
    dispatch_handle(sync_req, sizeof(sync_req));

    proto_frame_t f;
    if (s_sent_count != 1 || proto_decode(s_sent, s_sent_len, &f) != PROTO_OK) {
        ESP_LOGE(TAG, "FAIL sync produced no decodable response");
        ok = false;
    } else if (f.op != OP_SYNC_RESP || f.seq != 42 ||
               f.u.sync_resp.session_id != clk_session_id()) {
        ESP_LOGE(TAG, "FAIL sync_resp fields wrong: op=0x%02x seq=%u", f.op, f.seq);
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS sync_resp");
    }

    /* A malformed frame must produce an ERROR response, not a crash and
       not silence. */
    s_sent_count = 0;
    const uint8_t bad[] = { 0x01, 0x7f, 0x01, 0x00 };
    dispatch_handle(bad, sizeof(bad));
    if (s_sent_count != 1 || proto_decode(s_sent, s_sent_len, &f) != PROTO_OK ||
        f.op != OP_ERROR || f.u.error.code != PROTO_ERRCODE_OPCODE) {
        ESP_LOGE(TAG, "FAIL bad opcode did not yield ERROR");
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS error response for bad opcode");
    }

    /* GET_STATUS must return a well-formed STATUS carrying this session. */
    s_sent_count = 0;
    const uint8_t get_status[] = { 0x01, 0x05, 0x01, 0x00 };
    dispatch_handle(get_status, sizeof(get_status));
    if (s_sent_count != 1 || proto_decode(s_sent, s_sent_len, &f) != PROTO_OK ||
        f.op != OP_STATUS || f.u.status.session_id != clk_session_id() ||
        f.u.status.fw_ver != 0x01) {
        ESP_LOGE(TAG, "FAIL status response malformed");
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS status response");
    }

    /* FIRE_NOW must fire and acknowledge. */
    vTaskDelay(pdMS_TO_TICKS(600));
    s_sent_count = 0;
    const uint8_t fire_now[] = { 0x01, 0x03, 0x02, 0x00, 0x32, 0x00, 0xff };
    dispatch_handle(fire_now, sizeof(fire_now));
    vTaskDelay(pdMS_TO_TICKS(100));
    if (s_sent_count != 1 || proto_decode(s_sent, s_sent_len, &f) != PROTO_OK ||
        f.op != OP_FIRE_ACK || f.seq != 2) {
        ESP_LOGE(TAG, "FAIL fire_now ack malformed");
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS fire_now ack");
    }

    ESP_LOGI(TAG, "===== DISPATCH SELFTEST %s =====", ok ? "PASS" : "FAIL");
    return ok;
}
```

- [ ] **Step 2: Write the header**

`firmware/components/dispatch/include/dispatch.h`:
```c
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

typedef void (*dispatch_send_fn)(const uint8_t *buf, size_t len);

void dispatch_init(dispatch_send_fn send);
void dispatch_handle(const uint8_t *buf, size_t len);
void dispatch_set_mode(uint8_t mode);   /* recorded for STATUS reporting */
bool dispatch_selftest_run(void);
```

- [ ] **Step 3: Run to verify it fails**

`firmware/components/dispatch/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "dispatch.c" "dispatch_selftest.c"
                       INCLUDE_DIRS "include"
                       REQUIRES protocol clk flash_driver scheduler)
```

Update `firmware/main/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "main.c"
                       INCLUDE_DIRS "."
                       REQUIRES protocol clk flash_driver scheduler dispatch driver)
```
Call `dispatch_selftest_run()` in `app_main` and build:
```
idf.py build
```
Expected: FAIL — undefined references to `dispatch_init`, `dispatch_handle`, `dispatch_set_mode`.

- [ ] **Step 4: Implement**

`firmware/components/dispatch/dispatch.c`:
```c
#include <string.h>
#include "esp_log.h"
#include "dispatch.h"
#include "protocol.h"
#include "clk.h"
#include "flash_driver.h"
#include "scheduler.h"

static const char *TAG = "dispatch";

static dispatch_send_fn s_send;
static uint8_t          s_mode;

static void send_frame(const proto_frame_t *f)
{
    uint8_t buf[PROTO_MAX_FRAME];
    int n = proto_encode(f, buf, sizeof(buf));
    if (n > 0 && s_send) s_send(buf, (size_t)n);
}

static void send_error(uint16_t seq, uint8_t code)
{
    proto_frame_t f = { .op = OP_ERROR, .seq = seq };
    f.u.error.code = code;
    send_frame(&f);
}

static void ack_cb(uint16_t seq, uint64_t t_actual_us, uint8_t flags)
{
    proto_frame_t f = { .op = OP_FIRE_ACK, .seq = seq };
    f.u.fire_ack.t_actual_us = t_actual_us;
    f.u.fire_ack.session_id  = clk_session_id();
    f.u.fire_ack.flags       = flags;
    send_frame(&f);
}

void dispatch_init(dispatch_send_fn send)
{
    s_send = send;
}

void dispatch_set_mode(uint8_t mode)
{
    s_mode = mode;
}

void dispatch_handle(const uint8_t *buf, size_t len)
{
    proto_frame_t in;
    proto_err_t err = proto_decode(buf, len, &in);

    if (err != PROTO_OK) {
        /* Sequence number may be unreadable on a malformed frame; 0 is
           reserved for exactly this case. */
        uint16_t seq = (len >= PROTO_HDR_LEN) ? (uint16_t)(buf[2] | (buf[3] << 8)) : 0;
        uint8_t code = (err == PROTO_ERR_SHORT)   ? PROTO_ERRCODE_SHORT
                     : (err == PROTO_ERR_VERSION) ? PROTO_ERRCODE_VERSION
                     : (err == PROTO_ERR_OPCODE)  ? PROTO_ERRCODE_OPCODE
                                                  : PROTO_ERRCODE_LENGTH;
        send_error(seq, code);
        return;
    }

    switch (in.op) {
    case OP_SYNC_REQ: {
        /* Timestamp is read as late as possible so it reflects the moment
           of reply, minimising the asymmetry Cristian's algorithm assumes
           away. */
        proto_frame_t out = { .op = OP_SYNC_RESP, .seq = in.seq };
        out.u.sync_resp.session_id = clk_session_id();
        out.u.sync_resp.t_dev_us   = clk_now_us();
        send_frame(&out);
        break;
    }
    case OP_FIRE_AT:
        sched_fire_at(in.u.fire_at.t_fire_us, in.u.fire_at.duration_ms,
                      in.u.fire_at.brightness, in.seq, ack_cb);
        break;

    case OP_FIRE_NOW: {
        flash_result_t r = flash_fire(in.u.fire_now.duration_ms,
                                      in.u.fire_now.brightness);
        ack_cb(in.seq, r.fired ? r.t_actual_us : clk_now_us(), r.flags);
        break;
    }
    case OP_CANCEL:
        sched_cancel();
        break;

    case OP_GET_STATUS: {
        proto_frame_t out = { .op = OP_STATUS, .seq = in.seq };
        out.u.status.mode       = s_mode;
        out.u.status.session_id = clk_session_id();
        out.u.status.battery_mv = 0;   /* populated in Task 9 */
        out.u.status.flags      = flash_is_on() ? 1 : 0;
        out.u.status.uptime_s   = clk_uptime_s();
        out.u.status.fw_ver     = 0x01;
        send_frame(&out);
        break;
    }
    case OP_SET_CONFIG:
    case OP_SET_MODE:
        /* Implemented in Task 8 once NVS persistence exists. */
        ESP_LOGW(TAG, "op 0x%02x not yet implemented", in.op);
        break;

    default:
        send_error(in.seq, PROTO_ERRCODE_OPCODE);
        break;
    }
}
```

- [ ] **Step 5: Build, flash, verify it passes**

```
idf.py build && idf.py -p COM3 flash monitor
```
Expected: `PASS sync_resp`, `PASS error response for bad opcode`, `PASS status response`, `PASS fire_now ack`, `===== DISPATCH SELFTEST PASS =====`.

- [ ] **Step 6: Commit**

```bash
git add firmware/components/dispatch firmware/main
git commit -m "feat(dispatch): transport-agnostic command handling"
```

---

## Task 7: WiFi transport and Node UDP test client

**Files:**
- Create: `firmware/components/transport_wifi/include/transport_wifi.h`, `transport_wifi.c`, `CMakeLists.txt`
- Create: `tools/udp-client/package.json`, `tools/udp-client/client.js`
- Modify: `firmware/main/main.c`

**Interfaces:**
- Consumes: `dispatch_init`, `dispatch_handle` (Task 6)
- Produces:
  - `void wifi_transport_start(void)` — brings up SoftAP and the UDP listener
  - `void wifi_transport_send(const uint8_t *buf, size_t len)` — matches `dispatch_send_fn`

This is the first end-to-end verification: a real client, over a real radio, causing a real flash at a scheduled instant.

- [ ] **Step 1: Write the header**

`firmware/components/transport_wifi/include/transport_wifi.h`:
```c
#pragma once
#include <stdint.h>
#include <stddef.h>

#define WIFI_AP_PASSWORD  "smartcam123"
#define WIFI_UDP_PORT     4210

void wifi_transport_start(void);
void wifi_transport_send(const uint8_t *buf, size_t len);
```

- [ ] **Step 2: Implement the transport**

`firmware/components/transport_wifi/transport_wifi.c`:
```c
#include <string.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_mac.h"
#include "nvs_flash.h"
#include "esp_log.h"
#include "transport_wifi.h"
#include "dispatch.h"
#include "protocol.h"

static const char *TAG = "wifi";

static int                s_sock = -1;
static struct sockaddr_in s_peer;
static bool               s_have_peer;

void wifi_transport_send(const uint8_t *buf, size_t len)
{
    if (s_sock < 0 || !s_have_peer) return;
    sendto(s_sock, buf, len, 0, (struct sockaddr *)&s_peer, sizeof(s_peer));
}

static void udp_task(void *arg)
{
    (void)arg;
    struct sockaddr_in bind_addr = {
        .sin_family      = AF_INET,
        .sin_port        = htons(WIFI_UDP_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };

    s_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (s_sock < 0) {
        ESP_LOGE(TAG, "socket create failed");
        vTaskDelete(NULL);
        return;
    }
    if (bind(s_sock, (struct sockaddr *)&bind_addr, sizeof(bind_addr)) < 0) {
        ESP_LOGE(TAG, "bind failed");
        close(s_sock);
        s_sock = -1;
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGI(TAG, "UDP listening on port %d", WIFI_UDP_PORT);

    uint8_t rx[PROTO_MAX_FRAME];
    while (1) {
        struct sockaddr_in from;
        socklen_t from_len = sizeof(from);
        int n = recvfrom(s_sock, rx, sizeof(rx), 0,
                         (struct sockaddr *)&from, &from_len);
        if (n <= 0) continue;

        /* Reply to whoever last spoke to us. With a single-client SoftAP
           this is sufficient and avoids any discovery mechanism. */
        s_peer = from;
        s_have_peer = true;
        dispatch_handle(rx, (size_t)n);
    }
}

void wifi_transport_start(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);

    wifi_config_t wc = { 0 };
    snprintf((char *)wc.ap.ssid, sizeof(wc.ap.ssid),
             "SmartCam-Flash-%02X%02X", mac[4], mac[5]);
    wc.ap.ssid_len       = strlen((char *)wc.ap.ssid);
    wc.ap.channel        = 1;
    wc.ap.max_connection = 1;
    wc.ap.authmode       = WIFI_AUTH_WPA2_PSK;
    strncpy((char *)wc.ap.password, WIFI_AP_PASSWORD, sizeof(wc.ap.password) - 1);

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());

    /* Power save adds tens of milliseconds of latency to inbound packets,
       which is precisely the variable this project exists to control. */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));

    ESP_LOGI(TAG, "SoftAP up: SSID=%s pass=%s addr=192.168.4.1:%d",
             wc.ap.ssid, WIFI_AP_PASSWORD, WIFI_UDP_PORT);

    xTaskCreate(udp_task, "udp_rx", 4096, NULL, 5, NULL);
}
```

`firmware/components/transport_wifi/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "transport_wifi.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_wifi esp_netif esp_event nvs_flash lwip protocol dispatch)
```

- [ ] **Step 3: Wire it into main**

In `app_main`, after the self-tests, initialise NVS (required by the WiFi stack) and start the transport:
```c
    ESP_ERROR_CHECK(nvs_flash_init());
    dispatch_init(wifi_transport_send);
    dispatch_set_mode(1);            /* 1 = WiFi */
    wifi_transport_start();
```
Add `transport_wifi` and `nvs_flash` to main's `REQUIRES`, and include `"transport_wifi.h"` and `"nvs_flash.h"`.

- [ ] **Step 4: Write the Node test client**

`tools/udp-client/package.json`:
```json
{
  "name": "smartcam-udp-client",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "bin": { "smartcam": "client.js" }
}
```

`tools/udp-client/client.js`:
```js
#!/usr/bin/env node
// Host-side test client for the SmartCam flash unit over UDP.
//   node client.js sync            - run the clock-sync handshake
//   node client.js fire-now        - naive immediate fire
//   node client.js fire-at [lead]  - scheduled fire, default 120ms lead
//   node client.js status          - request device status
const dgram = require('dgram');

const HOST = '192.168.4.1';
const PORT = 4210;
const VERSION = 0x01;
const OP = { SYNC_REQ:0x01, FIRE_AT:0x02, FIRE_NOW:0x03, GET_STATUS:0x05,
             SYNC_RESP:0x81, FIRE_ACK:0x82, STATUS:0x83, ERROR:0x84 };

const sock = dgram.createSocket('udp4');
let seq = 1;

function nowUs() { return Math.round(Number(process.hrtime.bigint()) / 1000); }

function writeU64(buf, off, v) {
  // Values are microseconds since boot, so they stay under 2^53 and split
  // exactly into two 32-bit halves without BigInt.
  buf.writeUInt32LE(v >>> 0, off);
  buf.writeUInt32LE(Math.floor(v / 0x100000000), off + 4);
}
function readU64(buf, off) {
  return buf.readUInt32LE(off) + buf.readUInt32LE(off + 4) * 0x100000000;
}

function header(op) {
  const b = Buffer.alloc(4);
  b[0] = VERSION; b[1] = op; b.writeUInt16LE(seq, 2);
  return b;
}

function send(buf) { sock.send(buf, PORT, HOST); }

function decode(buf) {
  const op = buf[1], s = buf.readUInt16LE(2);
  switch (op) {
    case OP.SYNC_RESP:
      return { op:'SYNC_RESP', seq:s, t_dev_us:readU64(buf,4), session_id:buf.readUInt32LE(12) };
    case OP.FIRE_ACK:
      return { op:'FIRE_ACK', seq:s, t_actual_us:readU64(buf,4),
               session_id:buf.readUInt32LE(12), flags:buf[16] };
    case OP.STATUS:
      return { op:'STATUS', seq:s, mode:buf[4], session_id:buf.readUInt32LE(5),
               battery_mv:buf.readUInt16LE(9), flags:buf[11],
               uptime_s:buf.readUInt32LE(12), fw_ver:buf[16] };
    case OP.ERROR:
      return { op:'ERROR', seq:s, code:buf[4] };
    default:
      return { op:`0x${op.toString(16)}`, seq:s, raw:buf.toString('hex') };
  }
}

// Cristian's algorithm: keep the sample with the smallest round trip,
// because the fastest exchange is the least distorted by queuing delay.
async function syncClock(rounds = 11) {
  let best = null;
  for (let i = 0; i < rounds; i++) {
    const t0 = nowUs();
    const resp = await request(header(OP.SYNC_REQ));
    const t1 = nowUs();
    const rtt = t1 - t0;
    const offset = resp.t_dev_us - (t0 + rtt / 2);
    if (!best || rtt < best.rtt) best = { rtt, offset, session_id: resp.session_id };
  }
  return best;
}

function request(buf, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const mySeq = seq++;
    buf.writeUInt16LE(mySeq, 2);
    const timer = setTimeout(() => {
      sock.removeListener('message', onMsg);
      reject(new Error(`timeout waiting for seq ${mySeq}`));
    }, timeoutMs);
    function onMsg(msg) {
      const d = decode(msg);
      if (d.seq !== mySeq) return;
      clearTimeout(timer);
      sock.removeListener('message', onMsg);
      resolve(d);
    }
    sock.on('message', onMsg);
    send(buf);
  });
}

async function main() {
  const cmd = process.argv[2] || 'status';
  sock.bind();
  await new Promise(r => sock.once('listening', r));

  if (cmd === 'status') {
    console.log(await request(header(OP.GET_STATUS)));

  } else if (cmd === 'sync') {
    const s = await syncClock();
    console.log(`best rtt=${s.rtt}us offset=${s.offset}us session=0x${s.session_id.toString(16)}`);

  } else if (cmd === 'fire-now') {
    const b = Buffer.concat([header(OP.FIRE_NOW), Buffer.alloc(3)]);
    b.writeUInt16LE(300, 4); b[6] = 255;
    console.log(await request(b));

  } else if (cmd === 'fire-at') {
    const leadMs = Number(process.argv[3] || 120);
    const s = await syncClock();
    const tFire = nowUs() + s.offset + leadMs * 1000;
    const b = Buffer.concat([header(OP.FIRE_AT), Buffer.alloc(11)]);
    writeU64(b, 4, tFire);
    b.writeUInt16LE(300, 12); b[14] = 255;
    const ack = await request(b, leadMs + 2000);
    const errUs = ack.t_actual_us - tFire;
    console.log(ack);
    console.log(`scheduling error: ${errUs} us, flags=0x${ack.flags.toString(16)}`);

  } else {
    console.error('usage: client.js [status|sync|fire-now|fire-at [leadMs]]');
    process.exitCode = 1;
  }
  sock.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 5: Build, flash, and verify end to end**

```
idf.py build && idf.py -p COM3 flash monitor
```
Then on the PC, join the WiFi network `SmartCam-Flash-XXXX` with password `smartcam123`, and run:
```
node tools/udp-client/client.js status
node tools/udp-client/client.js sync
node tools/udp-client/client.js fire-at 120
```
Expected:
- `status` prints a `STATUS` object with a non-zero `session_id` and `fw_ver: 1`
- `sync` prints an RTT typically under 15000 µs
- `fire-at` fires the LED and reports a scheduling error within a few hundred microseconds

If `status` times out, Windows is likely still routing through your normal network adapter. Disconnect other networks, or confirm `ipconfig` shows a `192.168.4.x` address on the WiFi adapter.

- [ ] **Step 6: Commit**

```bash
git add firmware/components/transport_wifi firmware/main tools/udp-client
git commit -m "feat(wifi): SoftAP UDP transport with Node test client"
```

---

## Task 8: BLE transport

**Files:**
- Create: `firmware/components/transport_ble/include/transport_ble.h`, `transport_ble.c`, `CMakeLists.txt`
- Modify: `firmware/main/main.c`

**Interfaces:**
- Consumes: `dispatch_init`, `dispatch_handle` (Task 6)
- Produces:
  - `void ble_transport_start(void)`
  - `void ble_transport_send(const uint8_t *buf, size_t len)` — matches `dispatch_send_fn`
  - Service UUID `6f9b0001-b5a3-f393-e0a9-e50e24dcca9e`, RX characteristic `...0002...` (write without response), TX characteristic `...0003...` (notify)

- [ ] **Step 1: Write the header**

`firmware/components/transport_ble/include/transport_ble.h`:
```c
#pragma once
#include <stdint.h>
#include <stddef.h>

/* Service  6f9b0001-b5a3-f393-e0a9-e50e24dcca9e
   RX (WNR) 6f9b0002-b5a3-f393-e0a9-e50e24dcca9e   app -> device
   TX (NTF) 6f9b0003-b5a3-f393-e0a9-e50e24dcca9e   device -> app
   These UUIDs are fixed and must match the app in Plan 2 exactly. */

void ble_transport_start(void);
void ble_transport_send(const uint8_t *buf, size_t len);
```

- [ ] **Step 2: Implement**

`firmware/components/transport_ble/transport_ble.c`:
```c
#include <string.h>
#include "esp_log.h"
#include "nvs_flash.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "transport_ble.h"
#include "dispatch.h"
#include "protocol.h"

static const char *TAG = "ble";

static uint8_t  s_addr_type;
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_tx_val_handle;

static const ble_uuid128_t SVC_UUID = BLE_UUID128_INIT(
    0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
    0x93, 0xf3, 0xa3, 0xb5, 0x01, 0x00, 0x9b, 0x6f);
static const ble_uuid128_t RX_UUID = BLE_UUID128_INIT(
    0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
    0x93, 0xf3, 0xa3, 0xb5, 0x02, 0x00, 0x9b, 0x6f);
static const ble_uuid128_t TX_UUID = BLE_UUID128_INIT(
    0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
    0x93, 0xf3, 0xa3, 0xb5, 0x03, 0x00, 0x9b, 0x6f);

static void start_advertising(void);

static int gatt_rx_cb(uint16_t conn, uint16_t attr,
                      struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn; (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return 0;

    uint8_t buf[PROTO_MAX_FRAME];
    uint16_t len = 0;
    int rc = ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &len);
    if (rc != 0) return BLE_ATT_ERR_UNLIKELY;

    dispatch_handle(buf, len);
    return 0;
}

static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &SVC_UUID.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid = &RX_UUID.u,
                .access_cb = gatt_rx_cb,
                /* Write-without-response: write-with-response would add a
                   full round trip to every trigger, which is exactly the
                   latency this project is measuring. */
                .flags = BLE_GATT_CHR_F_WRITE_NO_RSP,
            },
            {
                .uuid = &TX_UUID.u,
                .access_cb = gatt_rx_cb,
                .flags = BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &s_tx_val_handle,
            },
            { 0 }
        },
    },
    { 0 }
};

void ble_transport_send(const uint8_t *buf, size_t len)
{
    if (s_conn_handle == BLE_HS_CONN_HANDLE_NONE) return;
    struct os_mbuf *om = ble_hs_mbuf_from_flat(buf, len);
    if (!om) return;
    ble_gattc_notify_custom(s_conn_handle, s_tx_val_handle, om);
}

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_conn_handle = event->connect.conn_handle;
            ESP_LOGI(TAG, "connected");
            /* Connection interval dominates BLE latency. Request the
               shortest the spec allows (7.5ms-15ms) rather than accepting
               the peer's default, which is often 30-50ms. */
            struct ble_gap_upd_params p = {
                .itvl_min = 6,    /* units of 1.25ms => 7.5ms */
                .itvl_max = 12,   /* => 15ms */
                .latency  = 0,
                .supervision_timeout = 400,
            };
            ble_gap_update_params(s_conn_handle, &p);
        } else {
            start_advertising();
        }
        break;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnected, reason=%d", event->disconnect.reason);
        s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        start_advertising();
        break;

    case BLE_GAP_EVENT_CONN_UPDATE:
        ESP_LOGI(TAG, "conn params updated");
        break;

    default:
        break;
    }
    return 0;
}

static void start_advertising(void)
{
    struct ble_hs_adv_fields fields = { 0 };
    const char *name = ble_svc_gap_device_name();

    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (uint8_t *)name;
    fields.name_len = strlen(name);
    fields.name_is_complete = 1;
    ble_gap_adv_set_fields(&fields);

    struct ble_gap_adv_params adv = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
    };
    ble_gap_adv_start(s_addr_type, NULL, BLE_HS_FOREVER, &adv, gap_event, NULL);
    ESP_LOGI(TAG, "advertising as %s", name);
}

static void on_sync(void)
{
    ble_hs_id_infer_auto(0, &s_addr_type);
    start_advertising();
}

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void ble_transport_start(void)
{
    ESP_ERROR_CHECK(nimble_port_init());

    ble_hs_cfg.sync_cb = on_sync;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    ESP_ERROR_CHECK(ble_gatts_count_cfg(gatt_svcs));
    ESP_ERROR_CHECK(ble_gatts_add_svcs(gatt_svcs));
    ESP_ERROR_CHECK(ble_svc_gap_device_name_set("SmartCam-Flash"));

    nimble_port_freertos_init(host_task);
}
```

`firmware/components/transport_ble/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "transport_ble.c"
                       INCLUDE_DIRS "include"
                       REQUIRES bt nvs_flash protocol dispatch)
```

- [ ] **Step 3: Wire it into main behind the mode selection**

Replace the transport startup in `app_main` so that mode 0 starts BLE and mode 1 starts WiFi. Hardcode mode 0 for this task; Task 10 makes it persistent and switchable:
```c
    ESP_ERROR_CHECK(nvs_flash_init());

    uint8_t mode = 0;   /* 0 = BLE, 1 = WiFi. Made persistent in Task 10. */
    dispatch_set_mode(mode);
    if (mode == 0) {
        dispatch_init(ble_transport_send);
        ble_transport_start();
    } else {
        dispatch_init(wifi_transport_send);
        wifi_transport_start();
    }
```

- [ ] **Step 4: Build, flash, and verify with nRF Connect**

```
idf.py build && idf.py -p COM3 flash monitor
```
Install **nRF Connect for Mobile** (Nordic Semiconductor, free) on an Android phone. Then:

1. Scan and connect to `SmartCam-Flash`.
2. Expand the `6f9b0001-...` service.
3. On the RX characteristic `6f9b0002-...`, write the byte string `0105 0100` (hex, `GET_STATUS` with seq 1).
4. Enable notifications on the TX characteristic `6f9b0003-...`.

Expected: a notification arrives beginning `01 83 01 00`, and the serial monitor logs the connection and the parameter update. Then write `01 03 02 00 2C 01 FF` (`FIRE_NOW`, 300 ms, full brightness) and confirm the LED flashes.

- [ ] **Step 5: Commit**

```bash
git add firmware/components/transport_ble firmware/main
git commit -m "feat(ble): NimBLE GATT transport with low-latency conn params"
```

---

## Task 9: Battery sensing and low-battery interlock

**Files:**
- Create: `firmware/components/battery/include/battery.h`, `battery.c`, `battery_selftest.c`, `CMakeLists.txt`
- Modify: `firmware/main/dispatch.c`, `firmware/main/main.c`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `void battery_init(void)`
  - `uint16_t battery_mv(void)` — cell voltage in millivolts
  - `bool battery_ok_to_fire(void)` — false below 3100 mV

- [ ] **Step 1: Write the failing test**

`firmware/components/battery/battery_selftest.c`:
```c
#include "esp_log.h"
#include "battery.h"

static const char *TAG = "batt_test";

bool battery_selftest_run(void)
{
    bool ok = true;
    uint16_t mv = battery_mv();

    /* A plausible reading proves the divider, the ADC1 channel and the
       calibration are all wired correctly. A reading of 0 or a rail-pinned
       value means the divider is wrong or the pin is on ADC2, which is
       unusable while WiFi is active. */
    if (mv < 2500 || mv > 4400) {
        ESP_LOGE(TAG, "FAIL implausible battery reading: %u mV", mv);
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS battery reads %u mV", mv);
    }

    if (mv >= 3100 && !battery_ok_to_fire()) {
        ESP_LOGE(TAG, "FAIL interlock blocks firing at healthy %u mV", mv);
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS fire interlock consistent with %u mV", mv);
    }

    ESP_LOGI(TAG, "===== BATTERY SELFTEST %s =====", ok ? "PASS" : "FAIL");
    return ok;
}
```

- [ ] **Step 2: Write the header**

`firmware/components/battery/include/battery.h`:
```c
#pragma once
#include <stdint.h>
#include <stdbool.h>

#define BATT_WARN_MV     3400
#define BATT_CUTOFF_MV   3100
#define PIN_BATT_SENSE   34      /* ADC1_CH6 */

void     battery_init(void);
uint16_t battery_mv(void);
bool     battery_ok_to_fire(void);
bool     battery_selftest_run(void);
```

- [ ] **Step 3: Run to verify it fails**

`firmware/components/battery/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "battery.c" "battery_selftest.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_adc)
```
Add `battery` to main's `REQUIRES`, call `battery_init()` and `battery_selftest_run()`, then build:
```
idf.py build
```
Expected: FAIL — undefined references to `battery_init`, `battery_mv`, `battery_ok_to_fire`.

- [ ] **Step 4: Implement**

Wire a 100 kΩ / 100 kΩ divider from battery positive to GND, with the midpoint to GPIO34. This halves the 4.2 V maximum to 2.1 V, inside the ADC's 12 dB range.

`firmware/components/battery/battery.c`:
```c
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_log.h"
#include "battery.h"

static const char *TAG = "batt";

/* GPIO34 is ADC1_CH6. ADC1 is mandatory here: ADC2 is claimed by the WiFi
   driver, so a divider on an ADC2 pin would read correctly in BLE mode and
   fail silently in WiFi mode. */
#define BATT_ADC_UNIT     ADC_UNIT_1
#define BATT_ADC_CHANNEL  ADC_CHANNEL_6
#define DIVIDER_NUM       2      /* 100k/100k halves the input */
#define SAMPLES           16

static adc_oneshot_unit_handle_t s_adc;
static adc_cali_handle_t         s_cali;
static bool                      s_cali_ok;

void battery_init(void)
{
    adc_oneshot_unit_init_cfg_t unit_cfg = { .unit_id = BATT_ADC_UNIT };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&unit_cfg, &s_adc));

    adc_oneshot_chan_cfg_t chan_cfg = {
        .bitwidth = ADC_BITWIDTH_DEFAULT,
        .atten    = ADC_ATTEN_DB_12,
    };
    ESP_ERROR_CHECK(adc_oneshot_config_channel(s_adc, BATT_ADC_CHANNEL, &chan_cfg));

    adc_cali_line_fitting_config_t cali_cfg = {
        .unit_id  = BATT_ADC_UNIT,
        .atten    = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    s_cali_ok = (adc_cali_create_scheme_line_fitting(&cali_cfg, &s_cali) == ESP_OK);
    ESP_LOGI(TAG, "battery ADC ready (cali=%s)", s_cali_ok ? "yes" : "no");
}

uint16_t battery_mv(void)
{
    int acc = 0;
    for (int i = 0; i < SAMPLES; i++) {
        int raw = 0;
        if (adc_oneshot_read(s_adc, BATT_ADC_CHANNEL, &raw) == ESP_OK) acc += raw;
    }
    int avg_raw = acc / SAMPLES;

    int mv = 0;
    if (s_cali_ok) {
        adc_cali_raw_to_voltage(s_cali, avg_raw, &mv);
    } else {
        /* Uncalibrated fallback: 12dB attenuation spans roughly 0-3100 mV. */
        mv = (avg_raw * 3100) / 4095;
    }
    return (uint16_t)(mv * DIVIDER_NUM);
}

bool battery_ok_to_fire(void)
{
    return battery_mv() >= BATT_CUTOFF_MV;
}

/* Lent to photo_probe.c. ADC1 has exactly one owner; see battery.h. */
adc_oneshot_unit_handle_t battery_adc_handle(void)
{
    return s_adc;
}
```

Add `#include "esp_adc/adc_oneshot.h"` to `battery.h` so the handle type is visible
to `photo_probe.c`.

- [ ] **Step 5: Populate STATUS and gate firing**

In `firmware/main/dispatch.c`, add `#include "battery.h"`, then in the `OP_GET_STATUS` case replace the placeholder:
```c
        out.u.status.battery_mv = battery_mv();
```
And in both `OP_FIRE_AT` and `OP_FIRE_NOW`, refuse when the cell is too low. Insert before each fire call:
```c
        if (!battery_ok_to_fire()) {
            send_error(in.seq, PROTO_ERRCODE_BATTERY);
            break;
        }
```

- [ ] **Step 6: Build, flash, verify it passes**

```
idf.py build && idf.py -p COM3 flash monitor
```
Expected: `PASS battery reads <n> mV` with n between 3000 and 4200 matching a multimeter reading across the cell within about 100 mV. Then `node tools/udp-client/client.js status` should report the same `battery_mv`.

- [ ] **Step 7: Commit**

```bash
git add firmware/components/battery firmware/main
git commit -m "feat(battery): ADC1 cell sensing with low-voltage fire interlock"
```

---

## Task 10: Persistent config, mode switching, and status indication

**Files:**
- Create: `firmware/components/config_store/include/config_store.h`, `config_store.c`, `CMakeLists.txt`
- Modify: `firmware/main/main.c`, `firmware/main/dispatch.c`

**Interfaces:**
- Consumes: `dispatch_set_mode` (Task 6)
- Produces:
  - `void cfg_init(void)`
  - `uint8_t cfg_mode(void)` / `void cfg_set_mode(uint8_t)`
  - `uint16_t cfg_default_duration_ms(void)` / `void cfg_set_default_duration(uint16_t)`
  - `uint8_t cfg_brightness(void)` / `void cfg_set_brightness(uint8_t)`

- [ ] **Step 1: Write the header**

`firmware/components/config_store/include/config_store.h`:
```c
#pragma once
#include <stdint.h>

#define CFG_MODE_BLE   0
#define CFG_MODE_WIFI  1

void     cfg_init(void);
uint8_t  cfg_mode(void);
void     cfg_set_mode(uint8_t mode);
uint16_t cfg_default_duration_ms(void);
void     cfg_set_default_duration(uint16_t ms);
uint8_t  cfg_brightness(void);
void     cfg_set_brightness(uint8_t b);
```

- [ ] **Step 2: Implement**

`firmware/components/config_store/config_store.c`:
```c
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_log.h"
#include "config_store.h"

static const char *TAG = "cfg";
static const char *NS  = "smartcam";

static uint8_t  s_mode = CFG_MODE_BLE;
static uint16_t s_duration = 300;
static uint8_t  s_brightness = 255;

static void save_u8(const char *key, uint8_t v)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_u8(h, key, v);
    nvs_commit(h);
    nvs_close(h);
}

void cfg_init(void)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) {
        ESP_LOGW(TAG, "no stored config, using defaults");
        return;
    }
    nvs_get_u8(h, "mode", &s_mode);
    nvs_get_u16(h, "dur", &s_duration);
    nvs_get_u8(h, "bright", &s_brightness);
    nvs_close(h);
    ESP_LOGI(TAG, "config: mode=%u duration=%ums brightness=%u",
             s_mode, s_duration, s_brightness);
}

uint8_t  cfg_mode(void) { return s_mode; }
uint16_t cfg_default_duration_ms(void) { return s_duration; }
uint8_t  cfg_brightness(void) { return s_brightness; }

void cfg_set_mode(uint8_t mode)
{
    s_mode = mode;
    save_u8("mode", mode);
}

void cfg_set_brightness(uint8_t b)
{
    s_brightness = b;
    save_u8("bright", b);
}

void cfg_set_default_duration(uint16_t ms)
{
    s_duration = ms;
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_u16(h, "dur", ms);
    nvs_commit(h);
    nvs_close(h);
}
```

`firmware/components/config_store/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "config_store.c"
                       INCLUDE_DIRS "include"
                       REQUIRES nvs_flash)
```

- [ ] **Step 3: Implement SET_CONFIG and SET_MODE in dispatch**

In `firmware/main/dispatch.c`, add `#include "config_store.h"` and `#include "esp_system.h"`, then replace the placeholder case:
```c
    case OP_SET_CONFIG:
        cfg_set_default_duration(in.u.set_config.default_duration_ms);
        cfg_set_brightness(in.u.set_config.brightness);
        send_frame(&(proto_frame_t){ .op = OP_STATUS, .seq = in.seq,
            .u.status = { .mode = s_mode, .session_id = clk_session_id(),
                          .battery_mv = battery_mv(), .flags = 0,
                          .uptime_s = clk_uptime_s(), .fw_ver = 0x01 } });
        break;

    case OP_SET_MODE: {
        /* Acknowledge before rebooting, otherwise the client sees only a
           dropped connection and cannot distinguish success from failure. */
        proto_frame_t out = { .op = OP_STATUS, .seq = in.seq };
        out.u.status.mode       = in.u.set_mode.mode;
        out.u.status.session_id = clk_session_id();
        out.u.status.battery_mv = battery_mv();
        out.u.status.flags      = 0;
        out.u.status.uptime_s   = clk_uptime_s();
        out.u.status.fw_ver     = 0x01;
        send_frame(&out);

        cfg_set_mode(in.u.set_mode.mode);
        vTaskDelay(pdMS_TO_TICKS(200));   /* let the frame leave the radio */
        esp_restart();
        break;
    }
```
Add `#include "freertos/FreeRTOS.h"` and `#include "freertos/task.h"` to `dispatch.c` if not already present.

- [ ] **Step 4: Add button mode-switch and status blink to main**

Replace the blink loop in `app_main` with a task that also polls the BOOT button:
```c
    /* GPIO0 is the onboard BOOT button: active-low, already pulled up.
       Reusing it avoids adding any external part. */
    gpio_config_t btn = {
        .pin_bit_mask = 1ULL << 0,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&btn));

    /* Slow blink = BLE, fast blink = WiFi, so the active radio is visible
       from across the bench without a serial monitor. */
    int blink_ms = (cfg_mode() == CFG_MODE_BLE) ? 500 : 150;
    int held_ms = 0;

    while (1) {
        gpio_set_level(PIN_STATUS_LED, 1);
        vTaskDelay(pdMS_TO_TICKS(blink_ms));
        gpio_set_level(PIN_STATUS_LED, 0);
        vTaskDelay(pdMS_TO_TICKS(blink_ms));

        if (gpio_get_level(0) == 0) {
            held_ms += blink_ms * 2;
            if (held_ms >= 2000) {
                uint8_t next = (cfg_mode() == CFG_MODE_BLE) ? CFG_MODE_WIFI : CFG_MODE_BLE;
                ESP_LOGI(TAG, "mode switch -> %s", next ? "WiFi" : "BLE");
                cfg_set_mode(next);
                esp_restart();
            }
        } else {
            held_ms = 0;
        }
    }
```
And replace the hardcoded mode with `uint8_t mode = cfg_mode();`, calling `cfg_init()` after `nvs_flash_init()`.

- [ ] **Step 5: Build, flash, verify**

```
idf.py build && idf.py -p COM3 flash monitor
```
Expected:
- Boots in BLE mode with a slow blink.
- Holding BOOT for two seconds logs `mode switch -> WiFi`, reboots, and the blink becomes fast.
- `node tools/udp-client/client.js status` now works; it reports `mode: 1`.
- Power-cycle the board — it comes back in WiFi mode, proving NVS persistence.
- Hold BOOT again to return to BLE, and confirm nRF Connect finds it.

- [ ] **Step 6: Commit**

```bash
git add firmware/components/config_store firmware/main
git commit -m "feat(config): NVS persistence, button mode switch, status blink"
```

---

## Task 11: Hardware assembly and the phototransistor verification rig

**Files:**
- Create: `docs/hardware/wiring.md`
- Create: `firmware/components/battery/photo_probe.c` (added to the existing `battery` component's `SRCS`)
- Modify: `firmware/components/battery/include/battery.h`

**Interfaces:**
- Consumes: `flash_fire()` (Task 4), `clk_now_us()` (Task 3)
- Produces:
  - `void photo_probe_init(void)`
  - `int64_t photo_probe_measure_latency_us(void)` — commands a fire, watches GPIO35, returns microseconds from command to detected light, or `-1` on timeout

This closes the loop on the device half: firmware measures its own optical output, independently of any phone.

- [ ] **Step 1: Document the wiring**

`docs/hardware/wiring.md`:
```markdown
# SmartCam Flasher — Wiring

## Power chain
    18650 cell (3.0-4.2V)
      -> TP4056 + DW01A module   (charging + over-discharge protection)
         -> MT3608 boost to 5.0V -> ESP32 VIN
         -> LED rail -> CC driver -> LED -> MOSFET drain

The DevKit V1's AMS1117 needs >= ~4.5V on VIN. A bare Li-ion cell reaches
4.2V at most and falls to 3.0V, so it browns out as the cell drains. The
boost converter is required, not optional.

Use the TP4056 variant WITH DW01A + FS8205 protection. The bare version
will discharge the cell below 2.5V and ruin it.

## LED switching
    GPIO26 --[100R]-- MOSFET gate
                      gate --[100k]-- GND      (pulldown, see note)
    LED cathode ----- MOSFET drain
    MOSFET source --- GND (star point at the battery terminal)
    470-1000uF electrolytic across the LED supply rail

MOSFET must be LOGIC LEVEL: IRLZ44N, IRL540N or AO3400.
An IRF540N will NOT work - its gate threshold is too high for 3.3V drive,
so it only partly turns on, gets hot, and gives a dim unreliable flash.

The 100k gate pulldown matters: during boot the GPIO floats, and a
floating gate partially enables the MOSFET - a random flash at power-up
and a hot device. The 100R series resistor damps ringing on the switching
edges.

The fitted FET is an FDP047AN08A0 (75V, 80A, 4.7 mOhm) - far better than the
IRF520 these modules usually carry. Confirm it at bring-up: with the LED lit,
measure from GND to the screw terminal V-. Below 0.3V means it is fully on.

The bulk capacitor matters: switching ~700mA in nanoseconds sags the boost
output enough to reset the ESP32. This is the cause of the classic "board
reboots whenever the flash fires".

Star-ground at the battery terminal: run the LED return and the ESP32
ground to the SAME physical point. Daisy-chaining lets the LED surge shift
the ESP32's ground reference and corrupt ADC readings.

## Battery sense
    Battery + --[100k]-- GPIO34 --[100k]-- GND

GPIO34 is ADC1_CH6. It MUST be ADC1: ADC2 is claimed by the WiFi driver,
so a divider on an ADC2 pin reads fine in BLE mode and fails silently in
WiFi mode.

## Phototransistor probe (test rig only)
    3V3 --[10k]-- GPIO35 -- phototransistor collector
                            emitter -- GND

Aim it at the LED from a few centimetres. Light pulls GPIO35 low.

## Thermal
Mount the LED on aluminium. At 300ms bursts with a 500ms cooldown the
worst-case duty cycle is ~37%, which bare PCB mounting will not survive.

## Reserved pins
GPIO 5, 12, 15 are strapping pins - leave them unloaded or the board may
refuse to boot.
```

- [ ] **Step 2: Write the failing test**

Add to `firmware/components/battery/include/battery.h`:
```c
#define PIN_PHOTO_PROBE  35      /* ADC1_CH7 */

/* One owner for one peripheral: battery.c creates the single ADC1 unit and
   lends the handle out. Calling adc_oneshot_new_unit() twice on ADC_UNIT_1
   returns ESP_ERR_INVALID_STATE and leaves the second handle unset, so the
   probe would silently read nothing and report a wiring fault that does not
   exist. photo_probe_init() must therefore run AFTER battery_init(). */
adc_oneshot_unit_handle_t battery_adc_handle(void);

void    photo_probe_init(void);
int64_t photo_probe_measure_latency_us(void);
bool    photo_probe_selftest_run(void);
```

`firmware/components/battery/photo_probe.c`:
```c
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"
#include "battery.h"
#include "clk.h"
#include "flash_driver.h"

static const char *TAG = "photo";

#define PHOTO_ADC_CHANNEL  ADC_CHANNEL_7   /* GPIO35 */
#define DARK_THRESHOLD     2000            /* raw counts; light pulls it down */
#define TIMEOUT_US         50000

static adc_oneshot_unit_handle_t s_adc;

void photo_probe_init(void)
{
    /* Borrow the unit battery_init() already created. Creating a second one
       on ADC_UNIT_1 fails with ESP_ERR_INVALID_STATE and would leave every
       read failing, which the probe cannot distinguish from darkness. */
    s_adc = battery_adc_handle();
    if (s_adc == NULL) {
        ESP_LOGE(TAG, "battery_init() must run before photo_probe_init()");
        return;
    }
    adc_oneshot_chan_cfg_t chan_cfg = {
        .bitwidth = ADC_BITWIDTH_DEFAULT,
        .atten    = ADC_ATTEN_DB_12,
    };
    ESP_ERROR_CHECK(adc_oneshot_config_channel(s_adc, PHOTO_ADC_CHANNEL, &chan_cfg));
}

int64_t photo_probe_measure_latency_us(void)
{
    uint64_t t_cmd = clk_now_us();
    flash_result_t r = flash_fire(100, 255);
    if (!r.fired) return -1;

    while ((clk_now_us() - t_cmd) < TIMEOUT_US) {
        int raw = 0;
        if (adc_oneshot_read(s_adc, PHOTO_ADC_CHANNEL, &raw) == ESP_OK &&
            raw < DARK_THRESHOLD) {
            return (int64_t)(clk_now_us() - t_cmd);
        }
    }
    return -1;
}

bool photo_probe_selftest_run(void)
{
    bool ok = true;

    /* The optical turn-on must follow the command by well under a
       millisecond. A large or absent reading means the MOSFET is not
       switching - most often a non-logic-level part. */
    int64_t lat = photo_probe_measure_latency_us();
    if (lat < 0) {
        ESP_LOGE(TAG, "FAIL no light detected - check MOSFET is logic-level, "
                      "LED wiring, and that the probe faces the LED");
        ok = false;
    } else if (lat > 1000) {
        ESP_LOGE(TAG, "FAIL optical latency %lld us is implausibly high", (long long)lat);
        ok = false;
    } else {
        ESP_LOGI(TAG, "PASS optical turn-on %lld us after command", (long long)lat);
    }

    ESP_LOGI(TAG, "===== PHOTO SELFTEST %s =====", ok ? "PASS" : "FAIL");
    return ok;
}
```

- [ ] **Step 3: Assemble the hardware**

Build the circuit per `docs/hardware/wiring.md`. Before powering on, verify with a multimeter:
- Continuity from MOSFET source to battery negative.
- Roughly 100 kΩ between GPIO26 and GND with the board unpowered (the gate pulldown).
- The divider midpoint on GPIO34 reads about half the cell voltage.
- No short between the 5 V rail and GND.

- [ ] **Step 4: Run to verify it fails, then passes**

Add `photo_probe_init()` and `photo_probe_selftest_run()` to `app_main` **after
`battery_init()`**, add `flash_driver` and `clk` to the `battery` component's
`REQUIRES`, and add `photo_probe.c` to its `SRCS`.

Build once with the phototransistor **covered**:
```
idf.py build && idf.py -p COM3 flash monitor
```
Expected: FAIL — `no light detected`. This confirms the probe is actually sensing rather than reporting a constant.

Now uncover it, aim it at the LED, and reset:
Expected: `PASS optical turn-on <n> us after command` with n well under 1000.

- [ ] **Step 5: Commit**

```bash
git add docs/hardware firmware/components/battery firmware/main
git commit -m "feat(test): phototransistor probe verifying optical turn-on latency"
```

---

## Task 12: Latency benchmark command

**Files:**
- Modify: `tools/udp-client/client.js`
- Create: `docs/measurements/README.md`

**Interfaces:**
- Consumes: the `sync` and `fire-at` paths from Task 7
- Produces: `node client.js bench <n>` — writes `docs/measurements/wifi-<timestamp>.csv`

This makes the WiFi half of the spec's principal experiment reproducible from the command line, before the app exists.

- [ ] **Step 1: Add the bench command**

Append to `tools/udp-client/client.js`, inside `main()`, before the final `else`:
```js
  } else if (cmd === 'bench') {
    const n = Number(process.argv[3] || 50);
    const fs = require('fs');
    const path = require('path');
    const rows = ['n,rtt_us,offset_us,sched_error_us,flags'];

    for (let i = 0; i < n; i++) {
      const s = await syncClock(5);
      const tFire = nowUs() + s.offset + 120000;
      const b = Buffer.concat([header(OP.FIRE_AT), Buffer.alloc(11)]);
      writeU64(b, 4, tFire);
      b.writeUInt16LE(100, 12); b[14] = 255;
      try {
        const ack = await request(b, 3000);
        rows.push(`${i},${s.rtt},${Math.round(s.offset)},${ack.t_actual_us - tFire},${ack.flags}`);
      } catch (e) {
        rows.push(`${i},${s.rtt},${Math.round(s.offset)},,timeout`);
      }
      // Respect the firmware's 500ms cooldown interlock.
      await new Promise(r => setTimeout(r, 700));
    }

    const outDir = path.join(__dirname, '..', '..', 'docs', 'measurements');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `wifi-${Date.now()}.csv`);
    fs.writeFileSync(file, rows.join('\n'));
    console.log(`wrote ${n} samples to ${file}`);
```
Update the usage string to `[status|sync|fire-now|fire-at [leadMs]|bench [n]]`.

- [ ] **Step 2: Document the measurement procedure**

`docs/measurements/README.md`:
```markdown
# Measurements

## WiFi transport benchmark
With the device in WiFi mode and the PC joined to its SoftAP:

    node tools/udp-client/client.js bench 50

Writes `wifi-<timestamp>.csv` with columns:

| Column          | Meaning |
|-----------------|---------|
| n               | Sample index |
| rtt_us          | Best round-trip time from that sample's clock sync |
| offset_us       | Estimated phone-to-device clock offset |
| sched_error_us  | Actual fire time minus requested fire time |
| flags           | FIRE_ACK flags; bit0 = LATE |

`sched_error_us` is the figure that matters. It should stay within a few
hundred microseconds regardless of how noisy `rtt_us` is - that
independence is the evidence that scheduling decoupled flash timing from
network jitter.

The BLE half of this comparison, and the naive-vs-scheduled comparison,
are produced by the app in Plan 2.
```

- [ ] **Step 3: Run the benchmark**

```
node tools/udp-client/client.js bench 50
```
Expected: 50 rows, `sched_error_us` consistently within a few hundred microseconds, and a `LATE` rate at or near zero.

- [ ] **Step 4: Commit**

```bash
git add tools/udp-client docs/measurements
git commit -m "feat(tools): UDP latency benchmark with CSV export"
```

---

## Plan 1 Completion Criteria

Before starting Plan 2, confirm all of the following:

- [ ] All seven on-device self-tests report PASS (`protocol`, `clk`, `flash`, `sched`, `dispatch`, `battery`, `photo`)
- [ ] `node tools/udp-client/client.js fire-at 120` fires the LED with a scheduling error under 1 ms
- [ ] nRF Connect can connect, write `FIRE_NOW`, and receive a `FIRE_ACK` notification
- [ ] Holding BOOT for two seconds switches transport mode, and the mode survives a power cycle
- [ ] `battery_mv` from `status` matches a multimeter reading within about 100 mV
- [ ] The phototransistor probe reports optical turn-on under 1 ms after the command
- [ ] 200 consecutive flashes complete with no ESP32 reset (run `bench 200`)
- [ ] `protocol/vectors.json` is committed and unchanged since Task 2 — Plan 2's TypeScript codec is written against exactly this file

---

## Plan 2 Preview (not yet written)

Plan 2 builds the bare React Native app: the TypeScript codec tested against
`protocol/vectors.json` with Jest, the `FlashTransport` interface with BLE and UDP
implementations, `ClockSync`, `CaptureController` implementing the pre-fire lit
window, the diagnostics screen exposing `LEAD_TIME` / `FLASH_DURATION` /
`AE_SETTLE` / `BRIGHTNESS`, and `LatencyLog` CSV export. It also carries the
project's highest-risk item — Android's `requestNetwork` / `bindProcessToNetwork`
handling for the SoftAP, without which UDP silently routes over mobile data.

Prerequisites to install before Plan 2: JDK 17, Android Studio with the Android
SDK, and an Android device with USB debugging enabled.
