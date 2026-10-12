# SmartCam React Native App — Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bare React Native camera app that triggers the ESP32 flasher over BLE or WiFi using scheduled ("fire at time T") triggering, captures a correctly-exposed photograph inside the resulting lit window, and logs per-shot timing for the project's results chapter.

**Architecture:** A `FlashTransport` interface hides BLE and UDP behind one API; above it sit `ClockSync` (Cristian's algorithm) and `CaptureController`, which owns the shot sequence — schedule the fire, wait for the scene to light, then call `takePhoto()`. The TypeScript frame codec is written against `protocol/vectors.json`, the same file the firmware's on-device self-test uses, so an endianness or layout mismatch surfaces as a failing unit test rather than as mysteriously mistimed flashes.

**Tech Stack:** Bare React Native (not Expo Go), TypeScript, `react-native-vision-camera`, `react-native-ble-plx`, `react-native-udp`, Jest.

**Spec:** `docs/superpowers/specs/2026-08-26-smartcam-flash-design.md`

**Depends on:** Plan 1 (`docs/superpowers/plans/2026-08-26-firmware-and-protocol.md`), complete. Firmware is running and verified on hardware.

## Global Constraints

- **`protocol/vectors.json` is frozen.** It is the contract the firmware already satisfies. This app is written *to* it; never edit it to make a test pass.
- **Protocol version byte is `0x01`.** All multi-byte fields little-endian. Header: `ver(1) op(1) seq(2)`.
- **No frame may exceed 20 bytes.** Largest are `FIRE_ACK` and `STATUS` at 17.
- **Timestamps are `uint64` microseconds since boot.** Under 2⁵³, so use JavaScript `number` — **never `BigInt`**, and never `DataView.getBigUint64`.
- **BLE UUIDs, fixed and matching the firmware exactly:**
  service `6f9b0001-b5a3-f393-e0a9-e50e24dcca9e`,
  RX (write-without-response) `6f9b0002-b5a3-f393-e0a9-e50e24dcca9e`,
  TX (notify) `6f9b0003-b5a3-f393-e0a9-e50e24dcca9e`.
- **WiFi binding:** SoftAP `SmartCam-Flash-XXXX`, password `smartcam123`, device at `192.168.4.1`, UDP port `4210`.
- **Timing defaults:** `LEAD_TIME` 120 ms, `FLASH_DURATION` 300 ms, `AE_SETTLE` 150 ms. All tunable on the diagnostics screen.
- **`brightness` is reserved and ignored by the firmware.** Send `255`. Brightness is set in hardware on the MT3608 trimpot.
- **`FIRE_AT` is sent twice** with the same `SEQ`. The firmware deduplicates; the retry roughly squares reliability for one extra packet.
- **A changed `session_id` means the device rebooted** — discard the clock offset and re-sync before the next shot.
- **Android target is the demonstrable one.** The codebase stays iOS-capable, but no iOS build is claimed without a Mac.

---

## Prerequisites

Before Task 1:

- **JDK 17** (Adoptium Temurin 17). React Native 0.7x requires 17 specifically; 21 causes Gradle failures.
- **Android Studio** with the Android SDK, plus platform-tools on `PATH` so `adb` works.
- **USB debugging** enabled on the phone.

**Task 2 needs none of these** — it is pure TypeScript run under Jest with the Node already installed. If the Android toolchain is still downloading, do Task 2 first; nothing in it depends on Task 1.

---

## File Structure

```
app/                                  bare React Native project root
  package.json
  index.js
  App.tsx                             navigation between Camera and Diagnostics
  src/
    protocol/
      frames.ts                       codec: encode/decode, opcodes, flag bits
      frames.test.ts                  driven by protocol/vectors.json
    transport/
      FlashTransport.ts               the interface both implementations satisfy
      BleTransport.ts                 react-native-ble-plx
      WifiTransport.ts                react-native-udp + Android network binding
      index.ts                        factory: pick a transport by mode
    sync/
      ClockSync.ts                    Cristian's algorithm, min-RTT selection
      ClockSync.test.ts               synthetic samples, no I/O
    capture/
      CaptureController.ts            the shot sequence
      settings.ts                     LEAD_TIME / FLASH_DURATION / AE_SETTLE
    telemetry/
      LatencyLog.ts                   per-shot records, CSV export
    ui/
      CameraScreen.tsx                preview, shutter, connection badge
      DiagnosticsScreen.tsx           tunables, live stats, export, experiment
```

**Boundary rationale:** `frames.ts`, `ClockSync.ts` and `LatencyLog.ts` touch no native modules, so they are unit-testable under plain Jest with no device attached. The transports are deliberately thin — they move bytes and nothing else, mirroring the firmware's structure, which is why a bug cannot produce different behaviour on BLE than on WiFi.

---

## Task 1: Scaffold and run on the phone

**Files:**
- Create: `app/` (generated), `app/App.tsx`

**Interfaces:**
- Consumes: nothing
- Produces: a bare RN project that builds and runs on a physical Android device

Toolchain bring-up, so verification is observational rather than test-first. Every later task is test-first where the code permits it.

- [ ] **Step 1: Verify the toolchain**

```bash
java -version          # must report 17.x
adb devices            # must list your phone, not "unauthorized"
```
If `adb` shows `unauthorized`, accept the debugging prompt on the phone.

- [ ] **Step 2: Create the project**

From the repo root:
```bash
npx @react-native-community/cli@latest init SmartCamApp --directory app --skip-install
cd app && npm install
```
Bare RN, not Expo Go: BLE and camera are native modules that Expo Go cannot load.

- [ ] **Step 3: Run it**

```bash
npx react-native run-android
```
Expected: the default RN welcome screen on the phone.

If Gradle fails on a JDK version, check `java -version` reports 17 and that `JAVA_HOME` points at it.

- [ ] **Step 4: Replace App.tsx with a placeholder that proves our own code renders**

`app/App.tsx`:
```tsx
import React from 'react';
import { SafeAreaView, Text, StyleSheet } from 'react-native';

export default function App() {
  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.title}>SmartCam</Text>
      <Text style={styles.sub}>flash controller</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:  { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#101318' },
  title: { color: '#E3E6EA', fontSize: 28, fontWeight: '600' },
  sub:   { color: '#767D87', fontSize: 14, marginTop: 4 },
});
```

- [ ] **Step 5: Reload and confirm**

Press `r` twice in the Metro terminal, or shake the phone and choose Reload.
Expected: a dark screen reading "SmartCam / flash controller".

- [ ] **Step 6: Commit**

```bash
git add app/
git commit -m "feat(app): bare React Native scaffold running on device"
```

---

## Task 2: TypeScript frame codec

**Files:**
- Create: `app/src/protocol/frames.ts`, `app/src/protocol/frames.test.ts`
- Modify: `app/package.json` (Jest config to reach outside `app/`)

**Interfaces:**
- Consumes: `protocol/vectors.json` (frozen; created in Plan 1 Task 2)
- Produces:
  - `enum Op { SYNC_REQ = 0x01, FIRE_AT = 0x02, FIRE_NOW = 0x03, CANCEL = 0x04, GET_STATUS = 0x05, SET_CONFIG = 0x06, SET_MODE = 0x07, SYNC_RESP = 0x81, FIRE_ACK = 0x82, STATUS = 0x83, ERROR = 0x84 }`
  - `type Frame` — a discriminated union on `op`
  - `function encode(f: Frame): Uint8Array`
  - `function decode(b: Uint8Array): Frame` — throws `DecodeError` on malformed input
  - `class DecodeError extends Error { constructor(public reason: 'SHORT'|'VERSION'|'OPCODE'|'LENGTH') }`
  - `const ACK_LATE = 1, ACK_DURATION_CLAMPED = 2, ACK_COOLDOWN_REJECTED = 4`

**This task needs no Android toolchain.** Do it first if the SDK is still installing.

- [ ] **Step 1: Point Jest at the repo-root vectors file**

React Native 0.87 puts Jest config in **`app/jest.config.js`**, not a `"jest"` key in
`package.json`. Defining both is a fatal "Multiple configurations found" error, so
merge into the existing file:

```js
module.exports = {
  preset: 'react-native',
  moduleNameMapper: {
    '^@vectors$': '<rootDir>/../protocol/vectors.json',
  },
};
```

`tsc` will not resolve that alias — the real file lives outside the project's
rootDir, so a tsconfig `paths` entry trades one error for another. Declare it
ambiently instead, in `app/src/types/vectors.d.ts`:

```ts
declare module '@vectors' {
  export type Vector = {
    name: string;
    direction: 'app_to_device' | 'device_to_app';
    frame: Record<string, unknown> & { op: string; seq: number };
    bytes: string;
  };
  const doc: { protocol_version: number; note: string; vectors: Vector[] };
  export default doc;
}
```

Also set `"resolveJsonModule": true` and `"esModuleInterop": true` in
`app/tsconfig.json`.

The codec test imports the *same* file the firmware embeds. That shared contract is
what catches layout drift between the two languages.

- [ ] **Step 2: Write the failing test**

`app/src/protocol/frames.test.ts`:
```ts
import vectors from '@vectors';
import { encode, decode, DecodeError, Op } from './frames';

const hexToBytes = (s: string) =>
  new Uint8Array(s.trim().split(/\s+/).map(h => parseInt(h, 16)));
const bytesToHex = (b: Uint8Array) =>
  Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(' ');

describe('frame codec against the shared vector contract', () => {
  for (const v of (vectors as any).vectors) {
    it(`round-trips ${v.name} byte-for-byte`, () => {
      const bytes = hexToBytes(v.bytes);
      const frame = decode(bytes);
      expect(bytesToHex(encode(frame))).toBe(bytesToHex(bytes));
    });

    it(`decodes ${v.name} to the declared opcode`, () => {
      const frame = decode(hexToBytes(v.bytes));
      expect(Op[frame.op]).toBe(v.frame.op);
      expect(frame.seq).toBe(v.frame.seq);
    });
  }

  // Timestamps must survive exactly as JS numbers. 4886718345 is the value used
  // throughout the vectors; if BigInt were needed this assertion would fail.
  it('preserves a 64-bit microsecond timestamp exactly', () => {
    const f = decode(hexToBytes(
      '01 02 02 01 89 67 45 23 01 00 00 00 2c 01 ff'));
    if (f.op !== Op.FIRE_AT) throw new Error('wrong opcode');
    expect(f.tFireUs).toBe(4886718345);
    expect(Number.isSafeInteger(f.tFireUs)).toBe(true);
  });

  it.each([
    ['SHORT',   '01 01'],
    ['VERSION', '02 01 01 00'],
    ['OPCODE',  '01 7f 01 00'],
    ['LENGTH',  '01 02 01 00 89 67'],
  ])('rejects malformed input with reason %s', (reason, hex) => {
    expect(() => decode(hexToBytes(hex)))
      .toThrow(expect.objectContaining({ reason }));
  });

  it('never produces a frame larger than the BLE MTU allows', () => {
    for (const v of (vectors as any).vectors) {
      expect(hexToBytes(v.bytes).length).toBeLessThanOrEqual(20);
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd app && npx jest src/protocol
```
Expected: FAIL — `Cannot find module './frames'`.

- [ ] **Step 4: Implement the codec**

`app/src/protocol/frames.ts`:
```ts
export enum Op {
  SYNC_REQ = 0x01, FIRE_AT = 0x02, FIRE_NOW = 0x03, CANCEL = 0x04,
  GET_STATUS = 0x05, SET_CONFIG = 0x06, SET_MODE = 0x07,
  SYNC_RESP = 0x81, FIRE_ACK = 0x82, STATUS = 0x83, ERROR = 0x84,
}

export const ACK_LATE = 1;
export const ACK_DURATION_CLAMPED = 2;
export const ACK_COOLDOWN_REJECTED = 4;

export const PROTO_VERSION = 0x01;
export const HDR_LEN = 4;
export const MAX_FRAME = 20;

export type Frame =
  | { op: Op.SYNC_REQ;   seq: number }
  | { op: Op.CANCEL;     seq: number }
  | { op: Op.GET_STATUS; seq: number }
  | { op: Op.FIRE_AT;    seq: number; tFireUs: number; durationMs: number; brightness: number }
  | { op: Op.FIRE_NOW;   seq: number; durationMs: number; brightness: number }
  | { op: Op.SET_CONFIG; seq: number; defaultDurationMs: number; brightness: number }
  | { op: Op.SET_MODE;   seq: number; mode: number }
  | { op: Op.SYNC_RESP;  seq: number; tDevUs: number; sessionId: number }
  | { op: Op.FIRE_ACK;   seq: number; tActualUs: number; sessionId: number; flags: number }
  | { op: Op.STATUS;     seq: number; mode: number; sessionId: number; batteryMv: number;
                         flags: number; uptimeS: number; fwVer: number }
  | { op: Op.ERROR;      seq: number; code: number };

export class DecodeError extends Error {
  constructor(public reason: 'SHORT' | 'VERSION' | 'OPCODE' | 'LENGTH') {
    super(`decode failed: ${reason}`);
    this.name = 'DecodeError';
  }
}

// Microseconds since boot stay under 2^53, so a 64-bit field splits exactly into
// two 32-bit halves and round-trips through `number` without loss. BigInt is
// deliberately avoided: it would spread through every arithmetic site for no gain.
const rdU16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const rdU32 = (b: Uint8Array, o: number) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const rdU64 = (b: Uint8Array, o: number) => rdU32(b, o) + rdU32(b, o + 4) * 0x100000000;

const wrU16 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
};
const wrU32 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = Math.floor(v / 0x1000000) & 0xff;
};
const wrU64 = (b: Uint8Array, o: number, v: number) => {
  wrU32(b, o, v >>> 0);
  wrU32(b, o + 4, Math.floor(v / 0x100000000));
};

function payloadLen(op: number): number {
  switch (op) {
    case Op.SYNC_REQ: case Op.CANCEL: case Op.GET_STATUS: return 0;
    case Op.FIRE_AT:    return 11;
    case Op.FIRE_NOW:   return 3;
    case Op.SET_CONFIG: return 3;
    case Op.SET_MODE:   return 1;
    case Op.SYNC_RESP:  return 12;
    case Op.FIRE_ACK:   return 13;
    case Op.STATUS:     return 13;
    case Op.ERROR:      return 1;
    default:            return -1;
  }
}

export function decode(b: Uint8Array): Frame {
  if (b.length < HDR_LEN) throw new DecodeError('SHORT');
  if (b[0] !== PROTO_VERSION) throw new DecodeError('VERSION');

  const op = b[1];
  const plen = payloadLen(op);
  if (plen < 0) throw new DecodeError('OPCODE');
  if (b.length !== HDR_LEN + plen) throw new DecodeError('LENGTH');

  const seq = rdU16(b, 2);
  const p = HDR_LEN;

  switch (op) {
    case Op.SYNC_REQ:   return { op, seq };
    case Op.CANCEL:     return { op, seq };
    case Op.GET_STATUS: return { op, seq };
    case Op.FIRE_AT:
      return { op, seq, tFireUs: rdU64(b, p), durationMs: rdU16(b, p + 8), brightness: b[p + 10] };
    case Op.FIRE_NOW:
      return { op, seq, durationMs: rdU16(b, p), brightness: b[p + 2] };
    case Op.SET_CONFIG:
      return { op, seq, defaultDurationMs: rdU16(b, p), brightness: b[p + 2] };
    case Op.SET_MODE:
      return { op, seq, mode: b[p] };
    case Op.SYNC_RESP:
      return { op, seq, tDevUs: rdU64(b, p), sessionId: rdU32(b, p + 8) };
    case Op.FIRE_ACK:
      return { op, seq, tActualUs: rdU64(b, p), sessionId: rdU32(b, p + 8), flags: b[p + 12] };
    case Op.STATUS:
      return {
        op, seq, mode: b[p], sessionId: rdU32(b, p + 1), batteryMv: rdU16(b, p + 5),
        flags: b[p + 7], uptimeS: rdU32(b, p + 8), fwVer: b[p + 12],
      };
    case Op.ERROR:
      return { op, seq, code: b[p] };
    default:
      throw new DecodeError('OPCODE');
  }
}

export function encode(f: Frame): Uint8Array {
  const plen = payloadLen(f.op);
  if (plen < 0) throw new DecodeError('OPCODE');
  const b = new Uint8Array(HDR_LEN + plen);
  b[0] = PROTO_VERSION;
  b[1] = f.op;
  wrU16(b, 2, f.seq);
  const p = HDR_LEN;

  switch (f.op) {
    case Op.FIRE_AT:
      wrU64(b, p, f.tFireUs); wrU16(b, p + 8, f.durationMs); b[p + 10] = f.brightness; break;
    case Op.FIRE_NOW:
      wrU16(b, p, f.durationMs); b[p + 2] = f.brightness; break;
    case Op.SET_CONFIG:
      wrU16(b, p, f.defaultDurationMs); b[p + 2] = f.brightness; break;
    case Op.SET_MODE:
      b[p] = f.mode; break;
    case Op.SYNC_RESP:
      wrU64(b, p, f.tDevUs); wrU32(b, p + 8, f.sessionId); break;
    case Op.FIRE_ACK:
      wrU64(b, p, f.tActualUs); wrU32(b, p + 8, f.sessionId); b[p + 12] = f.flags; break;
    case Op.STATUS:
      b[p] = f.mode; wrU32(b, p + 1, f.sessionId); wrU16(b, p + 5, f.batteryMv);
      b[p + 7] = f.flags; wrU32(b, p + 8, f.uptimeS); b[p + 12] = f.fwVer; break;
    case Op.ERROR:
      b[p] = f.code; break;
    default:
      break;
  }
  return b;
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd app && npx jest src/protocol
```
Expected: PASS — 12 round-trip tests, 12 opcode tests, the timestamp test, 4 malformed cases, and the MTU check.

- [ ] **Step 6: Commit**

```bash
git add app/src/protocol app/package.json
git commit -m "feat(app): TS frame codec verified against shared vectors"
```

---

## Task 3: Transport interface and clock sync

**Files:**
- Create: `app/src/transport/FlashTransport.ts`, `app/src/sync/ClockSync.ts`, `app/src/sync/ClockSync.test.ts`

**Interfaces:**
- Consumes: `Frame`, `Op`, `encode`, `decode` (Task 2)
- Produces:
  - `interface FlashTransport { connect(): Promise<void>; send(f: Frame): void; onFrame(cb: (f: Frame) => void): () => void; disconnect(): Promise<void>; readonly isConnected: boolean; readonly name: 'ble' | 'wifi' }`
  - `class ClockSync { constructor(t: FlashTransport); sync(rounds?: number): Promise<SyncResult>; toDeviceTime(hostUs: number): number; get offsetUs(): number; get rttUs(): number; get sessionId(): number; noteSessionId(id: number): boolean }`
  - `type SyncResult = { offsetUs: number; rttUs: number; sessionId: number }`
  - `function nowUs(): number`

`ClockSync` is pure logic over the transport interface, so it is fully testable with a fake transport and no device.

- [ ] **Step 1: Write the transport interface**

`app/src/transport/FlashTransport.ts`:
```ts
import { Frame } from '../protocol/frames';

export interface FlashTransport {
  readonly name: 'ble' | 'wifi';
  readonly isConnected: boolean;
  connect(): Promise<void>;
  send(f: Frame): void;
  /** Returns an unsubscribe function. */
  onFrame(cb: (f: Frame) => void): () => void;
  disconnect(): Promise<void>;
}
```

- [ ] **Step 2: Write the failing test**

`app/src/sync/ClockSync.test.ts`:
```ts
import { ClockSync } from './ClockSync';
import { FlashTransport } from '../transport/FlashTransport';
import { Frame, Op } from '../protocol/frames';

/**
 * A fake host clock. ClockSync takes its time source by injection rather than
 * calling nowUs() directly, so the test can advance time deterministically —
 * mocking the module under test would be circular and hoisting-dependent.
 */
function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (us: number) => { t += us; } };
}

/** A transport that answers SYNC_REQ with a scripted round-trip delay. */
function fakeTransport(clock: ReturnType<typeof fakeClock>,
                       delaysUs: number[], sessionId = 0xdeadbeef) {
  let cb: ((f: Frame) => void) | null = null;
  let i = 0;
  const t: FlashTransport = {
    name: 'wifi',
    isConnected: true,
    connect: async () => {},
    disconnect: async () => {},
    onFrame: (fn) => { cb = fn; return () => { cb = null; }; },
    send: (f) => {
      if (f.op !== Op.SYNC_REQ) return;
      const rtt = delaysUs[i++ % delaysUs.length];
      const tSend = clock.now();
      clock.advance(rtt);            // the exchange takes this long
      // Device clock sits exactly 1_000_000 us ahead of the fake host clock.
      setTimeout(() => cb?.({
        op: Op.SYNC_RESP, seq: f.seq,
        tDevUs: tSend + rtt / 2 + 1_000_000,
        sessionId,
      }), 0);
    },
  };
  return t;
}

describe('ClockSync', () => {
  it('selects the sample with the smallest round trip, not the average', async () => {
    // One fast exchange among slow ones. Averaging would be dragged upward by the
    // slow samples; min-RTT selection must ignore them. This is the NTP technique.
    const clock = fakeClock();
    const t = fakeTransport(clock, [40_000, 50_000, 2_000, 60_000, 45_000]);
    const cs = new ClockSync(t, clock.now);
    const r = await cs.sync(5);
    expect(r.rttUs).toBe(2_000);
  });

  it('estimates the offset from the fastest sample', async () => {
    const clock = fakeClock();
    const t = fakeTransport(clock, [2_000]);
    const cs = new ClockSync(t, clock.now);
    const r = await cs.sync(3);
    // Device is 1_000_000 us ahead; Cristian's estimate should land on it.
    expect(Math.abs(r.offsetUs - 1_000_000)).toBeLessThan(10);
  });

  it('reports a session id and detects when it changes', async () => {
    const clock = fakeClock();
    const t = fakeTransport(clock, [1_000], 0x11111111);
    const cs = new ClockSync(t, clock.now);
    await cs.sync(3);
    expect(cs.sessionId).toBe(0x11111111);
    expect(cs.noteSessionId(0x11111111)).toBe(false);  // unchanged
    expect(cs.noteSessionId(0x22222222)).toBe(true);   // rebooted
  });

  it('invalidates the offset once a reboot is detected', async () => {
    const clock = fakeClock();
    const t = fakeTransport(clock, [1_000], 0x11111111);
    const cs = new ClockSync(t, clock.now);
    await cs.sync(3);
    cs.noteSessionId(0x99999999);
    expect(() => cs.toDeviceTime(0)).toThrow(/re-?sync/i);
  });

  it('goes stale once the re-sync interval has elapsed', async () => {
    const clock = fakeClock();
    const t = fakeTransport(clock, [1_000]);
    const cs = new ClockSync(t, clock.now);
    await cs.sync(3);
    expect(cs.isStale()).toBe(false);
    clock.advance(31_000_000);   // 31 seconds
    expect(cs.isStale()).toBe(true);
  });

  it('rejects a sync with no successful samples', async () => {
    const dead: FlashTransport = {
      name: 'wifi', isConnected: true,
      connect: async () => {}, disconnect: async () => {},
      onFrame: () => () => {}, send: () => {},
    };
    await expect(new ClockSync(dead).sync(2)).rejects.toThrow(/no sync/i);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd app && npx jest src/sync
```
Expected: FAIL — `Cannot find module './ClockSync'`.

- [ ] **Step 4: Implement**

`app/src/sync/ClockSync.ts`:
```ts
import { FlashTransport } from '../transport/FlashTransport';
import { Frame, Op } from '../protocol/frames';

export type SyncResult = { offsetUs: number; rttUs: number; sessionId: number };

/**
 * Monotonic microseconds. Not wall-clock; only differences are meaningful.
 *
 * The coalesce MUST happen before the multiply. `??` binds looser than `*`, so
 * `perf?.now() * 1000 ?? Date.now() * 1000` parses as
 * `(perf?.now() * 1000) ?? (Date.now() * 1000)` — and with no `performance` that
 * is `undefined * 1000` = NaN, which is neither null nor undefined, so the
 * fallback never fires and every timestamp silently becomes NaN.
 *
 * `globalThis`, not `global`: RN's tsconfig declares neither Node nor DOM libs.
 */
export function nowUs(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return Math.round((perf?.now() ?? Date.now()) * 1000);
}

const SYNC_TIMEOUT_MS = 1000;

/** Crystal drift between the two boards is roughly 20-50 ppm, so an offset older
 *  than this has accumulated close to a millisecond of error. */
export const RESYNC_INTERVAL_US = 30_000_000;

export class ClockSync {
  private offset = 0;
  private rtt = 0;
  private session = 0;
  private valid = false;
  private syncedAt = 0;
  private seq = 1;

  /** The time source is injected so tests can drive it deterministically. */
  constructor(private transport: FlashTransport, private now: () => number = nowUs) {}

  get offsetUs()  { return this.offset; }
  get rttUs()     { return this.rtt; }
  get sessionId() { return this.session; }
  get isValid()   { return this.valid; }

  /** True when the offset is old enough that drift matters and a re-sync is due. */
  isStale(): boolean {
    return !this.valid || (this.now() - this.syncedAt) > RESYNC_INTERVAL_US;
  }

  /**
   * Cristian's algorithm. Keeps the sample with the SMALLEST round trip rather
   * than averaging: the fastest exchange is the least distorted by queuing delay,
   * so it gives the tightest bound on the true offset. Averaging would let one
   * slow sample drag the estimate.
   */
  async sync(rounds = 11): Promise<SyncResult> {
    let best: SyncResult | null = null;

    for (let i = 0; i < rounds; i++) {
      const t0 = this.now();
      let resp: Frame;
      try {
        resp = await this.request({ op: Op.SYNC_REQ, seq: this.seq++ });
      } catch {
        continue;   // a dropped sample is normal on UDP; keep going
      }
      const t1 = this.now();
      if (resp.op !== Op.SYNC_RESP) continue;

      const rtt = t1 - t0;
      const offset = resp.tDevUs - (t0 + rtt / 2);
      if (!best || rtt < best.rttUs) {
        best = { rttUs: rtt, offsetUs: offset, sessionId: resp.sessionId };
      }
    }

    if (!best) throw new Error('no sync response received');

    this.offset   = best.offsetUs;
    this.rtt      = best.rttUs;
    this.session  = best.sessionId;
    this.valid    = true;
    this.syncedAt = this.now();
    return best;
  }

  /** Convert a host timestamp into the device's timebase. */
  toDeviceTime(hostUs: number): number {
    if (!this.valid) throw new Error('clock offset invalid — re-sync required');
    return Math.round(hostUs + this.offset);
  }

  /**
   * Device timestamps are microseconds since ITS boot, so a reset restarts them
   * at zero and silently invalidates our offset. Every response carries
   * session_id; a change means re-sync before trusting any timestamp.
   * Returns true if the device rebooted.
   */
  noteSessionId(id: number): boolean {
    if (this.session !== 0 && id !== this.session) {
      this.valid = false;
      this.session = id;
      return true;
    }
    this.session = id;
    return false;
  }

  private request(f: Frame): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('sync timeout')); },
                               SYNC_TIMEOUT_MS);
      const off = this.transport.onFrame((in_) => {
        if (in_.seq !== f.seq) return;
        clearTimeout(timer);
        off();
        resolve(in_);
      });
      this.transport.send(f);
    });
  }
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd app && npx jest src/sync
```
Expected: PASS — four tests.

- [ ] **Step 6: Commit**

```bash
git add app/src/transport/FlashTransport.ts app/src/sync
git commit -m "feat(app): transport interface and clock sync with min-RTT selection"
```

---

## Task 4: WiFi transport

**Files:**
- Create: `app/src/transport/WifiTransport.ts`
- Modify: `app/android/app/src/main/AndroidManifest.xml`

**Interfaces:**
- Consumes: `FlashTransport` (Task 3), `encode`/`decode` (Task 2)
- Produces: `class WifiTransport implements FlashTransport` with `name = 'wifi'`

**This task carries the project's highest integration risk.** Budget a day.

- [ ] **Step 1: Install the UDP module**

```bash
cd app && npm install react-native-udp
```

- [ ] **Step 2: Add permissions**

In `app/android/app/src/main/AndroidManifest.xml`, inside `<manifest>` and before `<application>`:
```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.CHANGE_NETWORK_STATE" />
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```

- [ ] **Step 3: Implement**

`app/src/transport/WifiTransport.ts`:
```ts
import dgram from 'react-native-udp';
import { FlashTransport } from './FlashTransport';
import { Frame, encode, decode } from '../protocol/frames';

export const DEVICE_HOST = '192.168.4.1';
export const DEVICE_PORT = 4210;

export class WifiTransport implements FlashTransport {
  readonly name = 'wifi' as const;
  private socket: any = null;
  private listeners = new Set<(f: Frame) => void>();
  private connected = false;

  get isConnected() { return this.connected; }

  async connect(): Promise<void> {
    if (this.socket) return;

    this.socket = dgram.createSocket({ type: 'udp4' });

    await new Promise<void>((resolve, reject) => {
      const fail = (e: any) => reject(new Error(`UDP bind failed: ${e}`));
      this.socket.once('error', fail);
      this.socket.bind(0, () => {
        this.socket.removeListener('error', fail);
        resolve();
      });
    });

    this.socket.on('message', (msg: Uint8Array) => {
      let frame: Frame;
      try {
        frame = decode(new Uint8Array(msg));
      } catch {
        return;   // a corrupt datagram is not worth surfacing; the ack timeout covers it
      }
      for (const cb of this.listeners) cb(frame);
    });

    this.connected = true;
  }

  send(f: Frame): void {
    if (!this.socket) return;
    const bytes = Buffer.from(encode(f));
    this.socket.send(bytes, 0, bytes.length, DEVICE_PORT, DEVICE_HOST, () => {});
  }

  onFrame(cb: (f: Frame) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  async disconnect(): Promise<void> {
    this.listeners.clear();
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }
}
```

- [ ] **Step 4: Verify against real hardware**

Put the device in WiFi mode (hold BOOT for 2 s until the status LED blinks fast). Join the phone to `SmartCam-Flash-XXXX`, password `smartcam123`.

Add a temporary button to `App.tsx` that calls:
```ts
const t = new WifiTransport();
await t.connect();
t.onFrame(f => console.log('RX', JSON.stringify(f)));
t.send({ op: Op.GET_STATUS, seq: 1 });
```
Expected in Metro's console: `RX {"op":131,"seq":1,...,"fwVer":1}`.

- [ ] **Step 5: If nothing arrives, bind the process to the WiFi network**

Android detects that the ESP32's network has no internet and may route your UDP over mobile data instead — the socket looks fine and nothing arrives. If step 4 times out while the phone shows it is connected to the SoftAP, this is why.

Create `app/android/app/src/main/java/com/smartcamapp/WifiBindModule.java`:
```java
package com.smartcamapp;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import androidx.annotation.NonNull;
import com.facebook.react.bridge.*;

public class WifiBindModule extends ReactContextBaseJavaModule {
    private ConnectivityManager.NetworkCallback callback;

    WifiBindModule(ReactApplicationContext ctx) { super(ctx); }

    @NonNull @Override public String getName() { return "WifiBind"; }

    /** Pins this process's sockets to the WiFi network, whether or not it has
     *  internet. Without this, Android silently prefers mobile data. */
    @ReactMethod
    public void bindToWifi(final Promise promise) {
        ConnectivityManager cm = (ConnectivityManager)
            getReactApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);

        NetworkRequest req = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build();

        callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                cm.bindProcessToNetwork(network);
                promise.resolve(true);
            }
            @Override public void onUnavailable() {
                promise.reject("no_wifi", "no WiFi network available");
            }
        };
        cm.requestNetwork(req, callback);
    }

    @ReactMethod
    public void unbind(Promise promise) {
        ConnectivityManager cm = (ConnectivityManager)
            getReactApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        cm.bindProcessToNetwork(null);
        if (callback != null) { cm.unregisterNetworkCallback(callback); callback = null; }
        promise.resolve(true);
    }
}
```

Register it in `app/android/app/src/main/java/com/smartcamapp/MainApplication.kt` by adding `WifiBindPackage()` to the packages list, with `WifiBindPackage.java`:
```java
package com.smartcamapp;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;
import java.util.*;

public class WifiBindPackage implements ReactPackage {
    @Override public List<NativeModule> createNativeModules(ReactApplicationContext ctx) {
        return Collections.singletonList(new WifiBindModule(ctx));
    }
    @Override public List<ViewManager> createViewManagers(ReactApplicationContext ctx) {
        return Collections.emptyList();
    }
}
```

Then call it from `WifiTransport.connect()` before binding the socket:
```ts
import { NativeModules, Platform } from 'react-native';
// ...at the top of connect():
if (Platform.OS === 'android') {
  await NativeModules.WifiBind.bindToWifi();
}
```
and in `disconnect()`:
```ts
if (Platform.OS === 'android') {
  await NativeModules.WifiBind.unbind();
}
```

Rebuild with `npx react-native run-android` — native changes need a full rebuild, not a Metro reload.

- [ ] **Step 6: Commit**

```bash
git add app/src/transport/WifiTransport.ts app/android
git commit -m "feat(app): UDP transport with Android network binding"
```

---

## Task 5: BLE transport

**Files:**
- Create: `app/src/transport/BleTransport.ts`, `app/src/transport/index.ts`
- Modify: `app/android/app/src/main/AndroidManifest.xml`

**Interfaces:**
- Consumes: `FlashTransport` (Task 3), `encode`/`decode` (Task 2)
- Produces:
  - `class BleTransport implements FlashTransport` with `name = 'ble'`
  - `function createTransport(mode: 'ble' | 'wifi'): FlashTransport`

- [ ] **Step 1: Install**

```bash
cd app && npm install react-native-ble-plx
```

- [ ] **Step 2: Add BLE permissions**

In `AndroidManifest.xml`, alongside the WiFi permissions:
```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
                 android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
```

- [ ] **Step 3: Implement**

`app/src/transport/BleTransport.ts`:
```ts
import { BleManager, Device, Characteristic } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import { FlashTransport } from './FlashTransport';
import { Frame, encode, decode } from '../protocol/frames';

// Must match the firmware exactly — see transport_ble.c.
export const SERVICE_UUID = '6f9b0001-b5a3-f393-e0a9-e50e24dcca9e';
export const RX_UUID      = '6f9b0002-b5a3-f393-e0a9-e50e24dcca9e';
export const TX_UUID      = '6f9b0003-b5a3-f393-e0a9-e50e24dcca9e';
export const DEVICE_NAME  = 'SmartCam-Flash';

export class BleTransport implements FlashTransport {
  readonly name = 'ble' as const;
  private manager = new BleManager();
  private device: Device | null = null;
  private listeners = new Set<(f: Frame) => void>();
  private notifySub: { remove(): void } | null = null;

  get isConnected() { return this.device !== null; }

  async connect(): Promise<void> {
    const found = await this.scanFor(DEVICE_NAME, 10000);
    const dev = await found.connect();
    await dev.discoverAllServicesAndCharacteristics();

    // Connection interval dominates BLE latency. Android caps this at "high
    // priority" (~11.25ms) rather than honouring an arbitrary request.
    await dev.requestConnectionPriority(1 /* ConnectionPriority.High */);

    this.notifySub = dev.monitorCharacteristicForService(
      SERVICE_UUID, TX_UUID,
      (err, ch: Characteristic | null) => {
        if (err || !ch?.value) return;
        let frame: Frame;
        try {
          frame = decode(new Uint8Array(Buffer.from(ch.value, 'base64')));
        } catch {
          return;
        }
        for (const cb of this.listeners) cb(frame);
      });

    this.device = dev;
  }

  send(f: Frame): void {
    if (!this.device) return;
    const b64 = Buffer.from(encode(f)).toString('base64');
    // Write WITHOUT response: write-with-response adds a full round trip to every
    // trigger, which is exactly the latency this project measures.
    this.device
      .writeCharacteristicWithoutResponseForService(SERVICE_UUID, RX_UUID, b64)
      .catch(() => {});
  }

  onFrame(cb: (f: Frame) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  async disconnect(): Promise<void> {
    this.listeners.clear();
    this.notifySub?.remove();
    this.notifySub = null;
    if (this.device) await this.device.cancelConnection();
    this.device = null;
  }

  private scanFor(name: string, timeoutMs: number): Promise<Device> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.manager.stopDeviceScan();
        reject(new Error(`no device named ${name} found in ${timeoutMs}ms`));
      }, timeoutMs);

      this.manager.startDeviceScan([SERVICE_UUID], null, (err, dev) => {
        if (err) { clearTimeout(timer); this.manager.stopDeviceScan(); reject(err); return; }
        if (dev?.name === name) {
          clearTimeout(timer);
          this.manager.stopDeviceScan();
          resolve(dev);
        }
      });
    });
  }
}
```

`app/src/transport/index.ts`:
```ts
import { FlashTransport } from './FlashTransport';
import { BleTransport } from './BleTransport';
import { WifiTransport } from './WifiTransport';

export type TransportMode = 'ble' | 'wifi';

export function createTransport(mode: TransportMode): FlashTransport {
  return mode === 'ble' ? new BleTransport() : new WifiTransport();
}

export { FlashTransport, BleTransport, WifiTransport };
```

- [ ] **Step 4: Verify against real hardware**

Put the device in BLE mode (hold BOOT for 2 s until the LED blinks slowly). Grant the app Nearby Devices permission when prompted.

Point the temporary test button at `createTransport('ble')` and send `GET_STATUS`.
Expected: the same `STATUS` frame as over WiFi, with `mode: 0`.

Compare the two: the frames must be identical apart from `mode`. That is the transport abstraction proving itself.

- [ ] **Step 5: Commit**

```bash
git add app/src/transport app/android
git commit -m "feat(app): BLE transport matching firmware GATT layout"
```

---

## Task 6: Capture controller

**Files:**
- Create: `app/src/capture/settings.ts`, `app/src/capture/CaptureController.ts`
- Modify: `app/package.json` (vision-camera)

**Interfaces:**
- Consumes: `FlashTransport`, `ClockSync`, `nowUs` (Task 3), `Frame`/`Op` (Task 2)
- Produces:
  - `type CaptureSettings = { leadTimeMs: number; flashDurationMs: number; aeSettleMs: number; brightness: number }`
  - `const DEFAULT_SETTINGS: CaptureSettings`
  - `class CaptureController { constructor(t: FlashTransport, cs: ClockSync, s: CaptureSettings); shoot(camera: CameraRef, mode: 'scheduled' | 'naive'): Promise<ShotRecord>; }`
  - `type ShotRecord = { seq: number; mode: 'scheduled'|'naive'; tRequestedUs: number; tActualUs: number|null; schedErrorUs: number|null; rttUs: number; late: boolean; confirmed: boolean; photoPath: string|null; timestamp: number }`
  - `type CameraRef = { takePhoto(): Promise<{ path: string }> }`

- [ ] **Step 1: Install vision-camera**

```bash
cd app && npm install react-native-vision-camera
```
Add to `AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.CAMERA" />
```

- [ ] **Step 2: Write the settings module**

`app/src/capture/settings.ts`:
```ts
export type CaptureSettings = {
  /** How far in the future to schedule the fire. Must exceed worst-case one-way
   *  latency, or the command misses its deadline and the device fires LATE. */
  leadTimeMs: number;
  /** How long the LED stays lit. Must cover the phone's shutter-lag spread. */
  flashDurationMs: number;
  /** Delay from fire to takePhoto(). Gives auto-exposure time to meter the
   *  already-lit scene rather than the dark one. */
  aeSettleMs: number;
  /** Reserved: the firmware ignores this and drives the LED at DC. */
  brightness: number;
};

export const DEFAULT_SETTINGS: CaptureSettings = {
  leadTimeMs: 120,
  flashDurationMs: 300,
  aeSettleMs: 150,
  brightness: 255,
};

export const LEAD_TIME_STEP_MS = 20;
export const LEAD_TIME_MAX_MS  = 400;
```

- [ ] **Step 3: Implement the controller**

`app/src/capture/CaptureController.ts`:
```ts
import { FlashTransport } from '../transport/FlashTransport';
import { ClockSync, nowUs } from '../sync/ClockSync';
import { Frame, Op, ACK_LATE } from '../protocol/frames';
import { CaptureSettings, LEAD_TIME_STEP_MS, LEAD_TIME_MAX_MS } from './settings';

export type CameraRef = { takePhoto(): Promise<{ path: string }> };

export type ShotRecord = {
  seq: number;
  mode: 'scheduled' | 'naive';
  tRequestedUs: number;
  tActualUs: number | null;
  schedErrorUs: number | null;
  rttUs: number;
  late: boolean;
  confirmed: boolean;
  photoPath: string | null;
  timestamp: number;
};

export class CaptureController {
  private seq = 1000;

  constructor(
    private transport: FlashTransport,
    private clock: ClockSync,
    public settings: CaptureSettings,
  ) {}

  /**
   * The shot sequence. The whole point is that the flash is commanded BEFORE the
   * capture and held lit, so the exposure lands inside the window rather than on
   * an instant. That removes two problems at once: shutter lag no longer has to be
   * known, and auto-exposure meters an already-lit scene instead of a dark one.
   */
  async shoot(camera: CameraRef, mode: 'scheduled' | 'naive' = 'scheduled'): Promise<ShotRecord> {
    const seq = this.seq++;
    const s = this.settings;

    // Re-sync when invalid OR stale. Crystal drift is 20-50 ppm, so an offset
    // more than 30 s old has accumulated close to a millisecond of error — small
    // against the lit window, but it costs nothing to remove.
    if (this.clock.isStale()) await this.clock.sync();

    const ackPromise = this.awaitAck(seq, s.leadTimeMs + s.flashDurationMs + 200);

    let tRequestedUs: number;
    if (mode === 'scheduled') {
      tRequestedUs = this.clock.toDeviceTime(nowUs() + s.leadTimeMs * 1000);
      const frame: Frame = {
        op: Op.FIRE_AT, seq,
        tFireUs: tRequestedUs,
        durationMs: s.flashDurationMs,
        brightness: s.brightness,
      };
      // Sent twice on purpose. UDP can drop and BLE write-without-response has no
      // delivery guarantee; the firmware deduplicates on SEQ, so the retry is free
      // and roughly squares the odds of arrival.
      this.transport.send(frame);
      this.transport.send(frame);
    } else {
      tRequestedUs = this.clock.toDeviceTime(nowUs());
      this.transport.send({
        op: Op.FIRE_NOW, seq,
        durationMs: s.flashDurationMs,
        brightness: s.brightness,
      });
    }

    // Wait for the scene to be lit before capturing.
    const captureDelayMs = mode === 'scheduled'
      ? s.leadTimeMs + s.aeSettleMs
      : s.aeSettleMs;
    await sleep(captureDelayMs);

    let photoPath: string | null = null;
    try {
      photoPath = (await camera.takePhoto()).path;
    } catch {
      photoPath = null;   // never let a camera failure lose the timing record
    }

    const ack = await ackPromise;

    if (ack && this.clock.noteSessionId(ack.sessionId)) {
      // Device rebooted mid-session: its timebase restarted, so our offset is
      // stale. Next shot re-syncs.
      await this.clock.sync();
    }

    const late = ack ? (ack.flags & ACK_LATE) !== 0 : false;
    if (late) {
      this.settings.leadTimeMs = Math.min(
        LEAD_TIME_MAX_MS, this.settings.leadTimeMs + LEAD_TIME_STEP_MS);
    }

    return {
      seq, mode, tRequestedUs,
      tActualUs: ack?.tActualUs ?? null,
      schedErrorUs: ack ? ack.tActualUs - tRequestedUs : null,
      rttUs: this.clock.rttUs,
      late,
      confirmed: ack !== null,
      photoPath,
      timestamp: Date.now(),
    };
  }

  /**
   * Called when the app is backgrounded. Cancels any armed fire so the LED cannot
   * go off while the app is not foreground, then drops the link.
   */
  async dispose(): Promise<void> {
    try {
      this.transport.send({ op: Op.CANCEL, seq: this.seq++ });
    } catch {
      /* the link may already be gone; disconnecting is what matters */
    }
    await this.transport.disconnect();
  }

  private awaitAck(seq: number, timeoutMs: number):
      Promise<{ tActualUs: number; sessionId: number; flags: number } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { off(); resolve(null); }, timeoutMs);
      const off = this.transport.onFrame((f) => {
        if (f.op !== Op.FIRE_ACK || f.seq !== seq) return;
        clearTimeout(timer);
        off();
        resolve({ tActualUs: f.tActualUs, sessionId: f.sessionId, flags: f.flags });
      });
    });
  }
}

// Promise<void>, not Promise<unknown>: RN types setTimeout's callback as zero-arg
// rather than Node's variadic form, so an unannotated Promise's resolver arity
// mismatches and tsc rejects it (TS2345).
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
```

- [ ] **Step 4: Commit**

```bash
git add app/src/capture app/package.json app/android
git commit -m "feat(app): capture controller implementing the pre-fire lit window"
```

---

## Task 7: Telemetry and CSV export

**Files:**
- Create: `app/src/telemetry/LatencyLog.ts`, `app/src/telemetry/LatencyLog.test.ts`

**Interfaces:**
- Consumes: `ShotRecord` (Task 6)
- Produces:
  - `class LatencyLog { add(r: ShotRecord): void; get records(): ShotRecord[]; clear(): void; toCsv(): string; summary(): Summary }`
  - `type Summary = { n: number; confirmed: number; lateCount: number; rttMedianUs: number; errMedianUs: number; errMaxUs: number }`

Pure logic, so fully unit-testable.

- [ ] **Step 1: Write the failing test**

`app/src/telemetry/LatencyLog.test.ts`:
```ts
import { LatencyLog } from './LatencyLog';
import { ShotRecord } from '../capture/CaptureController';

const rec = (over: Partial<ShotRecord> = {}): ShotRecord => ({
  seq: 1, mode: 'scheduled', tRequestedUs: 1000, tActualUs: 1100,
  schedErrorUs: 100, rttUs: 3000, late: false, confirmed: true,
  photoPath: null, timestamp: 0, ...over,
});

describe('LatencyLog', () => {
  it('emits a CSV header plus one row per record', () => {
    const log = new LatencyLog();
    log.add(rec({ seq: 1 }));
    log.add(rec({ seq: 2 }));
    const lines = log.toCsv().trim().split('\n');
    expect(lines[0]).toBe('seq,mode,t_requested_us,t_actual_us,sched_error_us,rtt_us,late,confirmed,timestamp');
    expect(lines).toHaveLength(3);
  });

  it('writes an empty field for an unconfirmed shot rather than a fake number', () => {
    const log = new LatencyLog();
    log.add(rec({ confirmed: false, tActualUs: null, schedErrorUs: null }));
    expect(log.toCsv().trim().split('\n')[1]).toContain(',,,');
  });

  it('summarises using the median, so one outlier cannot dominate', () => {
    const log = new LatencyLog();
    [80, 90, 100, 110, 100000].forEach((e, i) =>
      log.add(rec({ seq: i, schedErrorUs: e })));
    const s = log.summary();
    expect(s.n).toBe(5);
    expect(s.errMedianUs).toBe(100);
    expect(s.errMaxUs).toBe(100000);
  });

  it('counts late and unconfirmed shots separately', () => {
    const log = new LatencyLog();
    log.add(rec({ late: true }));
    log.add(rec({ confirmed: false, schedErrorUs: null }));
    log.add(rec());
    const s = log.summary();
    expect(s.n).toBe(3);
    expect(s.lateCount).toBe(1);
    expect(s.confirmed).toBe(2);
  });

  it('clear() empties the log', () => {
    const log = new LatencyLog();
    log.add(rec());
    log.clear();
    expect(log.records).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd app && npx jest src/telemetry
```
Expected: FAIL — `Cannot find module './LatencyLog'`.

- [ ] **Step 3: Implement**

`app/src/telemetry/LatencyLog.ts`:
```ts
import { ShotRecord } from '../capture/CaptureController';

export type Summary = {
  n: number;
  confirmed: number;
  lateCount: number;
  rttMedianUs: number;
  errMedianUs: number;
  errMaxUs: number;
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export class LatencyLog {
  private rows: ShotRecord[] = [];

  add(r: ShotRecord) { this.rows.push(r); }
  get records() { return this.rows; }
  clear() { this.rows = []; }

  toCsv(): string {
    const head = 'seq,mode,t_requested_us,t_actual_us,sched_error_us,rtt_us,late,confirmed,timestamp';
    const body = this.rows.map(r => [
      r.seq,
      r.mode,
      r.tRequestedUs,
      r.tActualUs ?? '',        // empty, not 0 — an unconfirmed shot has no value
      r.schedErrorUs ?? '',
      r.rttUs,
      r.late ? 1 : 0,
      r.confirmed ? 1 : 0,
      r.timestamp,
    ].join(','));
    return [head, ...body].join('\n') + '\n';
  }

  summary(): Summary {
    const errs = this.rows
      .filter(r => r.schedErrorUs !== null)
      .map(r => Math.abs(r.schedErrorUs as number));
    return {
      n: this.rows.length,
      confirmed: this.rows.filter(r => r.confirmed).length,
      lateCount: this.rows.filter(r => r.late).length,
      rttMedianUs: median(this.rows.map(r => r.rttUs)),
      errMedianUs: median(errs),
      errMaxUs: errs.length ? Math.max(...errs) : 0,
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd app && npx jest src/telemetry
```
Expected: PASS — five tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/telemetry
git commit -m "feat(app): shot telemetry with CSV export and median summary"
```

---

## Task 8: Camera screen

**Files:**
- Create: `app/src/state.ts`, `app/src/ui/CameraScreen.tsx`, `app/src/ui/DiagnosticsScreen.tsx` (placeholder)
- Modify: `app/App.tsx`

**Two structural points, both settled in pre-flight review:**

1. **Shared app state lives in `app/src/state.ts`, not inside a screen.** Task 9
   needs the log and settings too, and importing app state *from a UI module*
   inverts the dependency direction and invites a real import cycle later.

   ```ts
   // app/src/state.ts
   import { LatencyLog } from './telemetry/LatencyLog';
   import { DEFAULT_SETTINGS, CaptureSettings } from './capture/settings';

   export const sharedLog = new LatencyLog();
   export const sharedSettings: CaptureSettings = { ...DEFAULT_SETTINGS };
   ```

2. **This task also creates a placeholder `DiagnosticsScreen.tsx`**, because
   `App.tsx` imports it below and Task 9 does not exist yet — without the
   placeholder the app cannot compile at the end of this task. Task 9 replaces its
   contents wholesale.

   ```tsx
   // app/src/ui/DiagnosticsScreen.tsx — replaced by Task 9
   import React from 'react';
   import { SafeAreaView, Text, Pressable, StyleSheet } from 'react-native';

   export default function DiagnosticsScreen({ onBack }: { onBack(): void }) {
     return (
       <SafeAreaView style={s.root}>
         <Pressable onPress={onBack}><Text style={s.link}>‹ Camera</Text></Pressable>
         <Text style={s.title}>Diagnostics</Text>
       </SafeAreaView>
     );
   }
   const s = StyleSheet.create({
     root:  { flex: 1, backgroundColor: '#101318', padding: 20, paddingTop: 56 },
     link:  { color: '#DE9257', fontSize: 14, fontWeight: '600' },
     title: { color: '#E3E6EA', fontSize: 26, fontWeight: '600', marginTop: 8 },
   });
   ```

**Interfaces:**
- Consumes: `createTransport` (Task 5), `ClockSync` (Task 3), `CaptureController`, `DEFAULT_SETTINGS` (Task 6), `LatencyLog` (Task 7)
- Produces: `function CameraScreen(props: { onOpenDiagnostics(): void }): JSX.Element`

- [ ] **Step 1: Implement**

`app/src/ui/CameraScreen.tsx`:
```tsx
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, AppState } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { createTransport, TransportMode } from '../transport';
import { ClockSync } from '../sync/ClockSync';
import { CaptureController, ShotRecord } from '../capture/CaptureController';
import { DEFAULT_SETTINGS } from '../capture/settings';
import { sharedLog, sharedSettings } from '../state';

export default function CameraScreen({ onOpenDiagnostics }: { onOpenDiagnostics(): void }) {
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);

  const [mode] = useState<TransportMode>('wifi');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ShotRecord | null>(null);
  const ctrl = useRef<CaptureController | null>(null);

  useEffect(() => { if (!hasPermission) requestPermission(); }, [hasPermission]);

  // Backgrounding must cancel any armed fire and drop the link. Otherwise a
  // scheduled flash could go off with the app not foreground, and the camera would
  // hold its device handle while suspended.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && ctrl.current) {
        ctrl.current.dispose();
        ctrl.current = null;
        setConnected(false);
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t = createTransport(mode);
      try {
        await t.connect();
        const cs = new ClockSync(t);
        await cs.sync();
        if (cancelled) return;
        ctrl.current = new CaptureController(t, cs, sharedSettings);
        setConnected(true);
      } catch {
        setConnected(false);   // the camera must still work without the flasher
      }
    })();
    return () => { cancelled = true; };
  }, [mode]);

  const shoot = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (ctrl.current && cameraRef.current) {
        const rec = await ctrl.current.shoot({
          takePhoto: async () => {
            const p = await cameraRef.current!.takePhoto();
            return { path: p.path };
          },
        });
        sharedLog.add(rec);
        setLast(rec);
      } else if (cameraRef.current) {
        // No flasher: still take the photo. Never block the camera on the accessory.
        await cameraRef.current.takePhoto();
      }
    } finally {
      // Respect the firmware's 500ms cooldown so the next shot is not rejected.
      setTimeout(() => setBusy(false), 600);
    }
  };

  if (!device || !hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>
          {!hasPermission ? 'Camera permission required' : 'No camera found'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Camera ref={cameraRef} style={StyleSheet.absoluteFill}
              device={device} isActive={true} photo={true} />

      <View style={styles.topBar}>
        <View style={[styles.badge, connected ? styles.badgeOk : styles.badgeOff]}>
          <Text style={styles.badgeText}>
            {connected ? `flash ready · ${mode}` : 'flash unavailable'}
          </Text>
        </View>
        <Pressable onPress={onOpenDiagnostics} hitSlop={12}>
          <Text style={styles.link}>Diagnostics</Text>
        </Pressable>
      </View>

      {last && (
        <View style={styles.readout}>
          <Text style={styles.readoutText}>
            {last.confirmed
              ? `error ${last.schedErrorUs} µs · rtt ${last.rttUs} µs${last.late ? ' · LATE' : ''}`
              : 'unconfirmed — no ack received'}
          </Text>
        </View>
      )}

      <View style={styles.bottomBar}>
        <Pressable onPress={shoot} disabled={busy}
                   style={[styles.shutter, busy && styles.shutterBusy]}>
          {busy ? <ActivityIndicator color="#101318" /> : <View style={styles.shutterInner} />}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#101318' },
  dim:    { color: '#767D87', fontSize: 15 },
  topBar: { position: 'absolute', top: 48, left: 16, right: 16,
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  badge:  { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 4 },
  badgeOk:  { backgroundColor: 'rgba(47,107,69,0.85)' },
  badgeOff: { backgroundColor: 'rgba(163,39,26,0.85)' },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  link:   { color: '#DE9257', fontSize: 13, fontWeight: '600' },
  readout: { position: 'absolute', bottom: 150, alignSelf: 'center',
             backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 6,
             borderRadius: 4 },
  readoutText: { color: '#E3E6EA', fontSize: 12, fontVariant: ['tabular-nums'] },
  bottomBar: { position: 'absolute', bottom: 48, left: 0, right: 0, alignItems: 'center' },
  shutter: { width: 74, height: 74, borderRadius: 37, backgroundColor: '#fff',
             alignItems: 'center', justifyContent: 'center' },
  shutterBusy: { backgroundColor: '#8A8F97' },
  shutterInner: { width: 62, height: 62, borderRadius: 31, borderWidth: 2, borderColor: '#101318' },
});
```

- [ ] **Step 2: Wire it into App.tsx**

`app/App.tsx`:
```tsx
import React, { useState } from 'react';
import CameraScreen from './src/ui/CameraScreen';
import DiagnosticsScreen from './src/ui/DiagnosticsScreen';

export default function App() {
  const [screen, setScreen] = useState<'camera' | 'diag'>('camera');
  return screen === 'camera'
    ? <CameraScreen onOpenDiagnostics={() => setScreen('diag')} />
    : <DiagnosticsScreen onBack={() => setScreen('camera')} />;
}
```

- [ ] **Step 3: Verify on hardware**

Device in WiFi mode, phone joined to the SoftAP. Run the app.
Expected: preview appears, badge reads "flash ready · wifi", and pressing the shutter fires the LED and shows an error figure in microseconds.

**Do this in a dim room and photograph something close.** The whole point is that the picture comes out correctly exposed — if the flash is firing but the shot is dark or blown out, `aeSettleMs` is wrong and the diagnostics screen is where you tune it.

- [ ] **Step 4: Commit**

```bash
git add app/src/ui/CameraScreen.tsx app/App.tsx
git commit -m "feat(app): camera screen with scheduled flash capture"
```

---

## Task 9: Diagnostics screen and the 2×2 experiment

**Files:**
- Create: `app/src/ui/DiagnosticsScreen.tsx`

**Interfaces:**
- Consumes: `sharedLog`, `sharedSettings` from `app/src/state.ts` (Task 8), `LatencyLog.summary()` (Task 7), `LEAD_TIME_MAX_MS` (Task 6)
- Produces: `function DiagnosticsScreen(props: { onBack(): void }): JSX.Element`

This **replaces** the placeholder Task 8 created at the same path.

This screen turns the app into the measurement instrument for the spec's experiment.

- [ ] **Step 1: Implement**

`app/src/ui/DiagnosticsScreen.tsx`:
```tsx
import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Share } from 'react-native';
import { sharedLog, sharedSettings } from '../state';
import { LEAD_TIME_MAX_MS } from '../capture/settings';

const Row = ({ label, value, onDown, onUp }: {
  label: string; value: string; onDown(): void; onUp(): void;
}) => (
  <View style={styles.row}>
    <Text style={styles.rowLabel}>{label}</Text>
    <View style={styles.stepper}>
      <Pressable onPress={onDown} style={styles.step}><Text style={styles.stepText}>−</Text></Pressable>
      <Text style={styles.rowValue}>{value}</Text>
      <Pressable onPress={onUp} style={styles.step}><Text style={styles.stepText}>+</Text></Pressable>
    </View>
  </View>
);

export default function DiagnosticsScreen({ onBack }: { onBack(): void }) {
  const [, force] = useState(0);
  const redraw = () => force(x => x + 1);
  const s = sharedLog.summary();

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const exportCsv = async () => {
    await Share.share({
      title: 'SmartCam latency log',
      message: sharedLog.toCsv(),
    });
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} hitSlop={12}><Text style={styles.link}>‹ Camera</Text></Pressable>
      <Text style={styles.h1}>Diagnostics</Text>

      <Text style={styles.h2}>Timing parameters</Text>
      <Text style={styles.help}>
        These are the experiment. Sweep AE settle to find the minimum reliable value
        for this handset; sweep lead time against measured RTT to show why each
        transport needs the headroom it needs.
      </Text>

      <Row label="Lead time"
           value={`${sharedSettings.leadTimeMs} ms`}
           onDown={() => { sharedSettings.leadTimeMs = clamp(sharedSettings.leadTimeMs - 20, 20, LEAD_TIME_MAX_MS); redraw(); }}
           onUp={()   => { sharedSettings.leadTimeMs = clamp(sharedSettings.leadTimeMs + 20, 20, LEAD_TIME_MAX_MS); redraw(); }} />

      <Row label="Flash duration"
           value={`${sharedSettings.flashDurationMs} ms`}
           onDown={() => { sharedSettings.flashDurationMs = clamp(sharedSettings.flashDurationMs - 50, 50, 1000); redraw(); }}
           onUp={()   => { sharedSettings.flashDurationMs = clamp(sharedSettings.flashDurationMs + 50, 50, 1000); redraw(); }} />

      <Row label="AE settle"
           value={`${sharedSettings.aeSettleMs} ms`}
           onDown={() => { sharedSettings.aeSettleMs = clamp(sharedSettings.aeSettleMs - 25, 0, 600); redraw(); }}
           onUp={()   => { sharedSettings.aeSettleMs = clamp(sharedSettings.aeSettleMs + 25, 0, 600); redraw(); }} />

      <Text style={styles.h2}>Results so far</Text>
      <View style={styles.stats}>
        <Stat label="shots"          value={`${s.n}`} />
        <Stat label="confirmed"      value={`${s.confirmed}`} />
        <Stat label="late"           value={`${s.lateCount}`} />
        <Stat label="rtt median"     value={`${s.rttMedianUs} µs`} />
        <Stat label="error median"   value={`${s.errMedianUs} µs`} />
        <Stat label="error max"      value={`${s.errMaxUs} µs`} />
      </View>

      <Text style={styles.help}>
        The claim to check: error median should stay flat while rtt median changes
        between transports. If it tracks rtt instead, scheduling is not working.
      </Text>

      <Pressable onPress={exportCsv} style={styles.button}>
        <Text style={styles.buttonText}>Export CSV ({s.n} shots)</Text>
      </Pressable>

      <Pressable onPress={() => { sharedLog.clear(); redraw(); }} style={[styles.button, styles.buttonGhost]}>
        <Text style={styles.buttonGhostText}>Clear log</Text>
      </Pressable>

      <Text style={styles.h2}>Running the experiment</Text>
      <Text style={styles.help}>
        Four conditions, 50 shots each, clearing the log and exporting between them:
        {'\n'}1. WiFi + scheduled   2. WiFi + naive
        {'\n'}3. BLE + scheduled    4. BLE + naive
        {'\n\n'}Switch transport by holding BOOT on the device for two seconds.
        Switch scheduled/naive in code via CaptureController.shoot(camera, 'naive').
      </Text>
    </ScrollView>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <View style={styles.stat}>
    <Text style={styles.statValue}>{value}</Text>
    <Text style={styles.statLabel}>{label}</Text>
  </View>
);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101318' },
  content: { padding: 20, paddingTop: 56, gap: 4 },
  link: { color: '#DE9257', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  h1: { color: '#E3E6EA', fontSize: 26, fontWeight: '600', marginBottom: 12 },
  h2: { color: '#E3E6EA', fontSize: 15, fontWeight: '600', marginTop: 24, marginBottom: 6 },
  help: { color: '#767D87', fontSize: 12.5, lineHeight: 18, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
         paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#2B313A' },
  rowLabel: { color: '#A8AEB7', fontSize: 14 },
  rowValue: { color: '#E3E6EA', fontSize: 14, fontWeight: '600', minWidth: 78,
              textAlign: 'center', fontVariant: ['tabular-nums'] },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  step: { width: 36, height: 32, alignItems: 'center', justifyContent: 'center',
          backgroundColor: '#1E232B', borderRadius: 4 },
  stepText: { color: '#DE9257', fontSize: 18, fontWeight: '600' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  stat: { backgroundColor: '#171B21', borderRadius: 5, padding: 12, minWidth: 96 },
  statValue: { color: '#E3E6EA', fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  statLabel: { color: '#767D87', fontSize: 11, marginTop: 2 },
  button: { backgroundColor: '#DE9257', borderRadius: 5, paddingVertical: 13,
            alignItems: 'center', marginTop: 14 },
  buttonText: { color: '#101318', fontSize: 14, fontWeight: '700' },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#2B313A' },
  buttonGhostText: { color: '#A8AEB7', fontSize: 14, fontWeight: '600' },
});
```

- [ ] **Step 2: Verify on hardware**

Open Diagnostics, take a few shots, confirm the stats update and Export CSV opens the share sheet with real rows.

- [ ] **Step 3: Commit**

```bash
git add app/src/ui/DiagnosticsScreen.tsx
git commit -m "feat(app): diagnostics screen with tunables, stats and CSV export"
```

---

## Task 10: Ground-truth shutter-lag measurement

**Files:**
- Create: `docs/measurements/shutter-lag.md`

**Interfaces:**
- Consumes: the working app (Tasks 8–9)
- Produces: a measured shutter-lag figure and photographic evidence for the report

This needs no hardware beyond what you have, and it measures the term that motivated the entire design.

- [ ] **Step 1: Set up the rig**

1. Open a millisecond stopwatch on a laptop screen — e.g. <https://www.online-stopwatch.com/> in full screen, or any counter showing hundredths.
2. Darken the room as much as possible. **The flash must be the only meaningful light**, otherwise the ambient exposure smears the reading.
3. Aim the flasher at the screen; hold the phone so the counter fills the frame.

- [ ] **Step 2: Capture**

Start the stopwatch, then take ten shots with the app in scheduled mode. Each photo freezes the counter at the instant of exposure.

- [ ] **Step 3: Read off the lag**

For each shot, the number legible in the photograph is when the exposure happened. The app's readout gives you when the flash fired. The difference is **true shutter lag on this handset** — a quantity the camera API does not expose.

- [ ] **Step 4: Record it**

`docs/measurements/shutter-lag.md`:
```markdown
# Shutter lag — ground truth

## Method

A millisecond counter on a screen, photographed in a dark room with the ESP32
flasher as the only illumination. Because the LED is the sole light source, the
number legible in each photograph is the moment of exposure. Subtracting the
commanded fire time gives true shutter lag, which no camera API reports.

Cost: nothing. Evidence: the photographs themselves.

## Results

| Shot | Fire time (app readout) | Counter in photo | Lag |
|------|------------------------|------------------|-----|
| 1    |                        |                  |     |
| 2    |                        |                  |     |

(Ten rows. Fill from the photographs.)

## Why this matters

Transport latency measured 3489 us mean (see this directory's README). If shutter
lag proves to be one to two orders of magnitude larger and more variable, that
confirms the spec's core premise: latency reduction alone could never have solved
the sync problem, because the dominant term lives inside the phone and is not
observable from the application layer. The pre-fire lit window absorbs it; nothing
else in the design could.

Set FLASH_DURATION from the observed spread: it must comfortably exceed
max(lag) - min(lag).
```

- [ ] **Step 5: Commit**

```bash
git add docs/measurements/shutter-lag.md
git commit -m "docs: shutter-lag ground-truth method and results"
```

---

## Plan 2 Completion Criteria

- [ ] `npx jest` passes: codec (against the frozen vectors), ClockSync, LatencyLog
- [ ] App connects over **both** transports and receives an identical `STATUS` frame apart from `mode`
- [ ] Pressing the shutter fires the flash and produces a **correctly exposed** photograph in a dim room
- [ ] The camera still works with the flasher switched off, badged "flash unavailable"
- [ ] Diagnostics tunables change behaviour visibly, and CSV export contains real rows
- [ ] Shutter lag measured and recorded with photographic evidence
- [ ] ≥95% correctly-lit shots in scheduled mode on both transports (spec §8.5)
- [ ] `protocol/vectors.json` unchanged since Plan 1

## Known risks

1. **Android SoftAP routing** (Task 4 step 5) — the single most likely thing to cost a day.
2. **BLE connection interval** — Android may refuse the 7.5–15 ms request and hold ~30–50 ms, inflating BLE RTT. That is a finding to report, not a bug to fix.
3. **`vision-camera` build config** — version-sensitive against the RN version; if Gradle fails, match its documented compatibility table rather than guessing.
