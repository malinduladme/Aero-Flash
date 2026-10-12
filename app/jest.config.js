module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    '^@vectors$': '<rootDir>/../protocol/vectors.json',
  },
  // react-native-udp, react-native-vision-camera, and react-native-ble-plx ship
  // untranspiled ESM (`import`/`export`) in their published main entry, so the
  // preset's default transformIgnorePatterns (which only reaches into
  // react-native/@react-native packages) leaves them as raw source and Jest
  // chokes on the `import`/`export` keyword.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-udp|react-native-vision-camera|react-native-ble-plx)/)',
  ],
};
