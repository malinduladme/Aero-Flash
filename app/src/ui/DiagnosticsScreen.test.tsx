import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import DiagnosticsScreen from './DiagnosticsScreen';
import { sharedLog, sharedSettings } from '../state';
import { resetAutoTunedXenonFlashDelay } from '../capture/settings';
import { ShotRecord } from '../capture/CaptureController';

jest.mock('../connection', () => ({
  getController: jest.fn(() => null),
  getLastConnectionError: jest.fn(() => null),
  getStatus: jest.fn(() => 'idle'),
  subscribe: jest.fn(() => () => {}),
  switchMode: jest.fn(),
}));

const previousCalibration: ShotRecord = {
  seq: 1,
  mode: 'scheduled',
  cameraRequestAtHostUs: 1_000_000,
  cameraShutterAtHostUs: 1_250_000,
  captureCompletedAtHostUs: 1_500_000,
  flashScheduledAtHostUs: 1_200_000,
  flashActualAtHostUs: 1_200_100,
  xenonDelayBeforeAutoTuneMs: 225,
  xenonDelayAfterAutoTuneMs: 250,
  xenonCalibrationSampleCount: 3,
  tRequestedUs: 2_000_000,
  tActualUs: 2_000_100,
  schedErrorUs: 100,
  commandToAckUs: 10_000,
  syncRttUs: 10_000,
  late: false,
  ackReceived: true,
  flashFired: true,
  cooldownRejected: false,
  photoPath: '/tmp/photo.jpg',
  timestamp: 1,
};

function collectText(children: React.ReactNode): string[] {
  if (typeof children === 'string' || typeof children === 'number') {
    return [String(children)];
  }
  if (Array.isArray(children)) return children.flatMap(collectText);
  return [];
}

describe('DiagnosticsScreen', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    sharedLog.clear();
    sharedLog.add(previousCalibration);
    Object.assign(sharedSettings, {
      ...sharedSettings,
      xenonFlashDelayMs: 250,
      xenonCalibrationTargetsMs: [250, 275, 300],
      xenonDelayAutoTuned: true,
    });
  });

  afterEach(async () => {
    if (renderer) await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    sharedLog.clear();
    resetAutoTunedXenonFlashDelay(sharedSettings);
  });

  it('hides the previous auto-calibration result after timing reset', async () => {
    await act(async () => {
      renderer = ReactTestRenderer.create(<DiagnosticsScreen onBack={jest.fn()} />);
    });

    const textContent = () => renderer!.root.findAllByType(Text)
      .flatMap(node => collectText(node.props.children));
    expect(textContent().some(text => text.includes('Last capture adjusted delay'))).toBe(true);

    await act(async () => {
      renderer!.root.findByProps({
        accessibilityLabel: 'Reset auto timing to default.',
      }).props.onPress();
    });

    expect(sharedSettings.xenonFlashDelayMs).toBe(500);
    expect(sharedSettings.xenonDelayAutoTuned).toBe(false);
    expect(sharedSettings.xenonCalibrationTargetsMs).toEqual([]);
    expect(textContent().some(text => text.includes('Last capture adjusted delay'))).toBe(false);
    expect(textContent().some(text => text.includes('Waiting for valid on-time'))).toBe(true);
  });
});
