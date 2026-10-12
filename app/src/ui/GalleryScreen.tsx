import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Image, Pressable, FlatList, StyleSheet, Dimensions, Alert, ActivityIndicator,
} from 'react-native';
import { StoredPhoto, listPhotos, deletePhoto } from '../gallery/PhotoStore';

const GRID_GAP = 2;
const GRID_PADDING = 8;
const COLUMNS = 3;
const { width: SCREEN_WIDTH } = Dimensions.get('window');
// Cell width computed so 3 columns + 2 inter-cell gaps + 2 outer paddings land
// exactly on the screen width, rather than approximating it with flex and
// per-item margins (the previous version added a right-margin to every tile,
// including the last column, which overflowed the row past the screen edge).
const TILE_SIZE = (SCREEN_WIDTH - GRID_PADDING * 2 - GRID_GAP * (COLUMNS - 1)) / COLUMNS;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// `ms` is an epoch timestamp (PhotoStore encodes it in the filename using UTC
// so filenames stay simple and unambiguous — that encoding is intentionally
// left alone). toLocaleString() with no `timeZone` option renders an epoch
// instant in the DEVICE's local timezone by default, so what the user sees
// here is already local time, not UTC.
function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export default function GalleryScreen({ onBack }: { onBack(): void }) {
  const [photos, setPhotos] = useState<StoredPhoto[] | null>(null);
  const [viewing, setViewing] = useState<StoredPhoto | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    const list = await listPhotos();
    setPhotos(list);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const totalSize = (photos ?? []).reduce((sum, p) => sum + p.sizeBytes, 0);

  const confirmDelete = (photo: StoredPhoto) => {
    Alert.alert(
      'Delete photo',
      'This removes it from the app permanently.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await deletePhoto(photo.path);
              setViewing(null);
              await refresh();
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12} testID="gallery-back-link">
          <Text style={styles.link}>‹ Camera</Text>
        </Pressable>
        <Text style={styles.h1}>Gallery</Text>
        <Text style={styles.subhead}>
          {photos === null ? 'loading…' : `${photos.length} photo${photos.length === 1 ? '' : 's'} · ${formatSize(totalSize)}`}
        </Text>
      </View>

      {photos === null ? (
        <View style={styles.center}>
          <ActivityIndicator color="#DE9257" />
        </View>
      ) : photos.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No photos yet</Text>
          <Text style={styles.emptyBody}>Shots you take will land here once you head back and fire the shutter.</Text>
        </View>
      ) : (
        <FlatList
          data={photos}
          key={COLUMNS}
          numColumns={COLUMNS}
          keyExtractor={(item) => item.path}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.gridRow}
          renderItem={({ item }) => (
            <Pressable onPress={() => setViewing(item)} style={styles.tile} testID="gallery-tile">
              <Image source={{ uri: item.uri }} style={styles.thumb} resizeMode="cover" />
            </Pressable>
          )}
        />
      )}

      {viewing && (
        <View style={styles.viewer} testID="gallery-viewer">
          <Image source={{ uri: viewing.uri }} style={styles.fullImage} resizeMode="contain" />
          <View style={styles.viewerTopBar}>
            <Pressable onPress={() => setViewing(null)} hitSlop={12} testID="viewer-dismiss">
              <Text style={styles.link}>‹ Gallery</Text>
            </Pressable>
          </View>
          <View style={styles.viewerBottomBar}>
            <View>
              <Text style={styles.viewerMeta}>{formatTime(viewing.takenAt)}</Text>
              <Text style={styles.viewerMetaMuted}>{formatSize(viewing.sizeBytes)}</Text>
            </View>
            <Pressable
              onPress={() => confirmDelete(viewing)}
              disabled={deleting}
              style={[styles.deleteButton, deleting && styles.deleteButtonBusy]}
              testID="viewer-delete"
            >
              {deleting
                ? <ActivityIndicator color="#E3E6EA" size="small" />
                : <Text style={styles.deleteButtonText}>Delete</Text>}
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101318' },
  header: { paddingHorizontal: 20, paddingTop: 56, paddingBottom: 14 },
  link: { color: '#DE9257', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  h1: { color: '#E3E6EA', fontSize: 26, fontWeight: '600' },
  subhead: { color: '#767D87', fontSize: 12.5, marginTop: 4, fontVariant: ['tabular-nums'] },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  emptyTitle: { color: '#A8AEB7', fontSize: 15, fontWeight: '600', marginBottom: 6 },
  emptyBody: { color: '#767D87', fontSize: 13, textAlign: 'center', lineHeight: 19 },

  // Explicit top padding puts clear air between the header (whose back link
  // has a 12px hitSlop) and the first row of tiles, so a tap near the top of
  // the grid cannot register on the link above it.
  grid: { paddingHorizontal: GRID_PADDING, paddingTop: GRID_PADDING, paddingBottom: 24 },
  gridRow: { gap: GRID_GAP, marginBottom: GRID_GAP },
  tile: { width: TILE_SIZE, aspectRatio: 1, backgroundColor: '#171B21', borderRadius: 5,
          overflow: 'hidden' },
  thumb: { width: '100%', height: '100%' },

  viewer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
  fullImage: { flex: 1 },
  viewerTopBar: { position: 'absolute', top: 48, left: 16 },
  viewerBottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0,
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                      backgroundColor: 'rgba(16,19,24,0.9)', borderTopWidth: 1, borderTopColor: '#2B313A',
                      paddingHorizontal: 20, paddingVertical: 16, paddingBottom: 28 },
  viewerMeta: { color: '#E3E6EA', fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  viewerMetaMuted: { color: '#767D87', fontSize: 12, marginTop: 2, fontVariant: ['tabular-nums'] },
  deleteButton: { backgroundColor: '#A3271A', borderRadius: 5, paddingHorizontal: 18, paddingVertical: 10,
                  minWidth: 84, alignItems: 'center' },
  deleteButtonBusy: { opacity: 0.7 },
  deleteButtonText: { color: '#E3E6EA', fontSize: 13, fontWeight: '700' },
});
