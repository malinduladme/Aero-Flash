// Manual Jest mock for react-native-fs.
//
// The real module calls straight into a native module that does not exist
// under Jest, so any test that imports PhotoStore (directly, or transitively
// via a screen) needs an in-memory stand-in instead. Node.js/Jest packages
// are auto-mocked from this file with no explicit jest.mock() call required.
// Mirrors __mocks__/react-native-vision-camera.js and
// __mocks__/react-native-ble-plx.js, which exist for the same reason.
//
// Backed by a plain Map from normalized path -> { size, mtime }. Tests can
// reach into the exported __setFile/__reset helpers to seed or clear state;
// neither is part of the real react-native-fs API.

const files = new Map();
const dirs = new Set(['/mock-documents']);

const normalize = (p) => p.replace(/\/+$/, '');

const toEntry = (path, f) => ({
  name: path.split('/').pop(),
  path,
  size: f.size,
  mtime: f.mtime,
  ctime: f.mtime,
  isFile: () => true,
  isDirectory: () => false,
});

module.exports = {
  DocumentDirectoryPath: '/mock-documents',

  mkdir: jest.fn(async (path) => {
    dirs.add(normalize(path));
  }),

  exists: jest.fn(async (path) => {
    const p = normalize(path);
    if (dirs.has(p) || files.has(p)) return true;
    // A directory nobody explicitly mkdir'd still "exists" if a file was
    // seeded under it directly (via __setFile) — mirrors a real filesystem
    // closely enough for these tests without forcing every test to mkdir first.
    const prefix = `${p}/`;
    for (const key of files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }),

  moveFile: jest.fn(async (from, to) => {
    const f = files.get(normalize(from)) ?? { size: 0, mtime: new Date() };
    files.delete(normalize(from));
    files.set(normalize(to), f);
  }),

  unlink: jest.fn(async (path) => {
    files.delete(normalize(path));
  }),

  stat: jest.fn(async (path) => {
    const p = normalize(path);
    const f = files.get(p) ?? { size: 0, mtime: new Date() };
    return { ...toEntry(p, f), path: p };
  }),

  readDir: jest.fn(async (path) => {
    const prefix = `${normalize(path)}/`;
    return Array.from(files.entries())
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, f]) => toEntry(p, f));
  }),

  // --- test-only helpers, not part of the real react-native-fs API ---
  __setFile: (path, { size = 0, mtime = new Date() } = {}) => {
    files.set(normalize(path), { size, mtime });
  },
  __reset: () => {
    files.clear();
    dirs.clear();
    dirs.add('/mock-documents');
  },
};
