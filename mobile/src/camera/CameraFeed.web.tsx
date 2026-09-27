/**
 * The camera in the web preview.
 *
 * getUserMedia for a real camera (a laptop webcam, or a phone browser), or
 * a replayed video file, so the whole flow (guidance, recording, upload,
 * counting, review) can be exercised on a desk. Frames are measured from a
 * canvas at the backend's 960 px width with the same code the phone runs
 * in its worklet; recordings are WebM from MediaRecorder, which the server
 * counts like any other video.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { BACKEND_WIDTH, sampleFrame } from '@/analysis/metrics.ts';
import { color } from '@/theme';
import type { CameraFeedHandle, CameraFeedProps, Recording } from './types';

const SAMPLE_MS = 80; // ~12 measurements a second

function pickMime(): string {
  for (const m of ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

export const CameraFeed = forwardRef<CameraFeedHandle, CameraFeedProps>(function CameraFeed(
  { active, onSample, onExposure, onError, replay, onReplayEnded },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const [status, setStatus] = useState<string | null>('Starting camera…');

  // Source: a replayed file, or the camera.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !active) return;
    let cancelled = false;
    let url: string | null = null;
    setStatus(replay ? null : 'Starting camera…');
    (async () => {
      try {
        if (replay) {
          url = URL.createObjectURL(replay);
          video.srcObject = null;
          video.src = url;
          video.loop = false;
          await video.play();
        } else {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
          if (cancelled) return stream.getTracks().forEach((t) => t.stop());
          streamRef.current = stream;
          video.srcObject = stream;
          await video.play();
        }
        setStatus(null);
      } catch (e) {
        // A camera request that fails after the source changed (a replay was
        // chosen meanwhile) must not paint its error over the new source.
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus('No camera here. Use "Replay a video" to try the flow with a file.');
        onError(msg);
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (url) URL.revokeObjectURL(url);
    };
  }, [active, replay, onError]);

  // Measure frames.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) return;
      const w = Math.min(BACKEND_WIDTH, video.videoWidth);
      const h = Math.round((video.videoHeight * w) / video.videoWidth);
      const canvas = (canvasRef.current ??= document.createElement('canvas'));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      onSample(sampleFrame(data, w, h, w * 4, 4, performance.now() / 1000, true));
      const track = streamRef.current?.getVideoTracks()[0];
      if (track && onExposure) {
        const s = track.getSettings() as MediaTrackSettings & { exposureTime?: number; iso?: number };
        // exposureTime is in 100 µs units where supported (Chrome on Android).
        onExposure({ iso: s.iso ?? null, shutter: s.exposureTime ? s.exposureTime / 10000 : null });
      }
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [active, onSample, onExposure]);

  useImperativeHandle(ref, () => ({
    async startRecording() {
      const video = videoRef.current as (HTMLVideoElement & { captureStream?: () => MediaStream }) | null;
      const stream = streamRef.current ?? video?.captureStream?.();
      if (!stream) throw new Error('nothing to record');
      if (replay && video) {
        video.currentTime = 0;
        await video.play();
      }
      chunks.current = [];
      const rec = new MediaRecorder(stream, { mimeType: pickMime() || undefined, videoBitsPerSecond: 6_000_000 });
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.start(1000);
      recorderRef.current = rec;
      startedAt.current = Date.now();
    },
    stopRecording() {
      return new Promise<Recording | null>((resolve) => {
        const rec = recorderRef.current;
        if (!rec || rec.state === 'inactive') return resolve(null);
        rec.onstop = () => {
          const blob = new Blob(chunks.current, { type: rec.mimeType || 'video/webm' });
          recorderRef.current = null;
          resolve(blob.size ? { source: blob, durationS: (Date.now() - startedAt.current) / 1000 } : null);
        };
        rec.stop();
      });
    },
  }), [replay]);

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#000', overflow: 'hidden' }}>
      <video
        ref={videoRef}
        muted
        playsInline
        onEnded={() => onReplayEnded?.()}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
      {status && (
        <div
          style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24, color: color.muted, textAlign: 'center', fontFamily: 'system-ui', fontSize: 15,
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
});
