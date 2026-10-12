// Manual Jest mock for react-native-vision-camera.
//
// The real package throws at import time outside a real native runtime
// (`NativeModules.CameraView` does not exist under Jest), so any test that
// transitively imports a screen using the Camera component needs this stub.
// Node.js/Jest packages are auto-mocked from this file with no explicit
// jest.mock() call required.
const React = require('react');

const Camera = React.forwardRef((_props, _ref) => null);
Camera.displayName = 'Camera';
Camera.getCameraPermissionStatus = () => 'not-determined';
Camera.requestCameraPermission = async () => 'denied';
Camera.getMicrophonePermissionStatus = () => 'not-determined';
Camera.requestMicrophonePermission = async () => 'denied';
Camera.getLocationPermissionStatus = () => 'not-determined';
Camera.requestLocationPermission = async () => 'denied';

module.exports = {
  Camera,
  useCameraDevice: () => undefined,
  useCameraDevices: () => [],
  useCameraPermission: () => ({
    hasPermission: false,
    requestPermission: async () => false,
  }),
  useMicrophonePermission: () => ({
    hasPermission: false,
    requestPermission: async () => false,
  }),
};
