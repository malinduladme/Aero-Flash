import * as RNFS from 'react-native-fs';
import { PermissionsAndroid, Platform } from 'react-native';

export type StoredPhoto = {
  path: string;
  uri: string;
  name: string;
  takenAt: number;
  sizeBytes: number;
};

const PHOTOS_DIR = `${RNFS.DocumentDirectoryPath}/photos`;
const DEVICE_GALLERY_ALBUM = 'SmartCam';

// vision-camera writes captures into the app CACHE directory, which Android
// can evict under memory pressure at any time. Everything in this module
// exists to move a capture out of there and into DocumentDirectoryPath,
// which persists for the life of the app install.

// Tracks the last millisecond a filename was minted for, and how many names
// have already been handed out within that millisecond, so two saves landing
// in the same ms (the 600ms shutter cooldown makes this rare on-device, but
// not impossible under a fast retake or in a test) still get distinct names
// that sort in the order they were minted.
let lastMs = -1;
let seqInMs = 0;

const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})(?:_(\d{3}))?\.jpg$/;

/**
 * Builds a sortable, collision-free filename for a photo taken at `now`
 * (epoch ms), e.g. `2026-08-30T09-15-42-123.jpg`. Pure — no filesystem
 * access — so it is unit-testable without mocking react-native-fs.
 *
 * The collision suffix is joined with `_` rather than `-`: plain ASCII sort
 * (used by listPhotos for newest-first ordering) compares byte by byte, and
 * `.` (0x2E) sorts AFTER `-` (0x2D). A `-NNN` suffix would therefore sort the
 * disambiguated (later, collided) file BEFORE the plain one from the same
 * millisecond, silently inverting order. `_` (0x5F) sorts after `.` (0x2E),
 * so the suffixed name always sorts after the bare one, preserving mint order.
 */
export function makeFilename(now: number): string {
  if (now === lastMs) {
    seqInMs += 1;
  } else {
    lastMs = now;
    seqInMs = 0;
  }
  const stamp = new Date(now)
    .toISOString()               // 2026-08-30T09:15:42.123Z
    .replace(/[:.]/g, '-')       // 2026-08-30T09-15-42-123Z
    .replace('Z', '');           // 2026-08-30T09-15-42-123
  // Zero-padded so repeated collisions within one millisecond still sort in
  // the order they were minted (`_001` < `_002`).
  const suffix = seqInMs > 0 ? `_${String(seqInMs).padStart(3, '0')}` : '';
  return `${stamp}${suffix}.jpg`;
}

/** Recovers the epoch-ms timestamp encoded in a name from makeFilename(). */
function takenAtFromName(name: string): number | null {
  const m = FILENAME_RE.exec(name);
  if (!m) return null;
  const [, date, hh, mm, ss, ms] = m;
  const t = Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
  return Number.isNaN(t) ? null : t;
}

const stripFileScheme = (p: string) => (p.startsWith('file://') ? p.slice('file://'.length) : p);

async function ensureDir(): Promise<void> {
  if (!(await RNFS.exists(PHOTOS_DIR))) {
    await RNFS.mkdir(PHOTOS_DIR);
  }
}

/** Moves a capture (typically from the vision-camera cache path) into durable storage. */
export async function savePhoto(sourcePath: string): Promise<StoredPhoto> {
  await ensureDir();
  const takenAt = Date.now();
  const name = makeFilename(takenAt);
  const destPath = `${PHOTOS_DIR}/${name}`;
  await RNFS.moveFile(stripFileScheme(sourcePath), destPath);
  const info = await RNFS.stat(destPath);
  return {
    path: destPath,
    uri: `file://${destPath}`,
    name,
    takenAt,
    sizeBytes: Number(info.size),
  };
}

/** Copies a durable app photo into Android's shared photo library. */
export async function savePhotoToDeviceGallery(photoUri: string): Promise<void> {
  if (Platform.OS === 'android' && Number(Platform.Version) <= 28) {
    const permission = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
    const result = await PermissionsAndroid.request(permission);
    if (result !== PermissionsAndroid.RESULTS.GRANTED) {
      throw new Error('Storage permission was not granted.');
    }
  }

  const { CameraRoll } = require('@react-native-camera-roll/camera-roll') as
    typeof import('@react-native-camera-roll/camera-roll');
  await CameraRoll.saveAsset(photoUri, {
    type: 'photo',
    album: DEVICE_GALLERY_ALBUM,
  });
}

/** Lists stored photos, newest first. */
export async function listPhotos(): Promise<StoredPhoto[]> {
  if (!(await RNFS.exists(PHOTOS_DIR))) return [];
  const entries = await RNFS.readDir(PHOTOS_DIR);
  return entries
    .filter((e) => e.isFile())
    // Filenames are sortable timestamps, so a plain descending name sort is
    // newest-first — no need to trust filesystem mtime, which a move can reset.
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
    .map((e) => ({
      path: e.path,
      uri: `file://${e.path}`,
      name: e.name,
      takenAt: takenAtFromName(e.name) ?? (e.mtime ? e.mtime.getTime() : 0),
      sizeBytes: Number(e.size),
    }));
}

export async function deletePhoto(path: string): Promise<void> {
  if (await RNFS.exists(path)) {
    await RNFS.unlink(path);
  }
}

export async function photoCount(): Promise<number> {
  if (!(await RNFS.exists(PHOTOS_DIR))) return 0;
  const entries = await RNFS.readDir(PHOTOS_DIR);
  return entries.filter((e) => e.isFile()).length;
}
