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
    onDisconnected: () => () => {},
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

  it('reports rolling link quality from RTT samples', async () => {
    const clock = fakeClock();
    const t = fakeTransport(clock, [30_000, 50_000, 70_000, 80_000, 10_000]);
    const cs = new ClockSync(t, clock.now);

    for (let i = 0; i < 5; i++) await cs.probeLinkQuality();

    expect(cs.linkQuality).toEqual({
      samples: 5,
      medianRttUs: 50_000,
      packetLossPercent: 0,
      state: 'fair',
    });
  });

  it('probes link quality without changing the flash clock offset', async () => {
    const clock = fakeClock();
    const t = fakeTransport(clock, [2_000, 30_000]);
    const cs = new ClockSync(t, clock.now);
    await cs.sync(1);
    const offsetBeforeProbe = cs.offsetUs;

    const quality = await cs.probeLinkQuality();

    expect(quality.samples).toBe(1);
    expect(quality.medianRttUs).toBe(30_000);
    expect(cs.offsetUs).toBe(offsetBeforeProbe);
  });

  it('keeps only the most recent ten link-quality samples', async () => {
    const clock = fakeClock();
    const t = fakeTransport(clock, Array.from({ length: 12 }, (_, i) => (i + 1) * 1000));
    const cs = new ClockSync(t, clock.now);

    for (let i = 0; i < 12; i++) await cs.probeLinkQuality();

    expect(cs.linkQuality.samples).toBe(10);
    expect(cs.linkQuality.medianRttUs).toBe(8000);
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
      onFrame: () => () => {}, onDisconnected: () => () => {}, send: () => {},
    };
    await expect(new ClockSync(dead).sync(2)).rejects.toThrow(/no sync/i);
  });
});
