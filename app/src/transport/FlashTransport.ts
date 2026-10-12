import { Frame } from '../protocol/frames';

export interface FlashTransport {
  readonly name: 'ble' | 'wifi';
  readonly isConnected: boolean;
  connect(): Promise<void>;
  send(f: Frame): void;
  /** Returns an unsubscribe function. */
  onFrame(cb: (f: Frame) => void): () => void;
  /**
   * Fires when the link drops unexpectedly — BLE supervision timeout, out of
   * range, ESP32 reboot — as opposed to a deliberate disconnect() call.
   * Returns an unsubscribe function.
   */
  onDisconnected(cb: () => void): () => void;
  disconnect(): Promise<void>;
}
