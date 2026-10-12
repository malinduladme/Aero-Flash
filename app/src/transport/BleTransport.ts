import { BleManager, Device, Characteristic } from 'react-native-ble-plx';
import { PermissionsAndroid, Platform } from 'react-native';
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
  private disconnectListeners = new Set<() => void>();
  private notifySub: { remove(): void } | null = null;
  private deviceDisconnectSub: { remove(): void } | null = null;

  get isConnected() { return this.device !== null; }

  async connect(): Promise<void> {
    await this.requestPermissions();
    // new BleManager() does not have a usable adapter state yet — it resolves
    // asynchronously. Scanning before the state reaches 'PoweredOn' fails or
    // silently yields nothing (the best-known ble-plx pitfall).
    await this.waitForPoweredOn();
    const found = await this.scanFor(DEVICE_NAME, 10000);
    let dev: Device | null = null;
    try {
      dev = await found.connect({ timeout: 10000 });
      await dev.discoverAllServicesAndCharacteristics();

      // Connection interval dominates BLE latency. Android caps this at "high
      // priority" (~11.25ms) rather than honouring an arbitrary request.
      await dev.requestConnectionPriority(1 /* ConnectionPriority.High */);

      this.notifySub = dev.monitorCharacteristicForService(
        SERVICE_UUID, TX_UUID,
        (err, ch: Characteristic | null) => {
          if (err) {
            console.warn('[ble] notification error:', err.message);
            return;
          }
          if (!ch?.value) return;
          let frame: Frame;
          try {
            frame = decode(new Uint8Array(Buffer.from(ch.value, 'base64')));
          } catch (error) {
            console.warn('[ble] invalid notification frame:', error);
            return;
          }
          for (const cb of this.listeners) cb(frame);
        });

      this.device = dev;

      // ble-plx fires this for BOTH an unexpected drop (supervision timeout,
      // out of range, ESP32 reboot) and a deliberate cancelConnection() — this
      // subscription is removed before we call cancelConnection() in our own
      // disconnect(), so by the time it fires here the drop was never asked for.
      this.deviceDisconnectSub = dev.onDisconnected(() => {
        this.device = null;
        this.notifySub?.remove();
        this.notifySub = null;
        this.deviceDisconnectSub?.remove();
        this.deviceDisconnectSub = null;
        this.manager.destroy().catch(error =>
          console.warn('[ble] manager cleanup failed:', error));
        for (const cb of this.disconnectListeners) cb();
      });
    } catch (error) {
      this.notifySub?.remove();
      this.notifySub = null;
      if (dev) await dev.cancelConnection().catch(() => {});
      throw error;
    }
  }

  send(f: Frame): void {
    if (!this.device) return;
    const b64 = Buffer.from(encode(f)).toString('base64');
    // Write WITHOUT response: write-with-response adds a full round trip to every
    // trigger, which is exactly the latency this project measures.
    this.device
      .writeCharacteristicWithoutResponseForService(SERVICE_UUID, RX_UUID, b64)
      .catch((error) => console.warn('[ble] command write failed:', error));
  }

  onFrame(cb: (f: Frame) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  onDisconnected(cb: () => void): () => void {
    this.disconnectListeners.add(cb);
    return () => { this.disconnectListeners.delete(cb); };
  }

  async disconnect(): Promise<void> {
    this.listeners.clear();
    this.disconnectListeners.clear();
    this.manager.stopDeviceScan();
    this.notifySub?.remove();
    this.notifySub = null;
    // Removed BEFORE cancelConnection() so our own deliberate disconnect
    // never replays as an "unexpected drop" to onDisconnected subscribers.
    this.deviceDisconnectSub?.remove();
    this.deviceDisconnectSub = null;
    if (this.device) await this.device.cancelConnection();
    this.device = null;
    await this.manager.destroy();
  }

  private async requestPermissions(): Promise<void> {
    if (Platform.OS !== 'android') return;

    const required = Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    const result = await PermissionsAndroid.requestMultiple(required);
    const denied = required.filter(permission =>
      result[permission] !== PermissionsAndroid.RESULTS.GRANTED);
    if (denied.length > 0) {
      throw new Error(
        `Bluetooth permission denied (${denied.join(', ')}). Allow the requested permission in Android settings.`,
      );
    }
  }

  private waitForPoweredOn(timeoutMs = 8000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // `sub` is declared with let and captured by both closures because
      // emitCurrentState=true permits onStateChange to fire SYNCHRONOUSLY when
      // the adapter is already on. With `const sub = ...` the callback would run
      // before the binding is initialised and throw a temporal-dead-zone
      // ReferenceError. `settled` covers the same race: a synchronous emit
      // resolves before there is a subscription object to remove, so the removal
      // has to be deferred to the assignment below.
      let sub: { remove(): void } | null = null;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub?.remove();
        fn();
      };

      const timer = setTimeout(
        () => finish(() => reject(new Error('Bluetooth is off or unavailable. Turn on Bluetooth and retry.'))),
        timeoutMs,
      );

      sub = this.manager.onStateChange((state) => {
        if (state === 'PoweredOn') finish(resolve);
        else if (state === 'Unauthorized') {
          finish(() => reject(new Error('Android denied Bluetooth access. Allow Bluetooth permissions for SmartCam.')));
        }
      }, true);

      // If the emit was synchronous, finish() ran before `sub` was assigned and
      // could not remove it. Clean up now.
      if (settled) { sub.remove(); sub = null; }
    });
  }

  private scanFor(name: string, timeoutMs: number): Promise<Device> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.manager.stopDeviceScan();
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error(
          `No BLE device named "${name}" found. Hold the ESP32 BOOT button for 2 seconds until its LED blinks slowly, then retry.`,
        )));
      }, timeoutMs);

      // Scan UNFILTERED and match on name. The firmware's advertisement packet
      // carries only flags and the device name — it does not include the service
      // UUID (see transport_ble.c start_advertising). Passing [SERVICE_UUID] here
      // filters out the very device we are looking for. This is also why nRF
      // Connect finds it: that app scans unfiltered too.
      try {
        this.manager.startDeviceScan(null, null, (err, dev) => {
          if (err) { finish(() => reject(err)); return; }
          if (dev?.name === name || dev?.localName === name) {
            finish(() => resolve(dev));
          }
        });
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }
}
