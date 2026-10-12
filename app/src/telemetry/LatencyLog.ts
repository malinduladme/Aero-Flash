import { ShotRecord } from '../capture/CaptureController';

export type Summary = {
  n: number;
  ackReceived: number;
  flashFired: number;
  cooldownRejected: number;
  lateCount: number;
  commandToAckMedianUs: number;
  errMedianUs: number;
  errMaxUs: number;
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export class LatencyLog {
  private rows: ShotRecord[] = [];

  add(r: ShotRecord) { this.rows.push(r); }
  get records() { return this.rows; }
  clear() { this.rows = []; }

  toCsv(): string {
    const head = [
      'seq', 'mode', 'camera_request_host_us', 'camera_shutter_host_us',
      'flash_scheduled_host_us', 'flash_actual_host_us', 'capture_completed_host_us',
      'xenon_delay_before_auto_tune_ms', 'xenon_delay_after_auto_tune_ms',
      'flash_requested_device_us', 'flash_actual_device_us', 'sched_error_us',
      'command_to_ack_us', 'sync_rtt_us', 'late', 'ack_received',
      'flash_fired', 'cooldown_rejected', 'timestamp',
    ].join(',');
    const body = this.rows.map(r => [
      r.seq,
      r.mode,
      r.cameraRequestAtHostUs,
      r.cameraShutterAtHostUs ?? '',
      r.flashScheduledAtHostUs ?? '',
      r.flashActualAtHostUs ?? '',
      r.captureCompletedAtHostUs ?? '',
      r.xenonDelayBeforeAutoTuneMs ?? '',
      r.xenonDelayAfterAutoTuneMs ?? '',
      r.tRequestedUs ?? '',
      r.tActualUs ?? '',        // Empty when firing was rejected or no fire ACK arrived.
      r.schedErrorUs ?? '',
      r.commandToAckUs ?? '',
      r.syncRttUs,
      r.late ? 1 : 0,
      r.ackReceived ? 1 : 0,
      r.flashFired === null ? '' : r.flashFired ? 1 : 0,
      r.cooldownRejected ? 1 : 0,
      r.timestamp,
    ].join(','));
    return [head, ...body].join('\n') + '\n';
  }

  summary(): Summary {
    const errs = this.rows
      .filter(r => r.schedErrorUs !== null)
      .map(r => Math.abs(r.schedErrorUs as number));
    return {
      n: this.rows.length,
      ackReceived: this.rows.filter(r => r.ackReceived).length,
      flashFired: this.rows.filter(r => r.flashFired === true).length,
      cooldownRejected: this.rows.filter(r => r.cooldownRejected).length,
      lateCount: this.rows.filter(r => r.late).length,
      commandToAckMedianUs: median(
        this.rows.flatMap(r => r.commandToAckUs === null ? [] : [r.commandToAckUs]),
      ),
      errMedianUs: median(errs),
      errMaxUs: errs.length ? Math.max(...errs) : 0,
    };
  }
}
