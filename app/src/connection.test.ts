import { Frame } from './protocol/frames';
import { FlashTransport } from './transport/FlashTransport';
import type { ConnStatus } from './connection';

/**
 * A minimal fake FlashTransport. connect()/disconnect() behaviour is
 * injected per test via overrides; onDisconnected() is captured so tests can
 * simulate an unexpected drop with __fireDisconnected().
 */
function makeFakeTransport(overrides?: Partial<FlashTransport>): FlashTransport & {
  __fireDisconnected(): void;
} {
  const disconnectListeners = new Set<() => void>();
  return {
    name: 'ble',
    isConnected: true,
    connect: jest.fn().mockResolvedValue(undefined),
    send: jest.fn(),
    onFrame: jest.fn((_cb: (f: Frame) => void) => () => {}),
    onDisconnected: jest.fn((cb: () => void) => {
      disconnectListeners.add(cb);
      return () => disconnectListeners.delete(cb);
    }),
    disconnect: jest.fn().mockResolvedValue(undefined),
    __fireDisconnected() {
      for (const cb of disconnectListeners) cb();
    },
    ...overrides,
  };
}

describe('connection', () => {
  let createTransportMock: jest.Mock;
  let probeLinkQualityMock: jest.Mock;
  let connection: typeof import('./connection');

  beforeEach(() => {
    jest.resetModules();
    createTransportMock = jest.fn();
    probeLinkQualityMock = jest.fn().mockResolvedValue({
      samples: 0, medianRttUs: null, packetLossPercent: null, state: 'checking',
    });
    jest.doMock('./transport', () => ({
      createTransport: createTransportMock,
    }));
    // Connection lifecycle tests don't need a real request/response exchange,
    // but the interval-based quality monitor does call probeLinkQuality().
    jest.doMock('./sync/ClockSync', () => ({
      ClockSync: jest.fn().mockImplementation(() => ({
        sync: jest.fn().mockResolvedValue(undefined),
        probeLinkQuality: probeLinkQualityMock,
        linkQuality: { samples: 0, medianRttUs: null, packetLossPercent: null, state: 'checking' },
        offsetUs: 0,
        isStale: jest.fn().mockReturnValue(false),
      })),
    }));
    connection = require('./connection');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('(a) two concurrent ensureConnected() calls produce one connect attempt', async () => {
    const transport = makeFakeTransport();
    createTransportMock.mockReturnValue(transport);

    const p1 = connection.ensureConnected('ble');
    const p2 = connection.ensureConnected('ble');
    await Promise.all([p1, p2]);

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(connection.getStatus()).toBe('connected');
    expect(connection.getController()).not.toBeNull();
  });

  it('(b) a failed connect leaves status error, and a later call can retry', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = makeFakeTransport({
      connect: jest.fn().mockRejectedValue(new Error('no slot')),
    });
    createTransportMock.mockReturnValueOnce(failing);

    await connection.ensureConnected('ble');

    expect(connection.getStatus()).toBe('error');
    expect(connection.getLastConnectionError()).toBe('no slot');
    expect(connection.getController()).toBeNull();

    const working = makeFakeTransport();
    createTransportMock.mockReturnValueOnce(working);

    await connection.ensureConnected('ble');

    expect(connection.getStatus()).toBe('connected');
    expect(connection.getLastConnectionError()).toBeNull();
    expect(connection.getController()).not.toBeNull();
    warnSpy.mockRestore();
  });

  it('(c) a transport disconnect triggers exactly one automatic reconnect attempt', async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const first = makeFakeTransport();
    createTransportMock.mockReturnValueOnce(first);
    await connection.ensureConnected('ble');
    expect(connection.getStatus()).toBe('connected');

    // The retry attempt also fails, to prove it doesn't spawn a further retry.
    const retry = makeFakeTransport({
      connect: jest.fn().mockRejectedValue(new Error('still down')),
    });
    createTransportMock.mockReturnValueOnce(retry);

    first.__fireDisconnected();
    expect(connection.getStatus()).toBe('error');
    expect(createTransportMock).toHaveBeenCalledTimes(1); // no reconnect yet — it's delayed

    await jest.advanceTimersByTimeAsync(2000);
    expect(createTransportMock).toHaveBeenCalledTimes(2); // exactly one retry
    expect(connection.getStatus()).toBe('error'); // the retry itself failed

    // Advancing well past the retry delay again must not trigger another attempt.
    await jest.advanceTimersByTimeAsync(30000);
    expect(createTransportMock).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it('(d) teardown() disposes and resets so ensureConnected() works afterwards', async () => {
    const transport = makeFakeTransport();
    createTransportMock.mockReturnValueOnce(transport);
    await connection.ensureConnected('ble');
    expect(connection.getStatus()).toBe('connected');

    await connection.teardown();

    expect(connection.getStatus()).toBe('idle');
    expect(connection.getController()).toBeNull();
    expect(transport.disconnect).toHaveBeenCalled();

    const transport2 = makeFakeTransport();
    createTransportMock.mockReturnValueOnce(transport2);
    await connection.ensureConnected('ble');

    expect(connection.getStatus()).toBe('connected');
    expect(connection.getController()).not.toBeNull();
  });

  it('(e) subscribers are notified on status change, and unsubscribe stops notifications', async () => {
    const events: ConnStatus[] = [];
    const unsub = connection.subscribe((s) => events.push(s));

    const transport = makeFakeTransport();
    createTransportMock.mockReturnValueOnce(transport);
    await connection.ensureConnected('ble');

    expect(events).toEqual(['connecting', 'connected']);

    unsub();
    await connection.teardown();

    // No 'idle' event recorded after unsubscribing.
    expect(events).toEqual(['connecting', 'connected']);
  });

  it('(f) switchMode() tears down the old transport before creating the new one', async () => {
    const bleTransport = makeFakeTransport({ name: 'ble' });
    createTransportMock.mockReturnValueOnce(bleTransport);
    await connection.ensureConnected('ble');
    expect(connection.getStatus()).toBe('connected');

    const order: string[] = [];
    bleTransport.disconnect = jest.fn().mockImplementation(async () => {
      order.push('old-disconnect');
    });
    const wifiTransport = makeFakeTransport({ name: 'wifi' });
    wifiTransport.connect = jest.fn().mockImplementation(async () => {
      order.push('new-connect');
    });
    createTransportMock.mockReturnValueOnce(wifiTransport);

    await connection.switchMode('wifi');

    expect(order).toEqual(['old-disconnect', 'new-connect']);
    expect(connection.getStatus()).toBe('connected');
    expect(createTransportMock).toHaveBeenLastCalledWith('wifi');
  });

  it('(g) switchMode() called twice in quick succession settles on the last requested mode, with no orphaned connection', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const initial = makeFakeTransport({ name: 'ble' });
    createTransportMock.mockReturnValueOnce(initial);
    await connection.ensureConnected('ble');

    // First switch to 'wifi' — its connect() never resolves on its own; we
    // control exactly when it settles below, so we can start the second
    // switchMode() while the first is still in flight.
    let resolveFirstConnect!: () => void;
    const first = makeFakeTransport({
      name: 'wifi',
      connect: jest.fn().mockImplementation(
        () => new Promise<void>((resolve) => { resolveFirstConnect = resolve; }),
      ),
    });
    createTransportMock.mockReturnValueOnce(first);

    const second = makeFakeTransport({ name: 'ble' });
    createTransportMock.mockReturnValueOnce(second);

    const p1 = connection.switchMode('wifi');
    // Let switchMode('wifi')'s teardown()+ensureConnected() run far enough
    // to actually call connect() on the new (pending) transport before
    // firing the second switch — polling rather than counting a fixed
    // number of microtask ticks, since teardown()'s own await chain length
    // is an implementation detail this test shouldn't have to track.
    for (let i = 0; i < 50 && (first.connect as jest.Mock).mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(first.connect).toHaveBeenCalled();
    const p2 = connection.switchMode('ble');

    // Now let the first (superseded) connect settle — it must be discarded,
    // not resurrected as the live connection.
    resolveFirstConnect();

    await Promise.all([p1, p2]);

    expect(connection.getStatus()).toBe('connected');
    // The superseded 'wifi' attempt must have been disconnected once it
    // discovered it was stale, not left open.
    expect(first.disconnect).toHaveBeenCalled();
    // The last requested mode ('ble') is the one actually left connected.
    expect(createTransportMock).toHaveBeenLastCalledWith('ble');
    expect(second.disconnect).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('(h) status subscribers see the intermediate "connecting" state during a switch', async () => {
    const initial = makeFakeTransport();
    createTransportMock.mockReturnValueOnce(initial);
    await connection.ensureConnected('ble');

    const events: ConnStatus[] = [];
    const unsub = connection.subscribe((s) => events.push(s));

    const next = makeFakeTransport();
    createTransportMock.mockReturnValueOnce(next);
    await connection.switchMode('wifi');

    expect(events).toEqual(['idle', 'connecting', 'connected']);
    unsub();
  });

  it('(i) polls link quality once per second and stops polling after teardown', async () => {
    jest.useFakeTimers();
    const transport = makeFakeTransport();
    createTransportMock.mockReturnValueOnce(transport);
    await connection.ensureConnected('wifi');

    await jest.advanceTimersByTimeAsync(999);
    expect(probeLinkQualityMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(probeLinkQualityMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(probeLinkQualityMock).toHaveBeenCalledTimes(2);

    await connection.teardown();
    await jest.advanceTimersByTimeAsync(5000);
    expect(probeLinkQualityMock).toHaveBeenCalledTimes(2);
  });
});
