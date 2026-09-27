/**
 * The viewfinder: film the shelf with live coaching.
 *
 * The camera feed measures every frame (sharpness, light, pace, direction,
 * tilt, distance) against what the server's counter needs, and the screen
 * says the one thing to change right now. Stopping a recording hands it to
 * the offline queue at once: the operator never waits for an upload.
 */
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Film, Flashlight, FlashlightOff, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useGuidance } from '@/analysis/useGuidance';
import { enqueue, newRecordingId } from '@/api/uploadQueue';
import { CameraFeed } from '@/camera/CameraFeed';
import type { CameraFeedHandle, Exposure } from '@/camera/types';
import { BoxesOverlay, CueBanner, FrameGuide, Hud, StatusPill } from '@/components/capture/Overlay';
import { RecordButton } from '@/components/capture/RecordButton';
import { useTilt } from '@/sensors/useTilt';
import { useSession } from '@/state/session';
import { keepRecording } from '@/storage/recordings';
import { color, font, radius, space, touch } from '@/theme';

const MIN_SECONDS = 2;

export default function Capture() {
  const router = useRouter();
  const { target } = useSession();
  const feed = useRef<CameraFeedHandle>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [saving, setSaving] = useState(false);
  const [torch, setTorch] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [exposure, setExposure] = useState<Exposure>({ iso: null, shutter: null });
  const [replay, setReplay] = useState<Blob | null>(null);
  const tilt = useTilt(true);
  const { guidance, onSample } = useGuidance(tilt, recording);
  const lastBuzz = useRef(0);

  // Recording clock.
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const id = setInterval(() => setSeconds((Date.now() - started) / 1000), 250);
    return () => clearInterval(id);
  }, [recording]);

  // A felt warning when the footage turns bad mid-recording (not more than every 2 s).
  useEffect(() => {
    if (!recording || guidance.status !== 'bad' || Platform.OS === 'web') return;
    const now = Date.now();
    if (now - lastBuzz.current > 2000) {
      lastBuzz.current = now;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  }, [recording, guidance.status]);

  const onError = useCallback((m: string) => setMessage(m), []);

  const stop = useCallback(async () => {
    setRecording(false);
    setSaving(true);
    try {
      const rec = await feed.current?.stopRecording();
      if (!rec) return setMessage('Nothing was recorded.');
      if ((rec.durationS ?? 0) < MIN_SECONDS) return setMessage('That was too short to count. Film the whole bay.');
      const id = newRecordingId();
      const stored = await keepRecording(rec.source, id);
      await enqueue(stored, target, id, rec.durationS);
      router.replace({ pathname: '/run/[id]', params: { id } });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [router, target]);

  const toggle = async () => {
    setMessage(null);
    if (recording) return stop();
    try {
      await feed.current?.startRecording();
      setSeconds(0);
      setRecording(true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const pickReplay = () => {
    if (Platform.OS !== 'web') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) setReplay(f);
    };
    input.click();
  };

  const cue = guidance.cues[0];
  return (
    <View style={styles.root}>
      <CameraFeed
        ref={feed}
        active
        torch={torch}
        onSample={onSample}
        onExposure={setExposure}
        onError={onError}
        replay={replay}
        onReplayEnded={() => recording && void stop()}
      />
      <FrameGuide scanning={recording} />
      <BoxesOverlay boxes={guidance.boxes} level={guidance.status} />

      <SafeAreaView style={styles.top} edges={['top']}>
        <View style={styles.topRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close camera"
            disabled={recording}
            onPress={() => router.back()}
            style={[styles.iconBtn, recording && { opacity: 0.3 }]}
          >
            <X color={color.fg} size={22} />
          </Pressable>
          <Text style={styles.target} numberOfLines={1}>
            {target.title}
          </Text>
          <View style={styles.spacer} />
        </View>
        <StatusPill status={guidance.status} label={guidance.label} recording={recording} seconds={seconds} />
        <View style={{ height: space.md }} />
        <CueBanner cue={cue} />
      </SafeAreaView>

      <SafeAreaView style={styles.bottom} edges={['bottom']}>
        {message && <Text style={styles.message}>{message}</Text>}
        <Hud guidance={guidance} exposure={exposure} />
        <View style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={torch ? 'Torch off' : 'Torch on'}
            onPress={() => setTorch((t) => !t)}
            style={styles.sideBtn}
          >
            {torch ? <Flashlight color={color.warn} size={24} /> : <FlashlightOff color={color.fg} size={24} />}
          </Pressable>
          <RecordButton recording={recording} level={guidance.status} disabled={saving} onPress={toggle} />
          {Platform.OS === 'web' ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Replay a video file" onPress={pickReplay} disabled={recording} style={styles.sideBtn}>
              <Film color={color.fg} size={24} />
              <Text style={styles.sideText}>Replay</Text>
            </Pressable>
          ) : (
            <View style={styles.sideBtn} />
          )}
        </View>
        <Text style={styles.caption}>{saving ? 'Saving…' : recording ? 'Tap to finish the bay' : 'Tap to start filming'}</Text>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  top: { position: 'absolute', left: 0, right: 0, top: 0, paddingTop: space.sm },
  topRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, marginBottom: space.sm },
  iconBtn: { width: touch.min, height: touch.min, borderRadius: touch.min / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color.overlay },
  spacer: { width: touch.min, height: touch.min },
  target: { flex: 1, textAlign: 'center', color: color.fg, fontWeight: '700', fontSize: font.size.md },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, gap: space.md, paddingBottom: space.md },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  sideBtn: { width: touch.min + 8, height: touch.min + 8, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: color.overlay },
  sideText: { color: color.fg, fontSize: 10, marginTop: 2 },
  caption: { color: color.muted, textAlign: 'center', fontSize: font.size.sm },
  message: { color: color.warn, textAlign: 'center', marginHorizontal: space.lg, backgroundColor: color.overlayStrong, padding: space.sm, borderRadius: radius.md },
});
