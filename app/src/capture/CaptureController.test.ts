import { CaptureController, CameraRef } from './CaptureController';
import { ClockSync } from '../sync/ClockSync';
import { FlashTransport } from '../transport/FlashTransport';
import {
  Frame, Op, ACK_LATE, ACK_COOLDOWN_REJECTED, ACK_FIRED,
} from '../protocol/frames';
import {
  CaptureSettings, DEFAULT_SETTINGS,
  DEFAULT_XENON_FLASH_DELAY_MS,
  XENON_FLASH_DELAY_MAX_MS, XENON_FLASH_DELAY_STEP_MS,
  RESET_XENON_FLASH_DELAY_MS, autoTuneXenonFlashDelay,
  resetAutoTunedXenonFlashDelay,
  setXenonFlashDelayToTarget,
} from './settings';

/**
 * A host clock ClockSync can be driven with directly, independent of Jest's
 * fake timers. Only relative motion matters for these tests, so it starts at
 * an arbitrary nonzero value and only moves when a test calls `advance`.
 */
function fakeHostClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (us: number) => { t += us; } };
}

type AckConfig = {
  enabled: boolean;
  delayMs: number;
  sessionId: number;
  flags: number;
  tActualUs: number | ((f: Frame & { op: Op.FIRE_AT | Op.FIRE_NOW }) => number);
};

type FakeTransport = FlashTransport & {
  sent: Frame[];
  ackConfig: AckConfig;
  syncSessionId: number;
};

/**
 * A transport that logs every send into a shared `events` array (so tests can
 * assert ordering across the transport and the camera), auto-answers
 * SYNC_REQ, and optionally auto-answers FIRE_AT/FIRE_NOW with a FIRE_ACK
 * per the scripted `ackConfig`.
 */
function makeFakeTransport(events: string[]): FakeTransport {
  const listeners = new Set<(f: Frame) => void>();
  const t: FakeTransport = {
    name: 'wifi',
    isConnected: true,
    connect: async () => {},
    disconnect: async () => { events.push('disconnect'); },
    onFrame: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onDisconnected: () => () => {},
    send: (f: Frame) => {
      events.push(`send:${Op[f.op]}:${f.seq}`);
      t.sent.push(f);

      if (f.op === Op.SYNC_REQ) {
        setTimeout(() => {
          const resp: Frame = { op: Op.SYNC_RESP, seq: f.seq, tDevUs: 5_000_000, sessionId: t.syncSessionId };
          listeners.forEach(cb => cb(resp));
        }, 0);
      } else if ((f.op === Op.FIRE_AT || f.op === Op.FIRE_NOW) && t.ackConfig.enabled) {
        const cfg = t.ackConfig;
        setTimeout(() => {
          const tActualUs = typeof cfg.tActualUs === 'function'
            ? cfg.tActualUs(f as Frame & { op: Op.FIRE_AT | Op.FIRE_NOW })
            : cfg.tActualUs;
          const resp: Frame = { op: Op.FIRE_ACK, seq: f.seq, tActualUs, sessionId: cfg.sessionId, flags: cfg.flags };
          events.push(`ack:${f.seq}`);
          listeners.forEach(cb => cb(resp));
        }, cfg.delayMs);
      }
    },
    sent: [],
    syncSessionId: 0x1111,
    ackConfig: {
      enabled: true,
      delayMs: 10,
      sessionId: 0x1111,
      flags: ACK_FIRED,
      tActualUs: f => f.op === Op.FIRE_AT ? f.tFireUs : 5_000_000,
    },
  };
  return t;
}

function makeFakeCamera(events: string[], opts?: { fail?: boolean; path?: string }): CameraRef {
  return {
    takePhoto: async (onShutter) => {
      events.push('takePhoto');
      onShutter();
      if (opts?.fail) throw new Error('camera failure');
      return { path: opts?.path ?? '/tmp/photo.jpg' };
    },
  };
}

/** Runs `controller.shoot(...)`, driving fake timers far enough that every
 *  scheduled sleep/timeout/ack in the chain gets to fire. */
async function runShoot(
  controller: CaptureController, camera: CameraRef, mode: 'scheduled' | 'naive' = 'scheduled',
) {
  const p = controller.shoot(camera, mode);
  await jest.advanceTimersByTimeAsync(5_000);
  return p;
}

async function setup(
  overrides?: Partial<CaptureSettings>,
  hostNow?: () => number,
) {
  const events: string[] = [];
  const hostClock = fakeHostClock();
  const now = hostNow ?? hostClock.now;
  const transport = makeFakeTransport(events);
  const clock = new ClockSync(transport, now);

  // Pre-sync so isStale() is false and shoot() doesn't need its own resync.
  const syncPromise = clock.sync(1);
  await jest.advanceTimersByTimeAsync(0);
  await syncPromise;
  events.length = 0; // don't let setup pollute the ordering/send log
  transport.sent.length = 0;

  const settings: CaptureSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const controller = new CaptureController(transport, clock, settings, now);
  return { events, transport, clock, controller, settings, hostClock };
}

describe('CaptureController', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('(a) requests the camera before FIRE_AT, which remains scheduled in the future', async () => {
    const { events, transport, controller, clock, hostClock } = await setup();
    const camera = makeFakeCamera(events);

    const before = hostClock.now();
    const record = await runShoot(controller, camera, 'scheduled');

    const firstSendIdx = events.findIndex(e => e.startsWith('send:FIRE_AT'));
    const takePhotoIdx = events.indexOf('takePhoto');
    expect(firstSendIdx).toBeGreaterThanOrEqual(0);
    expect(takePhotoIdx).toBeGreaterThanOrEqual(0);
    expect(firstSendIdx).toBeGreaterThan(takePhotoIdx);

    // The requested device fire time must be ahead of "now" (converted to
    // device time) by roughly leadTimeMs, i.e. strictly in the future.
    const nowDeviceTime = clock.toDeviceTime(before);
    expect(record.tRequestedUs).toBeGreaterThan(nowDeviceTime);
    expect(transport.sent[0].op).toBe(Op.FIRE_AT);
    expect(record.cameraShutterAtHostUs).not.toBeNull();
    expect(record.captureCompletedAtHostUs).not.toBeNull();
    expect(record.flashActualAtHostUs).not.toBeNull();
  });

  it('records FIRE command-to-ACK time separately from clock-sync RTT', async () => {
    const timerOriginMs = jest.now();
    const hostNow = () => 1_000_000 + (jest.now() - timerOriginMs) * 1000;
    const { controller, clock } = await setup(undefined, hostNow);
    const record = await runShoot(controller, makeFakeCamera([]));

    expect(record.commandToAckUs).toBe(10_000);
    expect(record.syncRttUs).toBe(clock.rttUs);
  });

  it('keeps the target fixed and sends earlier when lead time increases', async () => {
    const { events, transport, controller, hostClock, clock, settings } =
      await setup({ xenonFlashDelayMs: 100, leadTimeMs: 40 });
    const camera: CameraRef = {
      takePhoto: async () => {
        events.push('takePhoto');
        return { path: '/tmp/no-shutter-callback.jpg' };
      },
    };

    const shot = controller.shoot(camera);
    await jest.advanceTimersByTimeAsync(0);
    expect(events.indexOf('takePhoto')).toBeGreaterThanOrEqual(0);
    expect(transport.sent.filter(f => f.op === Op.FIRE_AT)).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(60);
    expect(transport.sent.filter(f => f.op === Op.FIRE_AT)).toHaveLength(2);
    const requestedTarget = transport.sent.find(f => f.op === Op.FIRE_AT);
    expect(requestedTarget?.op).toBe(Op.FIRE_AT);
    if (requestedTarget?.op !== Op.FIRE_AT) throw new Error('expected FIRE_AT');
    expect(requestedTarget.tFireUs).toBe(clock.toDeviceTime(hostClock.now() + 100_000));

    settings.leadTimeMs = 100;
    const next = controller.shoot(camera);
    await jest.advanceTimersByTimeAsync(5_000);
    const secondTarget = transport.sent.filter(f => f.op === Op.FIRE_AT).slice(-2)[0];
    expect(secondTarget?.op).toBe(Op.FIRE_AT);
    if (secondTarget?.op !== Op.FIRE_AT) throw new Error('expected FIRE_AT');
    expect(secondTarget.tFireUs).toBe(requestedTarget.tFireUs);
    await next;
    await jest.advanceTimersByTimeAsync(5_000);
    await shot;
  });

  it('sets xenon delay in 10ms steps with a 1200ms maximum', () => {
    expect(DEFAULT_SETTINGS.xenonFlashDelayMs).toBe(DEFAULT_XENON_FLASH_DELAY_MS);
    expect(RESET_XENON_FLASH_DELAY_MS).toBe(500);
    expect(DEFAULT_SETTINGS.leadTimeMs).toBe(40);
    expect(XENON_FLASH_DELAY_STEP_MS).toBe(10);
    expect(XENON_FLASH_DELAY_MAX_MS).toBe(1200);
  });

  it('leaves lead time unchanged across link-quality probes', async () => {
    const { controller, settings, clock } = await setup();
    settings.leadTimeMs = 200;
    const good = {
      samples: 10, medianRttUs: 10_000, packetLossPercent: 0, state: 'good' as const,
    };
    const probe = jest.spyOn(clock, 'probeLinkQuality').mockResolvedValue(good);

    await controller.refreshLinkQuality();
    probe.mockResolvedValue({
      samples: 10, medianRttUs: 500_000, packetLossPercent: 50, state: 'poor',
    });
    await controller.refreshLinkQuality();

    expect(settings.leadTimeMs).toBe(200);
  });

  it('continually adjusts the delay from each confirmed shutter/flash timing pair', async () => {
    const timerOriginMs = jest.now();
    const hostOriginUs = 1_000_000;
    const hostNow = () => hostOriginUs + (jest.now() - timerOriginMs) * 1000;
    const { transport, clock, settings } = await setup({ xenonFlashDelayMs: 200 }, hostNow);
    let shutterDelayMs = 250;
    transport.ackConfig.tActualUs = f => {
      if (f.op !== Op.FIRE_AT) throw new Error('expected scheduled fire');
      return f.tFireUs;
    };
    const controller = new CaptureController(transport, clock, settings, hostNow);
    const camera: CameraRef = {
      takePhoto: onShutter => new Promise(resolve => {
        setTimeout(() => {
          onShutter();
          resolve({ path: '/tmp/calibration.jpg' });
        }, shutterDelayMs);
      }),
    };

    const first = await runShoot(controller, camera);

    expect(first.xenonDelayBeforeAutoTuneMs).toBe(200);
    expect(first.xenonDelayAfterAutoTuneMs).toBe(250);
    expect(first.xenonCalibrationSampleCount).toBe(1);
    expect(settings.xenonFlashDelayMs).toBe(250);
    expect(settings.xenonDelayAutoTuned).toBe(true);

    shutterDelayMs = 400;
    const second = await runShoot(controller, camera);
    expect(second.xenonDelayBeforeAutoTuneMs).toBe(250);
    expect(second.xenonDelayAfterAutoTuneMs).toBe(400);
    expect(settings.xenonFlashDelayMs).toBe(400);
    expect(settings.xenonDelayAutoTuned).toBe(true);

    shutterDelayMs = 100;
    const third = await runShoot(controller, camera);
    expect(third.xenonDelayAfterAutoTuneMs).toBe(100);
    expect(third.xenonCalibrationSampleCount).toBe(3);
    expect(settings.xenonFlashDelayMs).toBe(100);
  });

  it('sets the automatic delay directly to the latest capture timing target', () => {
    const settings = { ...DEFAULT_SETTINGS, xenonFlashDelayMs: 200 };
    expect(autoTuneXenonFlashDelay(settings, 300_000, 200_000).afterMs).toBe(300);
    expect(autoTuneXenonFlashDelay(settings, 300_000, 225_000).afterMs).toBe(375);
    expect(autoTuneXenonFlashDelay(settings, 1200_000, 250_000).afterMs).toBe(1200);
    expect(settings.xenonCalibrationTargetsMs).toEqual([300, 375, 1200]);
  });

  it('applies the measured shutter target without an RTT or lead-time floor', () => {
    const settings: CaptureSettings = {
      ...DEFAULT_SETTINGS,
      xenonFlashDelayMs: 10,
    };
    const adjustment = setXenonFlashDelayToTarget(settings, 25);

    expect(adjustment).toEqual({ beforeMs: 10, afterMs: 25 });
    expect(settings.xenonFlashDelayMs).toBe(25);
  });

  it('keeps lead manual and tunes exactly to shutter timing even with high RTT', async () => {
    const { transport, clock, settings } = await setup({ xenonFlashDelayMs: 120 });
    jest.spyOn(clock, 'linkQuality', 'get').mockReturnValue({
      samples: 5,
      medianRttUs: 100_000,
      packetLossPercent: 0,
      state: 'fair',
    });
    transport.ackConfig.tActualUs = f => {
      if (f.op !== Op.FIRE_AT) throw new Error('expected scheduled fire');
      return f.tFireUs;
    };

    const timerOriginMs = jest.now();
    const hostOriginUs = 1_000_000;
    const hostNow = () => hostOriginUs + (jest.now() - timerOriginMs) * 1000;
    const controller = new CaptureController(transport, clock, settings, hostNow);
    const camera: CameraRef = {
      takePhoto: onShutter => new Promise(resolve => {
        setTimeout(() => {
          onShutter();
          resolve({ path: '/tmp/network-calibration.jpg' });
        }, 200);
      }),
    };

    const first = await runShoot(controller, camera);

    expect(settings.leadTimeMs).toBe(40);
    expect(first.flashScheduledAtHostUs! - first.cameraRequestAtHostUs).toBe(120_000);
    expect(first.cameraShutterAtHostUs! - first.cameraRequestAtHostUs).toBe(200_000);
    expect(first.xenonDelayBeforeAutoTuneMs).toBe(120);
    expect(first.xenonDelayAfterAutoTuneMs).toBe(200);
    expect(first.xenonCalibrationSampleCount).toBe(1);
    expect(settings.xenonFlashDelayMs).toBe(200);

    const second = await runShoot(controller, camera);
    expect(second.xenonDelayBeforeAutoTuneMs).toBe(200);
    expect(second.xenonDelayAfterAutoTuneMs).toBe(200);
    expect(settings.xenonFlashDelayMs).toBe(200);
  });

  it('adjusts the last valid capture target every quality tick and stops after reset', async () => {
    const { transport, clock, settings } = await setup();
    const timerOriginMs = jest.now();
    const hostOriginUs = 1_000_000;
    const hostNow = () => hostOriginUs + (jest.now() - timerOriginMs) * 1000;
    const timedController = new CaptureController(transport, clock, settings, hostNow);
    const camera: CameraRef = {
      takePhoto: onShutter => new Promise(resolve => {
        setTimeout(() => {
          onShutter();
          resolve({ path: '/tmp/periodic-calibration.jpg' });
        }, 250);
      }),
    };
    const goodLink = {
      samples: 5, medianRttUs: 10_000, packetLossPercent: 0, state: 'good' as const,
    };
    jest.spyOn(clock, 'probeLinkQuality').mockResolvedValue(goodLink);

    await runShoot(timedController, camera);
    expect(settings.xenonFlashDelayMs).toBe(250);

    await timedController.refreshLinkQuality();
    expect(settings.xenonFlashDelayMs).toBe(250);
    await timedController.refreshLinkQuality();
    expect(settings.xenonFlashDelayMs).toBe(250);

    jest.spyOn(clock, 'probeLinkQuality').mockResolvedValue({
      samples: 5, medianRttUs: 300_000, packetLossPercent: 0, state: 'poor',
    });
    await timedController.refreshLinkQuality();
    expect(settings.leadTimeMs).toBe(40);
    expect(settings.xenonFlashDelayMs).toBe(250);

    resetAutoTunedXenonFlashDelay(settings);
    await timedController.refreshLinkQuality();
    expect(settings.xenonFlashDelayMs).toBe(500);
    expect(settings.xenonDelayAutoTuned).toBe(false);
  });

  it('does not shift a measured shutter target to satisfy network latency', () => {
    const settings = { ...DEFAULT_SETTINGS, xenonFlashDelayMs: 160 };

    const result = autoTuneXenonFlashDelay(settings, 300_000, 200_000, 150);

    expect(result.afterMs).toBe(250);
    expect(settings.xenonFlashDelayMs).toBe(250);
    expect(settings.xenonCalibrationTargetsMs).toEqual([250]);
  });

  it('resets the delay and permits automatic calibration again', () => {
    const settings: CaptureSettings = {
      ...DEFAULT_SETTINGS,
      xenonFlashDelayMs: 725,
      xenonCalibrationTargetsMs: [700, 725, 750],
      xenonDelayAutoTuned: true,
    };

    resetAutoTunedXenonFlashDelay(settings);

    expect(settings.xenonFlashDelayMs).toBe(RESET_XENON_FLASH_DELAY_MS);
    expect(settings.xenonFlashDelayMs).toBe(500);
    expect(settings.xenonCalibrationTargetsMs).toEqual([]);
    expect(settings.xenonDelayAutoTuned).toBe(false);

    const firstNewSample = autoTuneXenonFlashDelay(settings, 100_000, 75_000);
    expect(firstNewSample.beforeMs).toBe(RESET_XENON_FLASH_DELAY_MS);
    expect(firstNewSample.sampleCount).toBe(1);
    expect(settings.xenonCalibrationTargetsMs).toHaveLength(1);
    expect(settings.xenonDelayAutoTuned).toBe(true);
  });

  it('does not adjust xenon timing from a late or cooldown-rejected trigger', async () => {
    const { transport, controller, settings } = await setup({ xenonFlashDelayMs: 100 });
    const camera = makeFakeCamera([]);

    transport.ackConfig.flags = ACK_LATE;
    const late = await runShoot(controller, camera);
    expect(late.xenonDelayAfterAutoTuneMs).toBeNull();
    expect(late.ackReceived).toBe(true);
    expect(late.flashFired).toBeNull();
    expect(settings.xenonFlashDelayMs).toBe(100);

    transport.ackConfig.flags = ACK_COOLDOWN_REJECTED;
    const rejected = await runShoot(controller, camera);
    expect(rejected.xenonDelayAfterAutoTuneMs).toBeNull();
    expect(rejected.ackReceived).toBe(true);
    expect(rejected.flashFired).toBe(false);
    expect(rejected.tActualUs).toBeNull();
    expect(rejected.schedErrorUs).toBeNull();
    expect(settings.xenonFlashDelayMs).toBe(100);
  });

  it('does not treat a plain ACK as proof that the flash fired', async () => {
    const { transport, controller, settings } = await setup({ xenonFlashDelayMs: 200 });
    transport.ackConfig.flags = 0;

    const record = await runShoot(controller, makeFakeCamera([]));

    expect(record.ackReceived).toBe(true);
    expect(record.flashFired).toBeNull();
    expect(record.tActualUs).toBeNull();
    expect(record.schedErrorUs).toBeNull();
    expect(record.xenonDelayAfterAutoTuneMs).toBeNull();
    expect(settings.xenonCalibrationTargetsMs).toHaveLength(0);
  });

  it('(b) sends FIRE_AT twice with the identical seq (retry survives packet loss)', async () => {
    const { events, transport, controller } = await setup();
    const camera = makeFakeCamera(events);

    await runShoot(controller, camera, 'scheduled');

    const fireAtSends = transport.sent.filter(f => f.op === Op.FIRE_AT);
    expect(fireAtSends.length).toBe(2);
    expect(fireAtSends[0].seq).toBe(fireAtSends[1].seq);
  });

  it('uses a fresh time-derived sequence after app restart and wraps at uint16', async () => {
    const { events, transport, clock, settings } = await setup();
    jest.setSystemTime(65_535_000);
    const restartedController = new CaptureController(transport, clock, settings);
    const camera = makeFakeCamera(events);

    await runShoot(restartedController, camera);
    await runShoot(restartedController, camera);

    const fireAtSeqs = transport.sent
      .filter(f => f.op === Op.FIRE_AT)
      .map(f => f.seq);
    expect(fireAtSeqs).toEqual([65_535, 65_535, 0, 0]);
  });

  it("(c) naive mode sends FIRE_NOW once, never FIRE_AT", async () => {
    const { events, transport, controller } = await setup();
    const camera = makeFakeCamera(events);

    await runShoot(controller, camera, 'naive');

    expect(transport.sent.filter(f => f.op === Op.FIRE_NOW).length).toBe(1);
    expect(transport.sent.filter(f => f.op === Op.FIRE_AT).length).toBe(0);
  });

  it('(d) an ack timeout never loses the photo', async () => {
    const { events, transport, controller } = await setup();
    transport.ackConfig.enabled = false; // never acks
    const camera = makeFakeCamera(events, { path: '/tmp/still-got-it.jpg' });

    const record = await runShoot(controller, camera, 'scheduled');

    expect(record.ackReceived).toBe(false);
    expect(record.flashFired).toBeNull();
    expect(record.tActualUs).toBeNull();
    expect(record.schedErrorUs).toBeNull();
    expect(record.photoPath).toBe('/tmp/still-got-it.jpg');
    expect(controller.settings.xenonDelayAutoTuned).toBe(false);
  });

  it('(e) LATE acks do not change the manually configured lead time', async () => {
    const { events, transport, controller, settings } = await setup();
    transport.ackConfig.flags = ACK_LATE;
    const camera = makeFakeCamera(events);

    expect(settings.leadTimeMs).toBe(40);

    const record1 = await runShoot(controller, camera, 'scheduled');
    expect(record1.late).toBe(true);
    expect(settings.leadTimeMs).toBe(40);

    for (let i = 0; i < 17; i++) {
      await runShoot(controller, camera, 'scheduled');
    }
    expect(settings.leadTimeMs).toBe(40);
  });

  it('(f) a session id change on the ack triggers a re-sync', async () => {
    const { events, transport, controller, clock } = await setup();
    const syncSpy = jest.spyOn(clock, 'sync');
    expect(clock.sessionId).toBe(0x1111);

    transport.ackConfig.sessionId = 0x2222; // device rebooted mid-session
    const camera = makeFakeCamera(events);

    await runShoot(controller, camera, 'scheduled');

    expect(syncSpy).toHaveBeenCalled();
  });

  it('(g) a camera failure is recorded without firing the external flash', async () => {
    const { events, controller } = await setup();
    const camera = makeFakeCamera(events, { fail: true });

    const record = await runShoot(controller, camera, 'scheduled');

    expect(record.photoPath).toBeNull();
    expect(record.ackReceived).toBe(false);
    expect(record.flashFired).toBeNull();
    expect(record.tRequestedUs).toBeNull();
    expect(record.tActualUs).toBeNull();
    expect(record.schedErrorUs).toBeNull();
    expect(record.seq).toBeGreaterThanOrEqual(0);
    expect(record.seq).toBeLessThan(0x10000);
  });

  it('does not schedule a flash if the app is disposed during the configured delay', async () => {
    const { events, transport, controller } = await setup({ xenonFlashDelayMs: 100 });
    const camera = makeFakeCamera(events);

    const shot = controller.shoot(camera);
    await jest.advanceTimersByTimeAsync(0);
    await controller.dispose();
    await jest.advanceTimersByTimeAsync(100);

    const record = await shot;
    expect(transport.sent.some(f => f.op === Op.FIRE_AT)).toBe(false);
    expect(record.flashScheduledAtHostUs).toBeNull();
    expect(record.tRequestedUs).toBeNull();
  });
});
