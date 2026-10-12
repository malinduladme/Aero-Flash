import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import GalleryScreen from './GalleryScreen';
import * as PhotoStore from '../gallery/PhotoStore';
import { StoredPhoto } from '../gallery/PhotoStore';

// PhotoStore is mocked directly (rather than relying on the react-native-fs
// mock underneath it) so this test is about GalleryScreen's own wiring —
// does tapping a tile actually flip state to open the viewer, does Delete
// call through and close it, does dismiss close it without deleting —
// not about PhotoStore's filesystem behaviour, which PhotoStore.test.ts
// already covers. jest.mock() calls are hoisted above imports by
// babel-plugin-jest-hoist, so declaration order here doesn't matter.
jest.mock('../gallery/PhotoStore');

const photo: StoredPhoto = {
  path: '/mock-documents/photos/2026-08-30T09-15-42-123.jpg',
  uri: 'file:///mock-documents/photos/2026-08-30T09-15-42-123.jpg',
  name: '2026-08-30T09-15-42-123.jpg',
  takenAt: Date.UTC(2026, 7, 30, 9, 15, 42, 123),
  sizeBytes: 4096,
};

const listPhotosMock = PhotoStore.listPhotos as jest.Mock;
const deletePhotoMock = PhotoStore.deletePhoto as jest.Mock;

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

describe('GalleryScreen', () => {
  // FlatList's underlying VirtualizedList schedules a setTimeout to update
  // which cells to render; if the renderer is never unmounted, that timer
  // can fire after the test (and even after the whole suite) has finished,
  // producing a "Cannot log after tests are done" / act() warning that isn't
  // an actual failure but is worth silencing at the source rather than
  // ignoring. Unmounting cancels it.
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    listPhotosMock.mockResolvedValue([photo]);
    deletePhotoMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (renderer) await act(async () => { renderer!.unmount(); });
    renderer = undefined;
  });

  it('opens the full-screen viewer when a grid tile is tapped', async () => {
    await act(async () => {
      renderer = ReactTestRenderer.create(<GalleryScreen onBack={jest.fn()} />);
    });
    await flush();

    expect(renderer!.root.findAllByProps({ testID: 'gallery-viewer' })).toHaveLength(0);

    const tile = renderer!.root.findByProps({ testID: 'gallery-tile' });
    await act(async () => { tile.props.onPress(); });

    // react-test-renderer's TestInstance tree matches both the composite
    // <View> element and its underlying host node against the same props
    // object, so a present testID can legitimately show up more than once —
    // presence is ">0 matches", not "exactly 1".
    expect(renderer!.root.findAllByProps({ testID: 'gallery-viewer' }).length).toBeGreaterThan(0);
  });

  it('dismiss ("‹ Gallery") closes the viewer without deleting or calling onBack', async () => {
    const onBack = jest.fn();
    await act(async () => {
      renderer = ReactTestRenderer.create(<GalleryScreen onBack={onBack} />);
    });
    await flush();

    await act(async () => { renderer!.root.findByProps({ testID: 'gallery-tile' }).props.onPress(); });
    // react-test-renderer's TestInstance tree matches both the composite
    // <View> element and its underlying host node against the same props
    // object, so a present testID can legitimately show up more than once —
    // presence is ">0 matches", not "exactly 1".
    expect(renderer!.root.findAllByProps({ testID: 'gallery-viewer' }).length).toBeGreaterThan(0);

    await act(async () => { renderer!.root.findByProps({ testID: 'viewer-dismiss' }).props.onPress(); });

    expect(renderer!.root.findAllByProps({ testID: 'gallery-viewer' })).toHaveLength(0);
    expect(onBack).not.toHaveBeenCalled();
    expect(deletePhotoMock).not.toHaveBeenCalled();
  });

  it('Delete asks for confirmation, then removes the photo and returns to the grid', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      // Simulate the user tapping the destructive "Delete" button (index 1).
      const del = buttons?.find((b) => b.text === 'Delete');
      del?.onPress?.();
    });

    await act(async () => {
      renderer = ReactTestRenderer.create(<GalleryScreen onBack={jest.fn()} />);
    });
    await flush();

    await act(async () => { renderer!.root.findByProps({ testID: 'gallery-tile' }).props.onPress(); });
    // react-test-renderer's TestInstance tree matches both the composite
    // <View> element and its underlying host node against the same props
    // object, so a present testID can legitimately show up more than once —
    // presence is ">0 matches", not "exactly 1".
    expect(renderer!.root.findAllByProps({ testID: 'gallery-viewer' }).length).toBeGreaterThan(0);

    listPhotosMock.mockResolvedValue([]);   // the refresh after delete sees an empty store
    await act(async () => { renderer!.root.findByProps({ testID: 'viewer-delete' }).props.onPress(); });
    await flush();

    expect(alertSpy).toHaveBeenCalled();
    expect(deletePhotoMock).toHaveBeenCalledWith(photo.path);
    expect(renderer!.root.findAllByProps({ testID: 'gallery-viewer' })).toHaveLength(0);

    alertSpy.mockRestore();
  });
});
