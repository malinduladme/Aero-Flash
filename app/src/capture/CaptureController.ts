import { FlashTransport } from '../transport/FlashTransport';
import { ClockSync, nowUs } from '../sync/ClockSync';
import type { LinkQuality } from '../sync/ClockSync';
import {
  Frame, Op, ACK_LATE, ACK_COOLDOWN_REJECTED, ACK_FIRED,
} from '../protocol/frames';
import {
  CaptureSettings, autoTuneXenonFlashDelay,
  setXenonFlashDelayToTarget,
} from './settings';

export type CameraRef = { takePhoto(onShutter: () => void): Promise<{ path: string }> };

type FireAck = { tActualUs: number; sessionId: number; flags: number; receivedAtHostUs: number };

export type ShotRecord = {
  seq: number;
  mode: 'scheduled' | 'naive';
  cameraRequestAtHostUs: number;
  cameraShutterAtHostUs: number | null;
  captureCompletedAtHostUs: number | null;
  flashScheduledAtHostUs: number | null;
  flashActualAtHostUs: number | null;
  xenonDelayBeforeAutoTuneMs: number | null;
  xenonDelayAfterAutoTuneMs: number | null;
  xenonCalibrationSampleCount: number;
  tRequestedUs: number | null;
  tActualUs: number | null;
  schedErrorUs: number | null;
  commandToAckUs: number | null;
  syncRttUs: number;
  late: boolean;
  ackReceived: boolean;
  flashFired: boolean | null;
  cooldownRejected: boolean;
  photoPath: string | null;
  timestamp: number;
};

export class CaptureController {
  private seq = Math.floor(Date.now() / 1000) % 0x10000;
  private disposed = false;
  private latestXenonCalibrationTargetMs: number | null = null;

  constructor(
    private transport: FlashTransport,
    private clock: ClockSync,
    public settings: CaptureSettings,
    private hostNow: () => number = nowUs,
  ) {}

  getLinkQuality(): LinkQuality {
    return this.clock.linkQuality;
  }

  async refreshLinkQuality(): Promise<LinkQuality> {
    const quality = await this.clock.probeLinkQuality();
    this.adjustXenonDelayForCurrentLink(quality.medianRttUs);
    return quality;
  }

  /** Keep the intended fire time anchored to the camera request. Lead time only
   *  moves command dispatch earlier; changing radio headroom never moves the fire. */
  async shoot(camera: CameraRef, mode: 'scheduled' | 'naive' = 'scheduled'): Promise<ShotRecord> {
    const seq = this.nextSeq();
    const s = this.settings;

    // Re-sync when invalid OR stale. Crystal drift is 20-50 ppm, so an offset
    // more than 30 s old has accumulated close to a millisecond of error — small
    // against the lit window, but it costs nothing to remove.
    if (this.clock.isStale()) await this.clock.sync();

    const linkRttUs = this.clock.linkQuality.medianRttUs ?? this.clock.rttUs;

    const cameraRequestAtHostUs = this.hostNow();
    const xenonDelayForShotMs = s.xenonFlashDelayMs;
    const leadTimeForShotMs = s.leadTimeMs;
    let cameraShutterAtHostUs: number | null = null;
    let captureCompletedAtHostUs: number | null = null;
    let captureFailed = false;
    const photoPromise = camera.takePhoto(() => {
      cameraShutterAtHostUs ??= this.hostNow();
    }).then(
      photo => {
        captureCompletedAtHostUs = this.hostNow();
        return photo;
      },
      error => {
        captureCompletedAtHostUs = this.hostNow();
        captureFailed = true;
        console.warn('[capture] camera request failed:', error);
        return null;
      },
    );

    let tRequestedUs: number | null = null;
    let flashScheduledAtHostUs: number | null = null;
    let ack: FireAck | null = null;
    let fireCommandSentAtHostUs: number | null = null;
    const offsetAtFireRequestUs = this.clock.offsetUs;
    const intendedFlashTargetAtHostUs =
      cameraRequestAtHostUs + xenonDelayForShotMs * 1000;
    if (mode === 'scheduled') {
      const commandSendAtHostUs = Math.max(
        cameraRequestAtHostUs,
        intendedFlashTargetAtHostUs - leadTimeForShotMs * 1000,
      );
      await sleep(Math.max(0, (commandSendAtHostUs - this.hostNow()) / 1000));
    } else {
      await sleep(xenonDelayForShotMs);
    }

    let photo: { path: string } | null;
    if (this.disposed || captureFailed) {
      photo = await photoPromise;
    } else {
      const ackPromise = this.awaitAck(
        seq,
        leadTimeForShotMs + s.flashDurationMs + 200,
      );
      if (mode === 'scheduled') {
        flashScheduledAtHostUs = intendedFlashTargetAtHostUs;
        tRequestedUs = this.clock.toDeviceTime(flashScheduledAtHostUs);
        const frame: Frame = {
          op: Op.FIRE_AT, seq,
          tFireUs: tRequestedUs,
          durationMs: s.flashDurationMs,
          brightness: s.brightness,
        };
        // The firmware deduplicates retries with the same sequence number.
        try {
          fireCommandSentAtHostUs = this.hostNow();
          this.transport.send(frame);
          this.transport.send(frame);
        } catch (error) {
          console.warn('[capture] flash schedule failed:', error);
        }
      } else {
        flashScheduledAtHostUs = this.hostNow();
        tRequestedUs = this.clock.toDeviceTime(flashScheduledAtHostUs);
        try {
          fireCommandSentAtHostUs = this.hostNow();
          this.transport.send({
            op: Op.FIRE_NOW, seq,
            durationMs: s.flashDurationMs,
            brightness: s.brightness,
          });
        } catch (error) {
          console.warn('[capture] immediate flash request failed:', error);
        }
      }

      [photo, ack] = await Promise.all([photoPromise, ackPromise]);
    }

    const sessionChanged = ack ? this.clock.noteSessionId(ack.sessionId) : false;

    if (sessionChanged) {
      // Device rebooted mid-session: its timebase restarted, so our offset is
      // stale. Next shot re-syncs.
      await this.clock.sync();
    }

    const late = ack ? (ack.flags & ACK_LATE) !== 0 : false;
    const cooldownRejected = ack !== null &&
      (ack.flags & ACK_COOLDOWN_REJECTED) !== 0;
    const flashFired = ack
      ? cooldownRejected
        ? false
        : (ack.flags & ACK_FIRED) !== 0
          ? true
          : null
      : null;
    const flashActualAtHostUs = ack && flashFired && !sessionChanged
      ? ack.tActualUs - offsetAtFireRequestUs
      : null;
    let xenonDelayBeforeAutoTuneMs: number | null = null;
    let xenonDelayAfterAutoTuneMs: number | null = null;
    let xenonCalibrationSampleCount = this.settings.xenonCalibrationTargetsMs.length;
    if (
      mode === 'scheduled' &&
      ack &&
      flashFired &&
      !sessionChanged &&
      !late &&
      cameraShutterAtHostUs !== null &&
      flashActualAtHostUs !== null
    ) {
      const tune = autoTuneXenonFlashDelay(
        this.settings,
        cameraShutterAtHostUs,
        flashActualAtHostUs,
        xenonDelayForShotMs,
      );
      this.latestXenonCalibrationTargetMs = tune.targetMs;
      xenonDelayBeforeAutoTuneMs = tune.beforeMs;
      xenonDelayAfterAutoTuneMs = tune.afterMs;
      xenonCalibrationSampleCount = tune.sampleCount;
      if (xenonDelayAfterAutoTuneMs !== xenonDelayBeforeAutoTuneMs) {
        console.info(
          `[capture] auto-adjusted xenon delay: ${xenonDelayBeforeAutoTuneMs} -> ` +
          `${xenonDelayAfterAutoTuneMs} ms using shutter callback timing ` +
          `(link RTT ${Math.round(linkRttUs / 1000)} ms, ` +
          `manual lead ${leadTimeForShotMs} ms)`,
        );
      }
    }

    return {
      seq, mode, tRequestedUs,
      cameraRequestAtHostUs,
      cameraShutterAtHostUs,
      captureCompletedAtHostUs,
      flashScheduledAtHostUs,
      flashActualAtHostUs,
      xenonDelayBeforeAutoTuneMs,
      xenonDelayAfterAutoTuneMs,
      tActualUs: ack && flashFired ? ack.tActualUs : null,
      schedErrorUs: ack && flashFired && tRequestedUs !== null && !sessionChanged
        ? ack.tActualUs - tRequestedUs
        : null,
      commandToAckUs: ack && fireCommandSentAtHostUs !== null
        ? Math.max(0, ack.receivedAtHostUs - fireCommandSentAtHostUs)
        : null,
      syncRttUs: this.clock.rttUs,
      late,
      ackReceived: ack !== null,
      flashFired,
      cooldownRejected,
      xenonCalibrationSampleCount,
      photoPath: photo?.path ?? null,
      timestamp: Date.now(),
    };
  }

  /**
   * Called when the app is backgrounded. Cancels any armed fire so the LED cannot
   * go off while the app is not foreground, then drops the link.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    try {
      this.transport.send({ op: Op.CANCEL, seq: this.nextSeq() });
    } catch {
      /* the link may already be gone; disconnecting is what matters */
    }
    await this.transport.disconnect();
  }

  private awaitAck(seq: number, timeoutMs: number):
      Promise<FireAck | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { off(); resolve(null); }, timeoutMs);
      const off = this.transport.onFrame((f) => {
        if (f.op !== Op.FIRE_ACK || f.seq !== seq) return;
        clearTimeout(timer);
        off();
        resolve({
          tActualUs: f.tActualUs,
          sessionId: f.sessionId,
          flags: f.flags,
          receivedAtHostUs: this.hostNow(),
        });
      });
    });
  }

  private nextSeq(): number {
    const seq = this.seq;
    this.seq = (this.seq + 1) % 0x10000;
    return seq;
  }

  private adjustXenonDelayForCurrentLink(medianRttUs: number | null): void {
    const targetMs = this.latestXenonCalibrationTargetMs;
    if (!this.settings.xenonDelayAutoTuned || targetMs === null) return;

    const { beforeMs, afterMs } = setXenonFlashDelayToTarget(
      this.settings,
      targetMs,
    );
    if (afterMs !== beforeMs) {
      console.info(
        `[capture] periodic xenon timing adjustment: ${beforeMs} -> ${afterMs} ms ` +
        `(target ${targetMs} ms, median RTT ` +
        `${medianRttUs === null ? 'unavailable' : `${(medianRttUs / 1000).toFixed(1)} ms`}, ` +
        `manual lead ${this.settings.leadTimeMs} ms)`,
      );
    }
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
