/**
 * Native capture: VisionCamera preview + recorder, with a frame processor
 * that feeds the guidance engine. The browser preview lives in
 * CaptureScreen.web.tsx; Metro picks the right file per platform.
 */
import { router, useIsFocused } from 'expo-router';
import { Flashlight, FlashlightOff, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameOutput,
  useMicrophonePermission,
  useVideoOutput,
  type CameraOrientation,
  type Frame,
  type Recorder,
} from 'react-native-vision-camera';
import { createSynchronizable, scheduleOnRN } from 'react-native-worklets';

import { sampleFrame, type FrameSample, type Rotation } from '@/analysis/metrics.ts';
import { Button, Screen, T } from '@/components/ui.tsx';
import { addRecording, takeName } from '@/lib/recordings.ts';
import { useSettings } from '@/lib/settings.tsx';
import { color, radius, touch } from '@/theme.ts';

import { CaptureChrome } from './CaptureChrome.tsx';
import { buzz, useGuidanceHaptics } from './haptics.ts';
import { useGuidance } from './useGuidance.ts';

/** Guidance does not need 30 fps; 10 keeps the frame thread well under budget. */
const ANALYSE_EVERY_MS = 100;
/** Outlines are the most expensive metric; every third analysed frame is plenty. */
const BOXES_EVERY = 3;

function rotationOf(o: CameraOrientation): Rotation {
  'worklet';
  // Frame.orientation says how the pixels are rotated relative to upright
  // (EXIF semantics): "right" data displays after a clockwise quarter turn.
  return o === 'right' ? 90 : o === 'down' ? 180 : o === 'left' ? 270 : 0;
}

function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

function PermissionGate({ canAsk, onAsk }: { canAsk: boolean; onAsk: () => void }) {
  return (
    <Screen scroll={false} contentStyle={{ justifyContent: 'center' }}>
      <T size="xl" weight="700">
        Camera access needed
      </T>
      <T tone="muted">Countbone films the shelf you are counting. Video goes only to the server set in Settings.</T>
      {canAsk ? (
        <Button variant="primary" label="Allow camera" onPress={onAsk} />
      ) : (
        <Button variant="primary" label="Open system settings" onPress={() => void Linking.openSettings()} />
      )}
      <Button variant="ghost" label="Back" onPress={() => router.back()} />
    </Screen>
  );
}

export default function CaptureScreen() {
  const { settings } = useSettings();
  const camera = useCameraPermission();
  const mic = useMicrophonePermission();
  const device = useCameraDevice('back');
  const focused = useIsFocused();
  const appActive = useAppActive();

  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [torch, setTorch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<Recorder | null>(null);

  const feed = useGuidance(recording);
  useGuidanceHaptics(feed.guidance, recording, settings.haptics);

  useEffect(() => {
    if (camera.canRequestPermission) void camera.requestPermission();
  }, [camera]);
  useEffect(() => {
    if (settings.audio && mic.canRequestPermission) void mic.requestPermission();
  }, [settings.audio, mic]);

  useEffect(() => {
    if (!recording || startedAt == null) return;
    const id = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 250);
    return () => clearInterval(id);
  }, [recording, startedAt]);

  const withAudio = settings.audio && mic.hasPermission;
  const videoOutput = useVideoOutput({ enableAudio: withAudio, fileType: 'mp4' });

  // Worklet-side state must be shared across runtimes, not captured by value.
  const clock = useMemo(() => createSynchronizable({ last: 0, n: 0 }), []);
  const push = feed.push;
  const onSample = useCallback((s: FrameSample) => push(s), [push]);
  const outlines = settings.outlines;
  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      try {
        const now = Date.now();
        const st = clock.getDirty();
        if (now - st.last < ANALYSE_EVERY_MS || !frame.isValid) return;
        const n = st.n + 1;
        clock.setBlocking({ last: now, n });
        const rotation = rotationOf(frame.orientation);
        let sample: FrameSample;
        if (frame.isPlanar) {
          // YUV: plane 0 is full-resolution luma, exactly what the metrics want.
          const y = frame.getPlanes()[0];
          if (!y) return;
          const buf = new Uint8Array(y.getPixelBuffer());
          sample = sampleFrame(
            buf,
            y.width,
            y.height,
            y.bytesPerRow,
            1,
            now / 1000,
            outlines && n % BOXES_EVERY === 0,
            rotation,
          );
        } else {
          const buf = new Uint8Array(frame.getPixelBuffer());
          sample = sampleFrame(
            buf,
            frame.width,
            frame.height,
            frame.bytesPerRow,
            4,
            now / 1000,
            outlines && n % BOXES_EVERY === 0,
            rotation,
          );
        }
        scheduleOnRN(onSample, sample);
      } finally {
        frame.dispose();
      }
    },
    [clock, onSample, outlines],
  );
  const frameOutput = useFrameOutput({ pixelFormat: 'yuv', onFrame });

  const finish = useCallback((filePath: string, durationS: number) => {
    const uri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
    const rec = addRecording({
      media: { kind: 'file', uri, name: takeName('mp4'), mimeType: 'video/mp4' },
      durationS,
      sizeBytes: recorder.current?.recordedFileSize ?? null,
      origin: 'camera',
    });
    recorder.current = null;
    router.replace({ pathname: '/upload/[id]', params: { id: rec.id } });
  }, []);

  const toggleRecord = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!recording) {
        const r = await videoOutput.createRecorder({});
        recorder.current = r;
        const started = Date.now();
        await r.startRecording(
          (path) => finish(path, (Date.now() - started) / 1000),
          (err) => {
            setError(err.message);
            setRecording(false);
            recorder.current = null;
          },
        );
        feed.reset();
        setStartedAt(started);
        setElapsed(0);
        setRecording(true);
        buzz('start', settings.haptics);
      } else {
        buzz('stop', settings.haptics);
        setRecording(false);
        await recorder.current?.stopRecording();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRecording(false);
    } finally {
      setBusy(false);
    }
  }, [busy, recording, videoOutput, finish, feed, settings.haptics]);

  // Leaving mid-take discards it: a partial aisle is not a count.
  useEffect(
    () => () => {
      void recorder.current?.cancelRecording().catch(() => undefined);
    },
    [],
  );

  if (!camera.hasPermission) {
    return <PermissionGate canAsk={camera.canRequestPermission} onAsk={() => void camera.requestPermission()} />;
  }
  if (!device) {
    return (
      <Screen scroll={false} contentStyle={{ justifyContent: 'center' }}>
        <T size="xl" weight="700">
          No back camera
        </T>
        <T tone="muted">This device has no camera Countbone can use.</T>
        <Button label="Back" onPress={() => router.back()} />
      </Screen>
    );
  }

  const Torch = torch ? Flashlight : FlashlightOff;
  return (
    <CaptureChrome
      viewfinder={
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={focused && appActive}
          outputs={[videoOutput, frameOutput]}
          torchMode={torch ? 'on' : 'off'}
          resizeMode="cover"
          enableNativeTapToFocusGesture
          onError={(e) => setError(e.message)}
        />
      }
      guidance={feed.guidance}
      frame={feed.frame}
      settings={settings}
      recording={recording}
      elapsedS={elapsed}
      onRecord={() => void toggleRecord()}
      recordDisabled={busy}
      topAccessory={
        error ? (
          <T tone="bad" size="sm">
            {error}
          </T>
        ) : null
      }
      right={
        <View style={styles.tools}>
          {device.hasTorch ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={torch ? 'Turn torch off' : 'Turn torch on'}
              onPress={() => setTorch((t) => !t)}
              style={[styles.tool, torch && { borderColor: color.warn }]}
            >
              <Torch size={22} color={torch ? color.warn : color.fg} />
            </Pressable>
          ) : null}
          {!recording ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close camera"
              onPress={() => router.back()}
              style={styles.tool}
            >
              <X size={22} color={color.fg} />
            </Pressable>
          ) : null}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  tools: { gap: 12, alignItems: 'flex-end' },
  tool: {
    width: touch.min,
    height: touch.min,
    borderRadius: radius.pill,
    backgroundColor: color.overlay,
    borderWidth: 1,
    borderColor: color.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
