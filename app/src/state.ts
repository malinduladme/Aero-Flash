import { LatencyLog } from './telemetry/LatencyLog';
import { DEFAULT_SETTINGS, CaptureSettings } from './capture/settings';
import type { TransportMode } from './transport';

// isolatedModules (set by @react-native/typescript-config) requires
// type-only re-exports to use `export type`.
export type { TransportMode };

export const sharedLog = new LatencyLog();
export const sharedSettings: CaptureSettings = { ...DEFAULT_SETTINGS };

// The transport mode, shared like the log and settings above so it survives
// navigation (CameraScreen unmounts on every screen change — see
// connection.ts) and so DiagnosticsScreen's transport toggle and
// CameraScreen's status chip stay in sync. Default is 'wifi' for the demo.
export let currentMode: TransportMode = 'wifi';

export function setCurrentMode(m: TransportMode): void {
  currentMode = m;
}
