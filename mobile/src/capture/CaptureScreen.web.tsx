/**
 * Browser capture preview. Two sources behind one viewfinder:
 *
 *  - camera: getUserMedia (the laptop webcam, or a phone's back camera in
 *    mobile Chrome), recorded with MediaRecorder;
 *  - replay: a video file played back as if it were the camera, so guidance
 *    can be tested on real aisle footage from a desk. Recording a replay
 *    captures the played stream, exactly as a live take would be captured.
 *
 * Frames are analysed by the same metrics/guidance code as the native app,
 * from a canvas instead of a camera buffer.
 */
import { router, useIsFocused } from 'expo-router';
import { Camera as CameraIcon, FileVideo, Upload, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BACKEND_WIDTH, sampleFrame } from '@/analysis/metrics.ts';
import { T } from '@/components/ui.tsx';
import { bytes } from '@/lib/format.ts';
import { addRecording, takeName } from '@/lib/recordings.ts';
import { useSettings } from '@/lib/settings.tsx';
import { color, font, radius, space, touch } from '@/theme.ts';

import { CaptureChrome } from './CaptureChrome.tsx';
import { buzz, useGuidanceHaptics } from './haptics.ts';
import { useGuidance } from './useGuidance.ts';

type Source = 'camera' | 'replay';

const ANALYSE_EVERY_MS = 100;
const BOXES_EVERY = 3;
const ACCEPT = 'video/mp4,video/webm,video/quicktime,.mp4,.mov,.m4v,.webm,.mkv,.avi';

const videoStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  background: '#000',
};

/** The first container/codec this browser can record, and the extension the server expects for it. */
function pickRecorderType(): { mimeType: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const options: [string, string][] = [
    ['video/webm;codecs=vp9', 'webm'],
    ['video/webm;codecs=vp8', 'webm'],
    ['video/webm', 'webm'],
    ['video/mp4', 'mp4'],
  ];
  for (const [mimeType, ext] of options) if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, ext };
  return null;
}

type CapturableVideo = HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };

function SourceSwitch({
  source,
  onChange,
  disabled,
}: {
  source: Source;
  onChange: (s: Source) => void;
  disabled: boolean;
}) {
  const items: [Source, string, typeof CameraIcon][] = [
    ['camera', 'Camera', CameraIcon],
    ['replay', 'Replay a video', FileVideo],
  ];
  return (
    <View style={styles.segment} accessibilityRole="tablist">
      {items.map(([key, label, Icon]) => {
        const on = source === key;
        return (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on, disabled }}
            disabled={disabled}
            onPress={() => onChange(key)}
            style={[styles.segItem, on && styles.segOn, disabled && !on && { opacity: 0.4 }]}
          >
            <Icon size={16} color={on ? color.accentFg : color.fg} />
            <Text style={[styles.segText, on && { color: color.accentFg }]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function CaptureScreen() {
  const { settings } = useSettings();
  const focused = useIsFocused();
  const [source, setSource] = useState<Source>('camera');
  const [file, setFile] = useState<File | null>(null);
  const fileUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  const videoRef = useRef<CapturableVideo | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);

  const feed = useGuidance(recording);
  useGuidanceHaptics(feed.guidance, recording, settings.haptics);
  const { push, reset } = feed;
  const [canvasOk] = useState(
    () => typeof document !== 'undefined' && !!document.createElement('canvas').getContext('2d'),
  );
  // Recording is allowed once a frame has been analysed from this source.
  const ready = feed.guidance != null;

  const changeSource = (s: Source) => {
    setCameraError(null);
    setError(null);
    setSource(s);
  };

  /* ---------------------------------------------------------- sources */

  useEffect(() => {
    if (!focused || source !== 'camera') return;
    let cancelled = false;
    const v = videoRef.current;
    reset();
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            window.isSecureContext
              ? 'This browser has no camera API.'
              : 'The camera needs a secure page: open the preview on localhost or https.',
          );
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: settings.audio,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (v) {
          v.removeAttribute('src');
          v.srcObject = stream;
          v.muted = true;
          await v.play().catch(() => undefined);
        }
      } catch (err) {
        const e = err as DOMException;
        setCameraError(
          e?.name === 'NotAllowedError'
            ? 'Camera access was blocked. Allow it in the address bar, or replay a video instead.'
            : e?.name === 'NotFoundError'
              ? 'No camera found. Replay a video instead.'
              : (e?.message ?? String(err)),
        );
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (v) v.srcObject = null;
    };
  }, [focused, source, settings.audio, reset]);

  useEffect(
    () => () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    },
    [fileUrl],
  );

  useEffect(() => {
    if (source !== 'replay') return;
    const v = videoRef.current;
    reset();
    if (!v || !fileUrl) return;
    v.srcObject = null;
    v.src = fileUrl;
    v.loop = true;
    v.muted = true;
    void v.play().catch(() => undefined);
  }, [source, fileUrl, reset]);

  /* --------------------------------------------------------- analysis */

  useEffect(() => {
    if (!focused) return;
    const v = videoRef.current;
    if (!v) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return; // reported in render via canvasOk
    let raf = 0;
    let last = 0;
    let n = 0;
    let lastT = -1;
    const onSeek = () => reset(); // replay looped or was scrubbed: motion history is void
    v.addEventListener('seeking', onSeek);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - last < ANALYSE_EVERY_MS) return;
      if (v.readyState < 2 || v.videoWidth === 0 || v.paused) return;
      last = now;
      // The backend measures blur at 960 px wide; never analyse above that.
      const scale = Math.min(1, BACKEND_WIDTH / v.videoWidth);
      const w = Math.round(v.videoWidth * scale);
      const h = Math.round(v.videoHeight * scale);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      try {
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        // Replay: the video's own clock, so a stalled tab does not read as a fast pan.
        const t = source === 'replay' ? v.currentTime : now / 1000;
        if (t <= lastT) return;
        lastT = t;
        n++;
        push(sampleFrame(img.data, w, h, w * 4, 4, t, settings.outlines && n % BOXES_EVERY === 0));
      } catch (err) {
        setError(`Could not read frames: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('seeking', onSeek);
    };
  }, [focused, source, fileUrl, push, reset, settings.outlines]);

  /* -------------------------------------------------------- recording */

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 250);
    return () => clearInterval(id);
  }, [recording]);

  const stop = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state !== 'inactive') r.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    const type = pickRecorderType();
    const v = videoRef.current;
    if (!type || !v) {
      setError('This browser cannot record video. Use "Count this file" to upload a video as it is.');
      return;
    }
    let stream: MediaStream | null = null;
    if (source === 'camera') {
      stream = streamRef.current;
    } else {
      // A take of a replay starts at the top, like walking into the aisle.
      v.loop = false;
      v.currentTime = 0;
      await v.play().catch(() => undefined);
      stream = v.captureStream?.() ?? v.mozCaptureStream?.() ?? null;
    }
    if (!stream) {
      setError('No video stream to record yet.');
      return;
    }
    chunks.current = [];
    const rec = new MediaRecorder(stream, { mimeType: type.mimeType, videoBitsPerSecond: 6_000_000 });
    rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    rec.onstop = () => {
      setRecording(false);
      if (videoRef.current && source === 'replay') videoRef.current.loop = true;
      const blob = new Blob(chunks.current, { type: type.mimeType.split(';')[0] });
      chunks.current = [];
      if (!blob.size) {
        setError('The recording was empty.');
        return;
      }
      const saved = addRecording({
        media: { kind: 'blob', blob, name: takeName(type.ext) },
        durationS: (Date.now() - startedAt.current) / 1000,
        sizeBytes: blob.size,
        origin: source,
      });
      router.replace({ pathname: '/upload/[id]', params: { id: saved.id } });
    };
    rec.onerror = () => {
      setError('Recording failed.');
      setRecording(false);
    };
    recorderRef.current = rec;
    rec.start(1000);
    reset();
    startedAt.current = Date.now();
    setElapsed(0);
    setRecording(true);
    buzz('start', settings.haptics);
  }, [source, reset, settings.haptics]);

  // A replay that reaches its end finishes the take by itself.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !recording || source !== 'replay') return;
    const onEnded = () => stop();
    v.addEventListener('ended', onEnded);
    return () => v.removeEventListener('ended', onEnded);
  }, [recording, source, stop]);

  useEffect(
    () => () => {
      // Leaving mid-take discards it.
      const r = recorderRef.current;
      if (r && r.state !== 'inactive') {
        r.onstop = null;
        r.stop();
      }
    },
    [],
  );

  const onRecord = () => {
    if (recording) {
      buzz('stop', settings.haptics);
      stop();
    } else void start();
  };

  const countFile = () => {
    if (!file) return;
    const ext = (file.name.split('.').pop() ?? 'mp4').toLowerCase();
    const saved = addRecording({
      media: { kind: 'blob', blob: file, name: file.name || takeName(ext) },
      durationS: Number.isFinite(videoRef.current?.duration) ? (videoRef.current?.duration ?? null) : null,
      sizeBytes: file.size,
      origin: 'replay',
    });
    router.replace({ pathname: '/upload/[id]', params: { id: saved.id } });
  };

  const choose = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name)) {
      setError(`${f.name} is not a video.`);
      return;
    }
    setFile(f);
    changeSource('replay');
  };

  /* ----------------------------------------------------------- render */

  const needsFile = source === 'replay' && !file;
  const blocked = !canvasOk
    ? 'This browser cannot read video frames (no 2D canvas).'
    : source === 'camera'
      ? cameraError
      : null;
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      choose(e.dataTransfer.files?.[0]);
    },
  };

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex' }} {...dropProps}>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        style={{ display: 'none' }}
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <CaptureChrome
        viewfinder={
          <>
            <video ref={videoRef} style={videoStyle} playsInline muted aria-label="Viewfinder" />
            {needsFile || blocked ? (
              <View style={styles.placeholder}>
                <T size="lg" weight="600" style={{ textAlign: 'center' }}>
                  {blocked ?? 'Replay aisle footage as if it were the camera'}
                </T>
                <Pressable accessibilityRole="button" onPress={() => inputRef.current?.click()} style={styles.pick}>
                  <FileVideo size={18} color={color.accentFg} />
                  <Text style={styles.pickText}>Choose a video file</Text>
                </Pressable>
                <T tone="subtle" size="sm">
                  or drop one anywhere on this page
                </T>
              </View>
            ) : null}
            {dragOver ? <View style={styles.drop} pointerEvents="none" /> : null}
          </>
        }
        guidance={needsFile || blocked ? null : feed.guidance}
        frame={feed.frame}
        settings={settings}
        recording={recording}
        elapsedS={elapsed}
        onRecord={onRecord}
        recordDisabled={!ready || !!blocked || needsFile}
        topAccessory={
          <View style={{ gap: space.sm }}>
            <SourceSwitch source={source} onChange={changeSource} disabled={recording} />
            {source === 'replay' && file && !recording ? (
              <View style={styles.fileRow}>
                <Text style={styles.fileName} numberOfLines={1}>
                  {file.name} · {bytes(file.size)}
                </Text>
                <Pressable accessibilityRole="button" onPress={() => inputRef.current?.click()} style={styles.smallBtn}>
                  <Text style={styles.smallBtnText}>Change</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={countFile}
                  style={[styles.smallBtn, { borderColor: color.accent }]}
                >
                  <Upload size={14} color={color.accent} />
                  <Text style={[styles.smallBtnText, { color: color.accent }]}>Count this file</Text>
                </Pressable>
              </View>
            ) : null}
            {error ? (
              <Text style={styles.error} accessibilityRole="alert">
                {error}
              </Text>
            ) : null}
          </View>
        }
        right={
          !recording ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close camera"
              onPress={() => router.back()}
              style={styles.tool}
            >
              <X size={22} color={color.fg} />
            </Pressable>
          ) : null
        }
      />
    </div>
  );
}

const styles = StyleSheet.create({
  segment: {
    flexDirection: 'row',
    alignSelf: 'center',
    backgroundColor: color.overlayStrong,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.lineStrong,
    padding: 3,
  },
  segItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    minHeight: 36,
    borderRadius: radius.pill,
  },
  segOn: { backgroundColor: color.accent },
  segText: { color: color.fg, fontSize: font.size.sm, fontWeight: '600' },
  placeholder: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    padding: space.xxl,
    backgroundColor: color.bg,
  },
  pick: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.accent,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    minHeight: touch.min,
  },
  pickText: { color: color.accentFg, fontWeight: '600', fontSize: font.size.md },
  drop: {
    ...StyleSheet.absoluteFill,
    borderWidth: 3,
    borderColor: color.accent,
    borderStyle: 'dashed',
    backgroundColor: 'rgba(91,140,255,0.12)',
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.overlayStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  fileName: { flex: 1, color: color.muted, fontSize: font.size.sm, fontFamily: font.mono },
  smallBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: color.lineStrong,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    minHeight: 32,
  },
  smallBtnText: { color: color.fg, fontSize: font.size.sm, fontWeight: '600' },
  error: {
    color: color.bad,
    backgroundColor: color.overlayStrong,
    borderRadius: radius.sm,
    padding: space.sm,
    fontSize: font.size.sm,
  },
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
