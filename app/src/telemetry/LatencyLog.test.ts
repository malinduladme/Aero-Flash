import { LatencyLog } from './LatencyLog';
import { ShotRecord } from '../capture/CaptureController';

const rec = (over: Partial<ShotRecord> = {}): ShotRecord => ({
  seq: 1, mode: 'scheduled', tRequestedUs: 1000, tActualUs: 1100,
  schedErrorUs: 100, commandToAckUs: 3000, syncRttUs: 2000, late: false,
  ackReceived: true, flashFired: true, cooldownRejected: false,
  cameraRequestAtHostUs: 500, cameraShutterAtHostUs: 600,
  flashScheduledAtHostUs: 700, flashActualAtHostUs: 710,
  xenonDelayBeforeAutoTuneMs: null, xenonDelayAfterAutoTuneMs: null,
  xenonCalibrationSampleCount: 0,
  captureCompletedAtHostUs: 800, photoPath: null, timestamp: 0, ...over,
});

describe('LatencyLog', () => {
  it('emits a CSV header plus one row per record', () => {
    const log = new LatencyLog();
    log.add(rec({ seq: 1 }));
    log.add(rec({ seq: 2 }));
    const lines = log.toCsv().trim().split('\n');
    expect(lines[0]).toBe([
      'seq', 'mode', 'camera_request_host_us', 'camera_shutter_host_us',
      'flash_scheduled_host_us', 'flash_actual_host_us', 'capture_completed_host_us',
      'xenon_delay_before_auto_tune_ms', 'xenon_delay_after_auto_tune_ms',
      'flash_requested_device_us', 'flash_actual_device_us', 'sched_error_us',
      'command_to_ack_us', 'sync_rtt_us', 'late', 'ack_received',
      'flash_fired', 'cooldown_rejected', 'timestamp',
    ].join(','));
    expect(lines).toHaveLength(3);
  });

  it('writes unknown firing status for a shot with no ACK', () => {
    const log = new LatencyLog();
    log.add(rec({
      ackReceived: false, flashFired: null, tActualUs: null,
      flashActualAtHostUs: null, schedErrorUs: null, commandToAckUs: null,
    }));
    const [header, row] = log.toCsv().trim().split('\n').map(line => line.split(','));
    const fields = Object.fromEntries(header.map((name, index) => [name, row[index]]));
    expect(fields.ack_received).toBe('0');
    expect(fields.flash_fired).toBe('');
    expect(fields.cooldown_rejected).toBe('0');
    expect(fields.flash_actual_device_us).toBe('');
  });

  it('summarises using the median, so one outlier cannot dominate', () => {
    const log = new LatencyLog();
    [80, 90, 100, 110, 100000].forEach((e, i) =>
      log.add(rec({ seq: i, schedErrorUs: e, commandToAckUs: e * 10 })));
    const s = log.summary();
    expect(s.n).toBe(5);
    expect(s.errMedianUs).toBe(100);
    expect(s.errMaxUs).toBe(100000);
    expect(s.commandToAckMedianUs).toBe(1000);
  });

  it('counts ACK receipt, actual firing and cooldown rejection separately', () => {
    const log = new LatencyLog();
    log.add(rec({ late: true }));
    log.add(rec({
      ackReceived: true, flashFired: false, cooldownRejected: true,
      tActualUs: null, schedErrorUs: null,
    }));
    log.add(rec({ ackReceived: false, flashFired: null }));
    log.add(rec());
    const s = log.summary();
    expect(s.n).toBe(4);
    expect(s.lateCount).toBe(1);
    expect(s.ackReceived).toBe(3);
    expect(s.flashFired).toBe(2);
    expect(s.cooldownRejected).toBe(1);
  });

  it('clear() empties the log', () => {
    const log = new LatencyLog();
    log.add(rec());
    log.clear();
    expect(log.records).toHaveLength(0);
  });
});
