import dgram from 'react-native-udp';
import { NativeModules, Platform } from 'react-native';
import { Buffer } from 'buffer';
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

    // The ESP32 SoftAP has no internet. Android notices and may silently route
    // this process's UDP traffic over mobile data instead, leaving the socket
    // looking healthy while nothing ever arrives. Binding the process to the
    // WiFi network (even though it lacks NET_CAPABILITY_INTERNET) fixes that.
    if (Platform.OS === 'android') {
      await NativeModules.WifiBind.bindToWifi();
    }

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

  /**
   * UDP is connectionless — there is no socket-level "disconnected" event to
   * hook (no supervision timeout, no link to drop). This is a deliberate
   * no-op, not a stub: WiFi transport health can only be inferred from ack
   * timeouts, which CaptureController/ClockSync already handle on their own.
   */
  onDisconnected(_cb: () => void): () => void {
    return () => {};
  }

  async disconnect(): Promise<void> {
    this.listeners.clear();
    this.socket?.close();
    this.socket = null;
    this.connected = false;

    if (Platform.OS === 'android') {
      await NativeModules.WifiBind.unbind();
    }
  }
}
