import type { StyleProp, ViewStyle } from 'react-native';

import type { FrameSample } from '@/analysis/metrics.ts';

export interface Recording {
  /** A file path (native) or a Blob (web). */
  source: string | Blob;
  durationS: number | null;
}

export interface Exposure {
  iso: number | null;
  /** Shutter time in seconds. */
  shutter: number | null;
}

export interface CameraFeedHandle {
  startRecording(): Promise<void>;
  /** Resolves with the finished recording (null if nothing was recorded). */
  stopRecording(): Promise<Recording | null>;
}

export interface CameraFeedProps {
  active: boolean;
  torch?: boolean;
  style?: StyleProp<ViewStyle>;
  onSample: (sample: FrameSample) => void;
  onExposure?: (e: Exposure) => void;
  onError: (message: string) => void;
  /** Web preview only: play this file instead of a camera (for testing without one). */
  replay?: Blob | null;
  /** Web preview only: the replayed file ended (recording stops with it). */
  onReplayEnded?: () => void;
}
