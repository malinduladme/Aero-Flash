import { createTransport, TransportMode, FlashTransport } from './transport';
import { ClockSync } from './sync/ClockSync';
import { CaptureController } from './capture/CaptureController';
import { sharedSettings, setCurrentMode } from './state';

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'error';

// One automatic retry after an unexpected drop, then leave status 'error' so
// the UI shows the truth. A silent infinite retry loop would hide a real
// fault and drain the battery.
const RECONNECT_DELAY_MS = 2000;
const LINK_QUALITY_INTERVAL_MS = 1000;

/**
 * Module-level singleton owning the transport, ClockSync and
 * CaptureController for the app's single flash accessory link.
 *
 * This exists because CameraScreen — the component that used to own these —
 * unmounts on every navigation to the Gallery. The ESP32 firmware allows
 * exactly one BLE connection (CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1), so a link
 * left open by an unmounted screen strands the phone: the next mount's
 * connect() attempt finds no slot free. Owning the lifecycle here, outside
 * any component, means it survives navigation and is only torn down on a
 * deliberate teardown() (e.g. the app backgrounding).
 */
let transport: FlashTransport | null = null;
let controller: CaptureController | null = null;
let status: ConnStatus = 'idle';
let lastConnectionError: string | null = null;
let inFlight: Promise<void> | null = null;
let unsubDisconnect: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let linkQualityTimer: ReturnType<typeof setInterval> | null = null;
let linkQualityProbeInFlight = false;
let linkQualityMonitorGeneration = 0;

// Bumped by teardown() so a connect attempt still in flight at the time can
// tell it's been superseded and discard its result instead of resurrecting
// a connection nothing is tracking anymore.
let generation = 0;

const subscribers = new Set<(s: ConnStatus) => void>();

function setStatus(next: ConnStatus): void {
  status = next;
  for (const cb of subscribers) cb(next);
}

export function getController(): CaptureController | null {
  return controller;
}

export function getStatus(): ConnStatus {
  return status;
}

export function getLastConnectionError(): string | null {
  return lastConnectionError;
}

export function subscribe(cb: (s: ConnStatus) => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

/**
 * Idempotent and safe to call concurrently. If a connect attempt is already
 * in flight, every caller shares that same promise rather than racing a
 * second attempt — the ESP32's single connection slot means a second
 * concurrent attempt would just fail. A no-op if already connected.
 */
export function ensureConnected(mode: TransportMode): Promise<void> {
  if (status === 'connected' && controller) return Promise.resolve();
  if (inFlight) return inFlight;

  const myGeneration = generation;
  inFlight = (async () => {
    lastConnectionError = null;
    setStatus('connecting');
    const t = createTransport(mode);
    try {
      await t.connect();
      const cs = new ClockSync(t);
      await cs.sync();

      if (myGeneration !== generation) {
        // teardown() ran while this attempt was in flight — discard rather
        // than assigning a connection nothing will ever dispose.
        await t.disconnect().catch(() => {});
        return;
      }

      controller = new CaptureController(t, cs, sharedSettings);
      transport = t;
      unsubDisconnect = t.onDisconnected(() => handleUnexpectedDisconnect(mode));
      startLinkQualityMonitor();
      setStatus('connected');
    } catch (e) {
      console.warn('[connection] connect failed:', e);
      // t.connect() may have partially succeeded (e.g. sync failed after the
      // radio link came up) — never leave an orphaned link behind, or the
      // ESP32's one connection slot stays occupied by nothing.
      await t.disconnect().catch(() => {});
      if (myGeneration === generation) {
        controller = null;
        transport = null;
        lastConnectionError = e instanceof Error ? e.message : String(e);
        setStatus('error');
      }
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Fired when the transport reports the link dropped on its own (BLE
 * supervision timeout, out of range, ESP32 reboot) rather than through our
 * own teardown(). Schedules exactly one reconnect attempt; further drops
 * during that attempt are handled the same way (one retry each), but a
 * still-down accessory after the retry is left as status 'error' rather than
 * being retried forever.
 */
function handleUnexpectedDisconnect(mode: TransportMode): void {
  stopLinkQualityMonitor();
  unsubDisconnect = null;
  controller = null;
  transport = null;
  lastConnectionError = 'The flash unit disconnected. Check its power, radio mode and range, then retry.';
  setStatus('error');

  if (reconnectTimer) return; // a retry is already scheduled
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureConnected(mode);
  }, RECONNECT_DELAY_MS);
}

function startLinkQualityMonitor(): void {
  stopLinkQualityMonitor();
  const monitorGeneration = linkQualityMonitorGeneration;
  linkQualityTimer = setInterval(() => {
    if (!controller || linkQualityProbeInFlight || status !== 'connected') return;
    const activeController = controller;
    linkQualityProbeInFlight = true;
    activeController.refreshLinkQuality()
      .catch((e) => console.warn('[connection] link-quality probe failed:', e))
      .finally(() => {
        if (monitorGeneration === linkQualityMonitorGeneration) {
          linkQualityProbeInFlight = false;
        }
      });
  }, LINK_QUALITY_INTERVAL_MS);
}

function stopLinkQualityMonitor(): void {
  linkQualityMonitorGeneration++;
  if (linkQualityTimer) clearInterval(linkQualityTimer);
  linkQualityTimer = null;
  linkQualityProbeInFlight = false;
}

/**
 * Switches the active transport at runtime (e.g. from the Diagnostics
 * screen mid-demo). Tears down the existing connection fully, records the
 * new mode in shared state, then reconnects with it.
 *
 * Safe to call while a connect — or another switchMode() — is already in
 * flight. It deliberately does not add a second in-flight/generation
 * mechanism: teardown() already bumps `generation` and clears `inFlight`
 * synchronously, so a stale connect attempt still running in the background
 * discovers on completion that it's been superseded (see the generation
 * check in ensureConnected()) and discards its result instead of
 * resurrecting a connection nothing is tracking. Two switchMode() calls in
 * quick succession therefore settle on whichever was requested last, with
 * no orphaned connection left open.
 */
export async function switchMode(m: TransportMode): Promise<void> {
  await teardown();
  setCurrentMode(m);
  await ensureConnected(m);
}

/** Disposes the live connection (if any) and drops all refs so a later
 *  ensureConnected() starts clean. */
export async function teardown(): Promise<void> {
  generation++;
  stopLinkQualityMonitor();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  unsubDisconnect?.();
  unsubDisconnect = null;

  const c = controller;
  const t = transport;
  controller = null;
  transport = null;
  inFlight = null;

  try {
    if (c) {
      await c.dispose(); // sends CANCEL, then disconnects the transport
    } else if (t) {
      await t.disconnect();
    }
  } catch {
    /* the link may already be gone; dropping refs is what matters */
  }

  lastConnectionError = null;
  setStatus('idle');
}
