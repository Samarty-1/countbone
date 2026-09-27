/**
 * The phone camera (iOS / Android), through VisionCamera v5.
 *
 * Two outputs from one session: a frame output whose worklet measures each
 * frame on the camera thread (the Y plane is the grayscale image the
 * analysis needs; nothing is copied to JS but a small summary), and a video
 * output that records the MP4 the server counts.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameOutput,
  useVideoOutput,
  type CameraRef,
  type Recorder,
} from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { sampleFrame, type FrameSample } from '@/analysis/metrics.ts';
import { color, font, space } from '@/theme';
import type { CameraFeedHandle, CameraFeedProps, Recording } from './types';

export const CameraFeed = forwardRef<CameraFeedHandle, CameraFeedProps>(function CameraFeed(
  { active, torch, style, onSample, onExposure, onError },
  ref,
) {
  const device = useCameraDevice('back');
  const permission = useCameraPermission();
  const cameraRef = useRef<CameraRef>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const finished = useRef<((r: Recording | null) => void) | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!permission.hasPermission && permission.canRequestPermission) void permission.requestPermission();
  }, [permission]);

  // Samples are posted back to React; the worklet keeps every call cheap.
  const post = (s: FrameSample) => onSample(s);
  const frameOutput = useFrameOutput({
    pixelFormat: 'yuv',
    dropFramesWhileBusy: true,
    onFrame(frame) {
      'worklet';
      try {
        const planes = frame.getPlanes();
        const y = planes[0];
        if (y) {
          const buf = new Uint8Array(y.getPixelBuffer());
          // Edge boxes are the costly part: every other frame is plenty.
          const withBoxes = Math.floor(frame.timestamp * 10) % 2 === 0;
          const sample = sampleFrame(buf, y.width, y.height, y.bytesPerRow, 1, Date.now() / 1000, withBoxes);
          scheduleOnRN(post, sample);
        }
      } finally {
        frame.dispose();
      }
    },
  });
  const videoOutput = useVideoOutput({ enableAudio: false, fileType: 'mp4' });

  // ISO and shutter for the HUD, read from the live controller twice a second.
  useEffect(() => {
    if (!active || !onExposure) return;
    const id = setInterval(() => {
      const c = cameraRef.current?.controller;
      if (c) onExposure({ iso: c.iso ?? null, shutter: c.exposureDuration ?? null });
    }, 500);
    return () => clearInterval(id);
  }, [active, onExposure]);

  useImperativeHandle(ref, () => ({
    async startRecording() {
      const recorder = await videoOutput.createRecorder({});
      recorderRef.current = recorder;
      startedAt.current = Date.now();
      await recorder.startRecording(
        (filePath) => {
          finished.current?.({ source: filePath, durationS: (Date.now() - startedAt.current) / 1000 });
          finished.current = null;
        },
        (error) => {
          onError(`Recording failed: ${error.message}`);
          finished.current?.(null);
          finished.current = null;
        },
      );
    },
    stopRecording() {
      return new Promise<Recording | null>((resolve) => {
        const recorder = recorderRef.current;
        if (!recorder?.isRecording) return resolve(null);
        finished.current = resolve;
        void recorder.stopRecording();
      });
    },
  }), [videoOutput, onError]);

  if (!permission.hasPermission) {
    return (
      <View style={[styles.fill, styles.center, style]}>
        <Text style={styles.msg}>Countbone needs the camera to film the shelf.</Text>
        <Text style={styles.link} onPress={() => void permission.requestPermission()}>
          Allow camera
        </Text>
      </View>
    );
  }
  if (!device) {
    return (
      <View style={[styles.fill, styles.center, style]}>
        <Text style={styles.msg}>No back camera found on this device.</Text>
      </View>
    );
  }
  return (
    <Camera
      ref={cameraRef}
      style={[styles.fill, style]}
      device={device}
      isActive={active}
      outputs={[frameOutput, videoOutput]}
      torchMode={torch ? 'on' : 'off'}
      enableNativeTapToFocusGesture
      onError={(e) => onError(e.message)}
    />
  );
});

const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', padding: space.xl },
  msg: { color: color.fg, fontSize: font.size.md, textAlign: 'center' },
  link: { color: color.accent, fontSize: font.size.md, marginTop: space.md, padding: space.md },
});
