import React, { useState } from 'react';
import CameraScreen from './src/ui/CameraScreen';
import DiagnosticsScreen from './src/ui/DiagnosticsScreen';
import GalleryScreen from './src/ui/GalleryScreen';

export default function App() {
  const [screen, setScreen] = useState<'camera' | 'diag' | 'gallery'>('camera');
  if (screen === 'diag') return <DiagnosticsScreen onBack={() => setScreen('camera')} />;
  if (screen === 'gallery') return <GalleryScreen onBack={() => setScreen('camera')} />;
  return (
    <CameraScreen
      onOpenDiagnostics={() => setScreen('diag')}
      onOpenGallery={() => setScreen('gallery')}
    />
  );
}
