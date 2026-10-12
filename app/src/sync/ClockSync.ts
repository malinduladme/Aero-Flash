import { FlashTransport } from '../transport/FlashTransport';
import { Frame, Op } from '../protocol/frames';

export type SyncResult = { offsetUs: number; rttUs: number; sessionId: number };
export type LinkQuality = {
  samples: number;
  medianRttUs: number | null;
  packetLossPercent: number | null;
  state: 'checking' | 'good' | 'fair' | 'poor';
};

/** Monotonic microseconds. Not wall-clock; only differences are meaningful. */
export function nowUs(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return Math.round((perf?.now() ?? Date.now()) * 1000);
}

const SYNC_TIMEOUT_MS = 1000;

/** Crystal drift between the two boards is roughly 20-50 ppm, so an offset older
 *  than this has accumulated close to a millisecond of error. */
export const RESYNC_INTERVAL_US = 30_000_000;

export class ClockSync {
  private offset = 0;
  private rtt = 0;
  private session = 0;
  private valid = false;
  private syncedAt = 0;
  private seq = 1;
  private recentQualitySamples: Array<number | null> = [];
  private static readonly QUALITY_WINDOW = 10;

  /** The time source is injected so tests can drive it deterministically. */
  constructor(private transport: FlashTransport, private now: () => number = nowUs) {}

  get offsetUs()  { return this.offset; }
  get rttUs()     { return this.rtt; }
  get sessionId() { return this.session; }
  get isValid()   { return this.valid; }

  get linkQuality(): LinkQuality {
    const samples = this.recentQualitySamples;
    if (samples.length === 0) {
      return { samples: 0, medianRttUs: null, packetLossPercent: null, state: 'checking' };
    }
    const rtts = samples.filter((rtt): rtt is number => rtt !== null).sort((a, b) => a - b);
    const packetLossPercent = Math.round(((samples.length - rtts.length) / samples.length) * 100);
    const medianRttUs = rtts.length === 0 ? null : rtts[Math.floor(rtts.length / 2)];
    const state = samples.length < 3
      ? 'checking'
      : rtts.length === 0 || packetLossPercent >= 30 || (medianRttUs !== null && medianRttUs > 100_000)
        ? 'poor'
        : packetLossPercent > 0 || (medianRttUs !== null && medianRttUs > 40_000)
          ? 'fair'
          : 'good';
    return { samples: samples.length, medianRttUs, packetLossPercent, state };
  }

  /** True when the offset is old enough that drift matters and a re-sync is due. */
  isStale(): boolean {
    return !this.valid || (this.now() - this.syncedAt) > RESYNC_INTERVAL_US;
  }

  /**
   * Cristian's algorithm. Keeps the sample with the SMALLEST round trip rather
   * than averaging: the fastest exchange is the least distorted by queuing delay,
   * so it gives the tightest bound on the true offset. Averaging would let one
   * slow sample drag the estimate.
   */
  async sync(rounds = 11): Promise<SyncResult> {
    let best: SyncResult | null = null;

    for (let i = 0; i < rounds; i++) {
      const t0 = this.now();
      let resp: Frame;
      try {
        resp = await this.request({ op: Op.SYNC_REQ, seq: this.seq++ });
      } catch {
        continue;   // a dropped sample is normal on UDP; keep going
      }
      const t1 = this.now();
      if (resp.op !== Op.SYNC_RESP) {
        continue;
      }

      const rtt = t1 - t0;
      const offset = resp.tDevUs - (t0 + rtt / 2);
      if (!best || rtt < best.rttUs) {
        best = { rttUs: rtt, offsetUs: offset, sessionId: resp.sessionId };
      }
    }

    if (!best) throw new Error('no sync response received');

    this.offset   = best.offsetUs;
    this.rtt      = best.rttUs;
    this.session  = best.sessionId;
    this.valid    = true;
    this.syncedAt = this.now();
    return best;
  }

  async probeLinkQuality(): Promise<LinkQuality> {
    const t0 = this.now();
    try {
      const resp = await this.request({ op: Op.SYNC_REQ, seq: this.seq++ });
      if (resp.op !== Op.SYNC_RESP) {
        this.recordQualitySample(null);
        return this.linkQuality;
      }
      this.recordQualitySample(this.now() - t0);
    } catch {
      this.recordQualitySample(null);
    }
    return this.linkQuality;
  }

  private recordQualitySample(rttUs: number | null): void {
    this.recentQualitySamples.push(rttUs);
    if (this.recentQualitySamples.length > ClockSync.QUALITY_WINDOW) {
      this.recentQualitySamples.shift();
    }
  }

  /** Convert a host timestamp into the device's timebase. */
  toDeviceTime(hostUs: number): number {
    if (!this.valid) throw new Error('clock offset invalid — re-sync required');
    return Math.round(hostUs + this.offset);
  }

  /**
   * Device timestamps are microseconds since ITS boot, so a reset restarts them
   * at zero and silently invalidates our offset. Every response carries
   * session_id; a change means re-sync before trusting any timestamp.
   * Returns true if the device rebooted.
   */
  noteSessionId(id: number): boolean {
    if (this.session !== 0 && id !== this.session) {
      this.valid = false;
      this.session = id;
      return true;
    }
    this.session = id;
    return false;
  }

  private request(f: Frame): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('sync timeout')); },
                               SYNC_TIMEOUT_MS);
      const off = this.transport.onFrame((in_) => {
        if (in_.seq !== f.seq) return;
        clearTimeout(timer);
        off();
        resolve(in_);
      });
      this.transport.send(f);
    });
  }
}
