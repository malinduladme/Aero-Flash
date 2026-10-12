/**
 * Jest mock for react-native-ble-plx.
 *
 * The real module constructs a NativeEventEmitter at import time, which throws
 * "NativeEventEmitter requires a non-null argument" under Jest where no native
 * module exists. Without this mock, merely setting CameraScreen's `mode` to
 * 'ble' breaks the whole test suite — coupling the automated gates to a constant
 * that has to be flipped for hardware testing.
 *
 * Mirrors __mocks__/react-native-vision-camera.js, which exists for the same reason.
 */
class BleManager {
  onStateChange(listener, emitCurrentState) {
    if (emitCurrentState) {
      // Report a usable adapter synchronously. The real module is async, but a
      // timer here leaks into Jest's worker teardown ("failed to exit
      // gracefully"), and a Promise resolved during registration behaves
      // identically for our purposes.
      listener('PoweredOn');
    }
    return { remove: () => {} };
  }
  startDeviceScan(_uuids, _options, _listener) {}
  stopDeviceScan() {}
  destroy() {}
}

module.exports = {
  BleManager,
  // Types only at runtime — exported so `import { Device, Characteristic }`
  // resolves; they carry no behaviour.
  Device: class Device {},
  Characteristic: class Characteristic {},
  ConnectionPriority: { Balanced: 0, High: 1, LowPower: 2 },
  State: { PoweredOn: 'PoweredOn', PoweredOff: 'PoweredOff', Unknown: 'Unknown' },
};
