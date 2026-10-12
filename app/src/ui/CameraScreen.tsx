import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Image, Pressable, StyleSheet, ActivityIndicator, AppState, Animated, Alert,
} from 'react-native';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { ensureConnected, teardown, getController, getStatus, subscribe, ConnStatus } from '../connection';
import { ShotRecord } from '../capture/CaptureController';
import { sharedLog, currentMode } from '../state';
import {
  StoredPhoto, savePhoto, savePhotoToDeviceGallery, listPhotos,
} from '../gallery/PhotoStore';

export default function CameraScreen(
  { onOpenDiagnostics, onOpenGallery }: { onOpenDiagnostics(): void; onOpenGallery(): void },
) {
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);
  const captureShutterCallbackRef = useRef<(() => void) | null>(null);
  const captureInProgressRef = useRef(false);

  // Transport mode lives in shared state (state.ts), set from the
  // Diagnostics screen's toggle, so it survives navigation — this screen
  // reads the live `currentMode` binding directly (not into a local const)
  // so effects that fire later (e.g. the AppState handler below) always act
  // on whatever mode is current at that moment, not whatever it was when
  // this component mounted.
  const [status, setStatus] = useState<ConnStatus>(getStatus());
  const [busy, setBusy] = useState(false);
  const [shutterFired, setShutterFired] = useState(false);
  const [last, setLast] = useState<ShotRecord | null>(null);
  const [lastPhoto, setLastPhoto] = useState<StoredPhoto | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  // Tracks whether the component is still mounted, so the initial gallery
  // load can't call setState after unmount. The connection's own lifecycle
  // is no longer tied to mount/unmount at all — see connection.ts — so this
  // ref exists only for that one async load below.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // The thumbnail is the only route into the Gallery, so it must be populated
  // from disk on a fresh launch, not only from captures taken this session —
  // otherwise photos saved in a previous session are reachable from nowhere.
  useEffect(() => {
    listPhotos()
      .then((ps) => { if (mountedRef.current && ps.length > 0) setLastPhoto(ps[0]); })
      .catch((e) => console.warn('[gallery] initial load failed:', e));
  }, []);

  // The connection is owned by connection.ts, not this component, precisely
  // so it survives navigation to the Gallery and back — the whole point of
  // this rewrite. Mounting only asks for a connection (idempotent — a no-op
  // if one is already up from before this screen mounted) and subscribes to
  // status; it deliberately does NOT tear down on unmount.
  useEffect(() => {
    ensureConnected(currentMode);
    const unsub = subscribe(setStatus);
    return () => { unsub(); };
  }, []);

  // Android suspends/backgrounds the app by releasing the Camera device, and
  // AppState here drops the flash transport on the same transition — so BOTH
  // must be re-established on return to foreground. Backgrounding must
  // cancel any armed fire and drop the link, otherwise a scheduled flash
  // could go off with the app not foreground, and the camera would hold its
  // device handle while suspended.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        ensureConnected(currentMode);   // reconnect: both camera and transport were dropped on background
      } else {
        teardown();
      }
    });
    return () => sub.remove();
  }, []);

  // Drives the fade-in of the timing pill. Reset to 0 and restarted on every
  // new shot rather than chained/queued — a shot lands roughly every 5s, so
  // there is never a backlog of fades waiting to play, and setValue() here
  // stops whatever animation was still running on the previous shot's fade.
  const pillOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!last) return;
    pillOpacity.setValue(0);
    Animated.timing(pillOpacity, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [last, pillOpacity]);

  const persistCapture = async (path: string) => {
    let stored: StoredPhoto;
    try {
      stored = await savePhoto(path);
      if (mountedRef.current) setLastPhoto(stored);
    } catch (e) {
      // vision-camera's cache path is already gone or unwritable — the shot
      // itself still happened and its timing record is unaffected, so this
      // is a warning, not a reason to fail the capture.
      console.warn('[gallery] savePhoto failed:', e);
      Alert.alert('Photo could not be saved', 'The capture completed, but SmartCam could not store the photo.');
      return;
    }

    try {
      await savePhotoToDeviceGallery(stored.uri);
    } catch (e) {
      console.warn('[gallery] device gallery save failed:', e);
      Alert.alert(
        'Photo saved in SmartCam only',
        'SmartCam saved the photo in its in-app gallery, but could not copy it to your phone gallery.',
      );
    }
  };

  const shoot = async () => {
    if (captureInProgressRef.current) return;
    captureInProgressRef.current = true;
    setBusy(true);
    setShutterFired(false);
    try {
      const controller = getController();
      if (controller && cameraRef.current) {
        const rec = await controller.shoot({
          takePhoto: async (onShutter) => {
            const camera = cameraRef.current;
            if (!camera) throw new Error('Camera is not ready.');
            captureShutterCallbackRef.current = onShutter;
            const p = await camera.takePhoto();
            return { path: p.path };
          },
        });
        sharedLog.add(rec);
        setLast(rec);
        if (rec.photoPath) await persistCapture(rec.photoPath);
      } else if (cameraRef.current) {
        // No flasher: still take the photo. Never block the camera on the accessory.
        captureShutterCallbackRef.current = () => setShutterFired(true);
        const p = await cameraRef.current.takePhoto();
        await persistCapture(p.path);
      }
    } finally {
      captureShutterCallbackRef.current = null;
      // Respect the firmware's 500ms cooldown so the next shot is not rejected.
      setTimeout(() => {
        captureInProgressRef.current = false;
        setBusy(false);
        setShutterFired(false);
      }, 600);
    }
  };

  const onCameraShutter = () => {
    const callback = captureShutterCallbackRef.current;
    captureShutterCallbackRef.current = null;
    callback?.();
  };

  const askForCameraPermission = async () => {
    setPermissionError(null);
    try {
      const granted = await requestPermission();
      if (!granted) {
        setPermissionError('Camera access was not granted. Enable it in Android settings to take photos.');
      }
    } catch (error) {
      console.warn('[camera] permission request failed:', error);
      setPermissionError('Could not request camera access. Close and reopen the app, then try again.');
    }
  };

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>Camera permission required</Text>
        <Pressable onPress={askForCameraPermission} style={styles.permissionButton}>
          <Text style={styles.permissionButtonText}>Allow camera access</Text>
        </Pressable>
        {permissionError && <Text style={styles.permissionError}>{permissionError}</Text>}
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>No camera found</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Camera ref={cameraRef} style={StyleSheet.absoluteFill}
              device={device} isActive={true} photo={true}
              androidPreviewViewType="texture-view" onShutter={onCameraShutter} />

      <View style={styles.topBar}>
        <Pressable onPress={onOpenDiagnostics} hitSlop={12}>
          <Text style={styles.link}>Diagnostics</Text>
        </Pressable>
      </View>

      {last && (
        <Animated.View style={[
          styles.pill,
          last.flashFired === false && styles.pillLate,
          last.flashFired === null && styles.pillMuted,
          { opacity: pillOpacity },
        ]}>
          <Text style={[
            styles.pillText,
            (last.flashFired === false || last.late) && styles.pillTextLate,
            last.flashFired === null && styles.pillTextMuted,
          ]}>
            {last.flashFired === true
              ? `${last.schedErrorUs == null
                ? 'FLASH FIRED'
                : `FLASH FIRED · schedule error ${last.schedErrorUs} µs`}${last.late ? ' · LATE' : ''}`
              : last.flashFired === false
                ? 'ACK RECEIVED · FLASH REJECTED (cooldown)'
                : 'NO ACK · flash firing unconfirmed'}
          </Text>
        </Animated.View>
      )}

      <View style={styles.bottomBar}>
        <View style={styles.bottomZoneLeft}>
          <Pressable onPress={onOpenGallery} hitSlop={10} style={styles.thumbWrap} testID="camera-open-gallery">
            {lastPhoto
              ? <Image source={{ uri: lastPhoto.uri }} style={styles.thumbImage} />
              : (
                <View style={styles.thumbPlaceholder}>
                  <Text style={styles.thumbPlaceholderText}>Gallery</Text>
                </View>
              )}
          </Pressable>
        </View>

        <View style={styles.bottomZoneCenter}>
          <Pressable
            onPress={shoot}
            disabled={busy}
            style={({ pressed }) => [
              styles.shutter,
              busy && styles.shutterBusy,
              pressed && !busy && styles.shutterPressed,
            ]}
          >
            {busy && !shutterFired
              ? <ActivityIndicator color="#101318" />
              : <View style={styles.shutterInner} />}
          </Pressable>
        </View>

        <View style={styles.bottomZoneRight}>
          <View style={styles.statusChip}>
            <View style={[
              styles.dot,
              status === 'connected' && styles.dotOk,
              status === 'connecting' && styles.dotConnecting,
              (status === 'idle' || status === 'error') && styles.dotOff,
            ]} />
            <Text style={styles.statusChipText}>{currentMode}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#101318' },
  dim:    { color: '#767D87', fontSize: 15 },
  permissionButton: { marginTop: 18, backgroundColor: '#DE9257', paddingHorizontal: 20,
                      paddingVertical: 12, borderRadius: 5 },
  permissionButtonText: { color: '#101318', fontSize: 14, fontWeight: '600' },
  permissionError: { color: '#E8A69B', fontSize: 13, textAlign: 'center', marginTop: 14,
                     marginHorizontal: 24 },

  topBar: { position: 'absolute', top: 48, left: 16, right: 16,
            flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
  link:   { color: '#DE9257', fontSize: 13, fontWeight: '600' },

  pill: { position: 'absolute', bottom: 150, alignSelf: 'center',
          backgroundColor: 'rgba(23,27,33,0.92)', borderWidth: 1, borderColor: '#2B313A',
          paddingHorizontal: 12, paddingVertical: 6, borderRadius: 5 },
  pillLate: { backgroundColor: 'rgba(163,39,26,0.18)', borderColor: '#A3271A' },
  pillMuted: { backgroundColor: 'rgba(23,27,33,0.7)', borderColor: '#2B313A' },
  pillText: { color: '#E3E6EA', fontSize: 12, fontVariant: ['tabular-nums'] },
  pillTextLate: { color: '#E8A69B' },
  pillTextMuted: { color: '#767D87' },

  bottomBar: { position: 'absolute', bottom: 48, left: 0, right: 0, paddingHorizontal: 24,
               flexDirection: 'row', alignItems: 'center' },
  bottomZoneLeft:   { flex: 1, alignItems: 'flex-start' },
  bottomZoneCenter: { alignItems: 'center' },
  bottomZoneRight:  { flex: 1, alignItems: 'flex-end' },

  thumbWrap: { width: 52, height: 52, borderRadius: 5, overflow: 'hidden',
               borderWidth: 1, borderColor: '#2B313A' },
  thumbImage: { width: '100%', height: '100%' },
  thumbPlaceholder: { width: '100%', height: '100%', backgroundColor: '#171B21',
                       alignItems: 'center', justifyContent: 'center' },
  thumbPlaceholderText: { color: '#767D87', fontSize: 9, fontWeight: '600',
                           letterSpacing: 0.3, textTransform: 'uppercase', textAlign: 'center' },

  shutter: { width: 74, height: 74, borderRadius: 37, backgroundColor: '#fff',
             alignItems: 'center', justifyContent: 'center' },
  shutterBusy: { backgroundColor: '#8A8F97', opacity: 0.7 },
  shutterPressed: { transform: [{ scale: 0.92 }], opacity: 0.85 },
  shutterInner: { width: 62, height: 62, borderRadius: 31, borderWidth: 2, borderColor: '#101318' },

  statusChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#171B21',
                borderWidth: 1, borderColor: '#2B313A', borderRadius: 5,
                paddingHorizontal: 10, paddingVertical: 6 },
  dot: { width: 7, height: 7, borderRadius: 3.5, marginRight: 6 },
  dotOk: { backgroundColor: '#2F6B45' },
  dotConnecting: { backgroundColor: '#DE9257' },
  dotOff: { backgroundColor: '#A3271A' },
  statusChipText: { color: '#A8AEB7', fontSize: 11, fontWeight: '600',
                     letterSpacing: 0.4, textTransform: 'uppercase' },
});
