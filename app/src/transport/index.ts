import { FlashTransport } from './FlashTransport';
import { BleTransport } from './BleTransport';
import { WifiTransport } from './WifiTransport';

export type TransportMode = 'ble' | 'wifi';

export function createTransport(mode: TransportMode): FlashTransport {
  return mode === 'ble' ? new BleTransport() : new WifiTransport();
}

// isolatedModules (set by @react-native/typescript-config) requires type-only
// re-exports to use `export type`, since FlashTransport is an interface with
// no runtime representation to re-export.
export type { FlashTransport };
export { BleTransport, WifiTransport };
