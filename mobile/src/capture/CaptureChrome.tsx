import type { ReactNode } from 'react';
import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Guidance } from '@/analysis/guidance.ts';
import type { Settings } from '@/lib/settings.tsx';
import { space } from '@/theme.ts';

import {
  BoxOverlay,
  DirectionArrow,
  FramingGrid,
  RecordButton,
  StatsReadout,
  WarningBanner,
  type Viewport,
} from './overlay.tsx';

/**
 * Viewfinder layout shared by the native camera and the browser preview:
 * the platform supplies the picture and the record action, this supplies
 * everything drawn over it.
 */
export function CaptureChrome({
  viewfinder,
  guidance,
  frame,
  settings,
  recording,
  elapsedS,
  onRecord,
  recordDisabled,
  left,
  right,
  topAccessory,
}: {
  viewfinder: ReactNode;
  guidance: Guidance | null;
  frame: { width: number; height: number } | null;
  settings: Settings;
  recording: boolean;
  elapsedS: number;
  onRecord: () => void;
  recordDisabled?: boolean;
  /** Bottom-left slot, next to the record button (defaults to the stats readout). */
  left?: ReactNode;
  right?: ReactNode;
  topAccessory?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<Viewport | null>(null);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setView({ width, height });
  };

  return (
    <View style={styles.root}>
      <View style={StyleSheet.absoluteFill} onLayout={onLayout}>
        {viewfinder}
        {settings.outlines ? <BoxOverlay guidance={guidance} frame={frame} view={view} /> : null}
        {settings.grid ? <FramingGrid /> : null}
        <DirectionArrow guidance={guidance} />
      </View>

      <View style={[styles.top, { paddingTop: insets.top + space.sm }]} pointerEvents="box-none">
        <WarningBanner guidance={guidance} recording={recording} />
        {topAccessory}
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + space.lg }]} pointerEvents="box-none">
        <View style={styles.side}>{left ?? (settings.stats ? <StatsReadout guidance={guidance} /> : null)}</View>
        <RecordButton recording={recording} elapsedS={elapsedS} onPress={onRecord} disabled={recordDisabled} />
        <View style={[styles.side, { alignItems: 'flex-end' }]}>{right}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  top: { position: 'absolute', left: space.md, right: space.md, top: 0, gap: space.sm },
  bottom: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  side: { flex: 1, justifyContent: 'flex-end' },
});
