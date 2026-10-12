import * as RNFS from 'react-native-fs';
import { CameraRoll } from '@react-native-camera-roll/camera-roll';
import { makeFilename, listPhotos, savePhoto, savePhotoToDeviceGallery } from './PhotoStore';

jest.mock('@react-native-camera-roll/camera-roll', () => ({
  CameraRoll: { saveAsset: jest.fn().mockResolvedValue({}) },
}));

// react-native-fs is auto-mocked from __mocks__/react-native-fs.js (an
// in-memory Map), so none of this touches a real filesystem.
const mockFs = RNFS as unknown as {
  __setFile(path: string, opts?: { size?: number; mtime?: Date }): void;
  __reset(): void;
};

beforeEach(() => mockFs.__reset());

// Each test below uses its own timestamp constant, never reused by another
// test in this file. makeFilename tracks the last-seen millisecond in module
// state (to detect same-ms collisions), and Jest does not reset module state
// between `it` blocks in one file — so sharing a timestamp across tests would
// make later tests see a "collision" left over from an earlier one.

describe('makeFilename', () => {
  it('produces a sortable, extension-terminated timestamp name', () => {
    const name = makeFilename(Date.UTC(2026, 7, 30, 9, 15, 42, 123));
    expect(name).toBe('2026-08-30T09-15-42-123.jpg');
  });

  it('is collision-free for two saves within the same millisecond', () => {
    const ms = Date.UTC(2026, 7, 30, 9, 16, 1, 456);
    const first = makeFilename(ms);
    const second = makeFilename(ms);
    expect(first).not.toBe(second);
  });

  it('keeps names for a repeated millisecond sorting after the first', () => {
    const ms = Date.UTC(2026, 7, 30, 9, 17, 3, 789);
    const first = makeFilename(ms);
    const second = makeFilename(ms);
    const third = makeFilename(ms);
    expect([third, first, second].sort()).toEqual([first, second, third]);
  });

  it('sorts distinct timestamps in chronological order as plain strings', () => {
    const names = [
      Date.UTC(2026, 7, 30, 9, 15, 42, 123),
      Date.UTC(2026, 7, 30, 9, 15, 42, 999),
      Date.UTC(2026, 7, 30, 9, 16, 0, 0),
      Date.UTC(2026, 7, 31, 0, 0, 0, 0),
    ].map(makeFilename);
    expect([...names].sort()).toEqual(names);
  });
});

describe('listPhotos', () => {
  it('returns an empty list when the photos directory has never been created', async () => {
    expect(await listPhotos()).toEqual([]);
  });

  it('sorts stored photos newest first', async () => {
    mockFs.__setFile('/mock-documents/photos/2026-08-30T09-00-00-000.jpg', { size: 100 });
    mockFs.__setFile('/mock-documents/photos/2026-08-30T09-15-42-123.jpg', { size: 200 });
    mockFs.__setFile('/mock-documents/photos/2026-08-29T23-59-59-999.jpg', { size: 300 });

    const photos = await listPhotos();

    expect(photos.map((p) => p.name)).toEqual([
      '2026-08-30T09-15-42-123.jpg',
      '2026-08-30T09-00-00-000.jpg',
      '2026-08-29T23-59-59-999.jpg',
    ]);
  });

  it('carries size and a file:// uri through for each entry', async () => {
    mockFs.__setFile('/mock-documents/photos/2026-08-30T09-00-00-000.jpg', { size: 12345 });

    const [photo] = await listPhotos();

    expect(photo.sizeBytes).toBe(12345);
    expect(photo.uri).toBe('file:///mock-documents/photos/2026-08-30T09-00-00-000.jpg');
    expect(photo.takenAt).toBe(Date.UTC(2026, 7, 30, 9, 0, 0, 0));
  });
});

describe('savePhoto', () => {
  it('moves the source into the photos directory and returns a file:// uri', async () => {
    mockFs.__setFile('/cache/tmp-capture.jpg', { size: 5000 });

    const stored = await savePhoto('/cache/tmp-capture.jpg');

    expect(stored.uri).toBe(`file://${stored.path}`);
    expect(stored.path.endsWith('.jpg')).toBe(true);
    expect(stored.sizeBytes).toBe(5000);

    const listed = await listPhotos();
    expect(listed).toHaveLength(1);
    expect(listed[0].path).toBe(stored.path);
  });

  it('strips a file:// scheme from the source path before moving', async () => {
    mockFs.__setFile('/cache/tmp-capture-2.jpg', { size: 42 });

    const stored = await savePhoto('file:///cache/tmp-capture-2.jpg');

    expect(stored.sizeBytes).toBe(42);
  });
});

describe('savePhotoToDeviceGallery', () => {
  it('copies the stored photo into the SmartCam device gallery album', async () => {
    await savePhotoToDeviceGallery('file:///mock-documents/photos/capture.jpg');

    expect(CameraRoll.saveAsset).toHaveBeenCalledWith(
      'file:///mock-documents/photos/capture.jpg',
      { type: 'photo', album: 'SmartCam' },
    );
  });
});
