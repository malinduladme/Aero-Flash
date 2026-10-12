import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Share, Alert } from 'react-native';
import { sharedLog, sharedSettings, currentMode, TransportMode } from '../state';
import {
  LEAD_TIME_MAX_MS, XENON_FLASH_DELAY_MAX_MS, XENON_FLASH_DELAY_STEP_MS,
  resetAutoTunedXenonFlashDelay,
} from '../capture/settings';
import {
  getController, getLastConnectionError, getStatus, subscribe, switchMode, ConnStatus,
} from '../connection';

const Row = ({ label, value, onDown, onUp }: {
  label: string; value: string; onDown(): void; onUp(): void;
}) => (
  <View style={styles.row}>
    <Text style={styles.rowLabel}>{label}</Text>
    <View style={styles.stepper}>
      <Pressable onPress={onDown} style={styles.step}><Text style={styles.stepText}>−</Text></Pressable>
      <Text style={styles.rowValue}>{value}</Text>
      <Pressable onPress={onUp} style={styles.step}><Text style={styles.stepText}>+</Text></Pressable>
    </View>
  </View>
);

const TransportToggle = ({ mode, switching, onSelect }: {
  mode: TransportMode; switching: boolean; onSelect(m: TransportMode): void;
}) => (
  <View style={styles.row}>
    <Text style={styles.rowLabel}>Transport</Text>
    <View style={styles.segment}>
      {(['ble', 'wifi'] as const).map((m) => {
        const active = mode === m;
        return (
          <Pressable
            key={m}
            onPress={() => onSelect(m)}
            disabled={switching}
            style={[styles.segmentOption, active && styles.segmentOptionActive]}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
              {active && switching ? 'switching…' : (m === 'ble' ? 'BLE' : 'WiFi')}
            </Text>
          </Pressable>
        );
      })}
    </View>
  </View>
);

export default function DiagnosticsScreen({ onBack }: { onBack(): void }) {
  const [, force] = useState(0);
  const redraw = () => force(x => x + 1);
  const [connStatus, setConnStatus] = useState<ConnStatus>(getStatus());
  const s = sharedLog.summary();
  const latest = sharedLog.records[sharedLog.records.length - 1];
  const linkQuality = getController()?.getLinkQuality() ?? null;

  useEffect(() => {
    const unsub = subscribe(setConnStatus);
    const refresh = setInterval(() => force(x => x + 1), 1000);
    return () => { unsub(); clearInterval(refresh); };
  }, []);

  const switching = connStatus === 'connecting';
  const onSelectMode = (m: TransportMode) => {
    if (m === currentMode || switching) return;
    switchMode(m);
  };

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const exportCsv = async () => {
    if (sharedLog.records.length === 0) {
      Alert.alert('Nothing to export', 'Take at least one shot before exporting the log.');
      return;
    }
    await Share.share({
      title: 'SmartCam latency log',
      message: sharedLog.toCsv(),
    });
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} hitSlop={12}><Text style={styles.link}>‹ Camera</Text></Pressable>
      <Text style={styles.h1}>Diagnostics</Text>

      <View style={styles.warning}>
        <Text style={styles.warningTitle}>External speedlight compatibility</Text>
        <Text style={styles.warningText}>
          The Aero firmware you supplied matches SmartCam's BLE/WiFi protocol and
          drives its PC817 input on GPIO4 with a fixed 500 µs pulse; GPIO3 is the
          shutter input. This supports manual speedlights such as the Godox TT520 II
          only when that firmware is running on the Aero PCB and the optocoupler's
          isolated output is correctly connected and rated for the flash sync
          voltage. Never connect a flash contact directly to an ESP32 GPIO. TTL,
          HSS, and flash-power control are not supported.
        </Text>
      </View>

      <Text style={styles.h2}>Timing parameters</Text>
      <Text style={styles.help}>
        Capture starts first. Xenon flash delay defines the intended fire timestamp
        relative to the camera request. Lead time only moves the FIRE_AT command
        earlier; it does not change that target timestamp.
      </Text>

      <TransportToggle mode={currentMode} switching={switching} onSelect={onSelectMode} />
      <Text style={styles.help}>
        The ESP32 serves one radio at a time. Hold its BOOT button for two seconds to
        switch the device, then match it here. Slow LED blink = BLE, fast = WiFi.
        BLE is a direct app connection and normally does not require pairing in
        Android Bluetooth settings.
      </Text>
      {getLastConnectionError() && (
        <Text style={styles.connectionError}>
          Connection failed: {getLastConnectionError()}
        </Text>
      )}

      <Text style={styles.h2}>Active link quality ({currentMode.toUpperCase()})</Text>
      <View style={styles.stats}>
        <Stat label="quality"
              value={linkQuality?.state.toUpperCase() ?? 'OFFLINE'} />
        <Stat label="median RTT"
              value={linkQuality?.medianRttUs == null
                ? '—'
                : `${(linkQuality.medianRttUs / 1000).toFixed(1)} ms`} />
        <Stat label="probe loss"
              value={linkQuality?.packetLossPercent == null
                ? '—'
                : `${linkQuality.packetLossPercent}%`} />
        <Stat label="samples"
              value={`${linkQuality?.samples ?? 0}/10`} />
      </View>
      <Text style={styles.help}>
        Measured from the last ten single SYNC_REQ probes, not radio signal
        strength or distance. The app sends one link-quality probe per second;
        full multi-sample sync is used for clock calibration, and these quality
        probes do not change the clock offset used for flash scheduling. RTT and
        probe loss describe application-level delivery quality; they do not move
        the scheduled fire target. Lead time is manual-only and affects when the
        command is sent. Missing ACKs can mean either command or return-packet loss.
      </Text>

      <Row label="Xenon flash delay"
           value={`${sharedSettings.xenonFlashDelayMs} ms`}
           onDown={() => {
             sharedSettings.xenonFlashDelayMs = clamp(
               sharedSettings.xenonFlashDelayMs - XENON_FLASH_DELAY_STEP_MS,
               0, XENON_FLASH_DELAY_MAX_MS,
             );
             redraw();
           }}
           onUp={() => {
             sharedSettings.xenonFlashDelayMs = clamp(
               sharedSettings.xenonFlashDelayMs + XENON_FLASH_DELAY_STEP_MS,
               0, XENON_FLASH_DELAY_MAX_MS,
             );
             redraw();
           }} />
      <Text style={styles.help}>
        {sharedSettings.xenonCalibrationTargetsMs.length > 0 &&
         latest?.xenonDelayBeforeAutoTuneMs != null &&
         latest.xenonDelayAfterAutoTuneMs != null
          ? `Last capture adjusted delay from ${latest.xenonDelayBeforeAutoTuneMs} ms to ` +
            `${latest.xenonDelayAfterAutoTuneMs} ms; ` +
            `${sharedSettings.xenonCalibrationTargetsMs.length}/5 recent valid samples.`
          : 'Waiting for valid on-time fire acknowledgements to build a calibration sample set.'}
        {' '}Each confirmed, scheduled, on-time capture sets the latest alignment
        target immediately. While connected, each one-second link-quality update
        reapplies that exact measured target; RTT does not shift the alignment
        target because FIRE_AT scheduling separates command delivery from firing.
        Lead time is manual-only and does not change automatically. Manual
        Xenon delay buttons change the setting in 10 ms increments. The app keeps up
        to five recent capture samples.
        Reset clears the sample window, hides the previous calibration result, and
        sets delay to 500 ms. Shutter-callback timing is not a direct sensor-exposure
        measurement; the firmware's fixed GPIO trigger pulse is unchanged.
      </Text>
      <Pressable
        onPress={() => {
          resetAutoTunedXenonFlashDelay(sharedSettings);
          redraw();
        }}
        style={[styles.button, styles.buttonGhost]}
        accessibilityRole="button"
        accessibilityLabel="Reset auto timing to default."
      >
        <Text style={styles.buttonGhostText}>Reset auto timing to default.</Text>
      </Pressable>

      <Row label="Lead time"
           value={`${sharedSettings.leadTimeMs} ms`}
           onDown={() => { sharedSettings.leadTimeMs = clamp(sharedSettings.leadTimeMs - 20, 20, LEAD_TIME_MAX_MS); redraw(); }}
           onUp={()   => { sharedSettings.leadTimeMs = clamp(sharedSettings.leadTimeMs + 20, 20, LEAD_TIME_MAX_MS); redraw(); }} />
      <Text style={styles.help}>
        Manually increase headroom to send the command earlier without moving the
        intended fire timestamp. RTT changes, late acknowledgements, and captures
        never change Lead time automatically.
      </Text>

      <Row label="Flash duration"
           value={`${sharedSettings.flashDurationMs} ms`}
           onDown={() => { sharedSettings.flashDurationMs = clamp(sharedSettings.flashDurationMs - 50, 50, 1000); redraw(); }}
           onUp={()   => { sharedSettings.flashDurationMs = clamp(sharedSettings.flashDurationMs + 50, 50, 1000); redraw(); }} />
      <Text style={styles.help}>
        The supplied Aero firmware accepts this protocol field but always outputs
        a fixed 500 µs PC817 trigger pulse; this setting does not change that pulse.
      </Text>

      <Text style={styles.h2}>Results so far</Text>
      <View style={styles.stats}>
        <Stat label="shots"          value={`${s.n}`} />
        <Stat label="ACK received"   value={`${s.ackReceived}`} />
        <Stat label="flash fired"    value={`${s.flashFired}`} />
        <Stat label="cooldown reject" value={`${s.cooldownRejected}`} />
        <Stat label="late"           value={`${s.lateCount}`} />
        <Stat label="command → ACK median"
              value={`${(s.commandToAckMedianUs / 1000).toFixed(1)} ms`} />
        <Stat label="error median"   value={`${s.errMedianUs} µs`} />
        <Stat label="error max"      value={`${s.errMaxUs} µs`} />
      </View>

      <Text style={styles.help}>
        Schedule error is ESP32 timer accuracy. Shutter-to-flash offset is a camera
        alignment proxy. ACK receipt alone does not prove firing: cooldown rejections
        are counted separately, and missing ACK means firing state is unknown.
        Command-to-ACK elapsed time includes waiting for the scheduled target; use
        median RTT above for the link round-trip estimate.
      </Text>

      <Text style={styles.h2}>Latest capture timings</Text>
      <View style={styles.stats}>
        <Stat label="request → shutter"
              value={latest?.cameraShutterAtHostUs == null
                ? '—'
                : `${((latest.cameraShutterAtHostUs - latest.cameraRequestAtHostUs) / 1000).toFixed(1)} ms`} />
        <Stat label="request → flash"
              value={latest?.flashActualAtHostUs == null
                ? '—'
                : `${((latest.flashActualAtHostUs - latest.cameraRequestAtHostUs) / 1000).toFixed(1)} ms`} />
        <Stat label="shutter → flash"
              value={latest?.cameraShutterAtHostUs == null || latest.flashActualAtHostUs == null
                ? '—'
                : `${((latest.flashActualAtHostUs - latest.cameraShutterAtHostUs) / 1000).toFixed(1)} ms`} />
        <Stat label="shutter → complete"
              value={latest?.cameraShutterAtHostUs == null || latest.captureCompletedAtHostUs == null
                ? '—'
                : `${((latest.captureCompletedAtHostUs - latest.cameraShutterAtHostUs) / 1000).toFixed(1)} ms`} />
      </View>
      <Text style={styles.help}>
        Shutter timing comes from the camera callback. Flash timing is estimated from
        the ESP32 acknowledgement; the shutter-to-flash offset is a useful alignment
        proxy, not proof of sensor exposure or a measure of radio scheduling accuracy.
        Auto tuning uses the request-to-shutter versus request-to-flash difference and
        updates Xenon delay directly to align the measured flash with the shutter
        callback. Link RTT is reported separately and does not move the scheduled
        target; Lead time remains manual.
      </Text>

      <Pressable onPress={exportCsv} style={styles.button}>
        <Text style={styles.buttonText}>Export CSV ({s.n} shots)</Text>
      </Pressable>

      <Pressable onPress={() => { sharedLog.clear(); redraw(); }} style={[styles.button, styles.buttonGhost]}>
        <Text style={styles.buttonGhostText}>Clear log</Text>
      </Pressable>

      <Text style={styles.h2}>Running the experiment</Text>
      <Text style={styles.help}>
        Four conditions, 50 shots each, clearing the log and exporting between them:
        {'\n'}1. WiFi + scheduled   2. WiFi + naive
        {'\n'}3. BLE + scheduled    4. BLE + naive
        {'\n\n'}Switch transport by holding BOOT on the device for two seconds.
        Switch scheduled/naive in code via CaptureController.shoot(camera, 'naive').
      </Text>
    </ScrollView>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <View style={styles.stat}>
    <Text style={styles.statValue}>{value}</Text>
    <Text style={styles.statLabel}>{label}</Text>
  </View>
);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101318' },
  content: { padding: 20, paddingTop: 56, gap: 4 },
  link: { color: '#DE9257', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  h1: { color: '#E3E6EA', fontSize: 26, fontWeight: '600', marginBottom: 12 },
  h2: { color: '#E3E6EA', fontSize: 15, fontWeight: '600', marginTop: 24, marginBottom: 6 },
  warning: {
    backgroundColor: '#30231B', borderColor: '#8F5735', borderWidth: 1,
    borderRadius: 8, padding: 12, marginBottom: 12,
  },
  warningTitle: { color: '#F3B27D', fontSize: 14, fontWeight: '700', marginBottom: 5 },
  warningText: { color: '#E3D5C9', fontSize: 13, lineHeight: 19 },
  connectionError: { color: '#F2A1A1', fontSize: 12.5, lineHeight: 18, marginBottom: 10 },
  help: { color: '#767D87', fontSize: 12.5, lineHeight: 18, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
         paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#2B313A' },
  rowLabel: { color: '#A8AEB7', fontSize: 14 },
  rowValue: { color: '#E3E6EA', fontSize: 14, fontWeight: '600', minWidth: 78,
              textAlign: 'center', fontVariant: ['tabular-nums'] },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  step: { width: 36, height: 32, alignItems: 'center', justifyContent: 'center',
          backgroundColor: '#1E232B', borderRadius: 4 },
  stepText: { color: '#DE9257', fontSize: 18, fontWeight: '600' },
  segment: { flexDirection: 'row', backgroundColor: '#1E232B', borderRadius: 5, padding: 2 },
  segmentOption: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 4 },
  segmentOptionActive: { backgroundColor: 'rgba(222,146,87,0.18)', borderWidth: 1, borderColor: '#DE9257' },
  segmentText: { color: '#767D87', fontSize: 12, fontWeight: '600',
                 letterSpacing: 0.4, textTransform: 'uppercase' },
  segmentTextActive: { color: '#DE9257' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  stat: { backgroundColor: '#171B21', borderRadius: 5, padding: 12, minWidth: 96 },
  statValue: { color: '#E3E6EA', fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  statLabel: { color: '#767D87', fontSize: 11, marginTop: 2 },
  button: { backgroundColor: '#DE9257', borderRadius: 5, paddingVertical: 13,
            alignItems: 'center', marginTop: 14 },
  buttonText: { color: '#101318', fontSize: 14, fontWeight: '700' },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#2B313A' },
  buttonGhostText: { color: '#A8AEB7', fontSize: 14, fontWeight: '600' },
});
