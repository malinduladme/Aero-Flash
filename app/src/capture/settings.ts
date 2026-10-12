export type CaptureSettings = {
  /** Manually configured scheduling headroom before the fire target. */
  leadTimeMs: number;
  /** Delay after the camera request before scheduling the external flash. */
  xenonFlashDelayMs: number;
  /** Recent delay targets derived from valid request/shutter/flash timing pairs. */
  xenonCalibrationTargetsMs: number[];
  /** Indicates that automatic calibration has enough valid samples to tune. */
  xenonDelayAutoTuned: boolean;
  /** How long the external flash stays active. */
  flashDurationMs: number;
  /** Reserved: the firmware ignores this and drives the LED at DC. */
  brightness: number;
};

export const DEFAULT_XENON_FLASH_DELAY_MS = 500;

export const DEFAULT_SETTINGS: CaptureSettings = {
  leadTimeMs: 40,
  xenonFlashDelayMs: DEFAULT_XENON_FLASH_DELAY_MS,
  xenonCalibrationTargetsMs: [],
  xenonDelayAutoTuned: false,
  flashDurationMs: 300,
  brightness: 255,
};

export const LEAD_TIME_STEP_MS = 20;
export const LEAD_TIME_MAX_MS  = 400;
export const XENON_FLASH_DELAY_STEP_MS = 10;
export const XENON_FLASH_DELAY_MAX_MS = 1200;
export const XENON_CALIBRATION_WINDOW_SIZE = 5;
export const XENON_CALIBRATION_MIN_SAMPLES = 1;
export const RESET_XENON_FLASH_DELAY_MS = DEFAULT_XENON_FLASH_DELAY_MS;

export function setXenonFlashDelayToTarget(
  settings: CaptureSettings,
  targetDelayMs: number,
): { beforeMs: number; afterMs: number } {
  const beforeMs = settings.xenonFlashDelayMs;
  const afterMs = Math.max(0, Math.min(XENON_FLASH_DELAY_MAX_MS, targetDelayMs));
  settings.xenonFlashDelayMs = afterMs;
  return { beforeMs, afterMs };
}

export function autoTuneXenonFlashDelay(
  settings: CaptureSettings,
  cameraShutterAtHostUs: number,
  flashActualAtHostUs: number,
  delayUsedForCaptureMs = settings.xenonFlashDelayMs,
): { beforeMs: number; afterMs: number; sampleCount: number; targetMs: number } {
  const measuredDifferenceMs = (cameraShutterAtHostUs - flashActualAtHostUs) / 1000;
  const measuredTargetMs = Math.round(delayUsedForCaptureMs + measuredDifferenceMs);
  const targetDelayMs = Math.max(0, Math.min(XENON_FLASH_DELAY_MAX_MS, measuredTargetMs));
  settings.xenonCalibrationTargetsMs = [
    ...settings.xenonCalibrationTargetsMs,
    targetDelayMs,
  ];
  if (settings.xenonCalibrationTargetsMs.length > XENON_CALIBRATION_WINDOW_SIZE) {
    settings.xenonCalibrationTargetsMs.shift();
  }

  const targets = settings.xenonCalibrationTargetsMs;
  const { beforeMs, afterMs } = setXenonFlashDelayToTarget(settings, targetDelayMs);
  settings.xenonDelayAutoTuned = targets.length >= XENON_CALIBRATION_MIN_SAMPLES;
  return {
    beforeMs,
    afterMs,
    sampleCount: targets.length,
    targetMs: targetDelayMs,
  };
}

export function resetAutoTunedXenonFlashDelay(settings: CaptureSettings): void {
  settings.xenonFlashDelayMs = RESET_XENON_FLASH_DELAY_MS;
  settings.xenonCalibrationTargetsMs = [];
  settings.xenonDelayAutoTuned = false;
}
