/**
 * The one big control: tap to start, tap to stop. A firm haptic on each,
 * a breathing ring while recording, and the ring's colour follows the
 * footage quality so the operator can feel and see it without reading.
 */
import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSpring, withTiming } from 'react-native-reanimated';

import type { Level } from '@/analysis/guidance.ts';
import { color, levelColor, touch } from '@/theme';

export function RecordButton({ recording, level, disabled, onPress }: { recording: boolean; level: Level; disabled?: boolean; onPress: () => void }) {
  const pulse = useSharedValue(1);
  const inner = useSharedValue(1);
  useEffect(() => {
    pulse.value = recording ? withRepeat(withTiming(1.12, { duration: 700 }), -1, true) : withTiming(1);
    inner.value = withSpring(recording ? 0.5 : 1, { damping: 14 });
  }, [recording, pulse, inner]);
  const ring = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));
  const core = useAnimatedStyle(() => ({
    transform: [{ scale: inner.value }],
    borderRadius: recording ? 8 : touch.primary / 2,
  }));
  const tint = recording ? levelColor[level] : color.fg;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={recording ? 'Stop recording' : 'Start recording'}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={16}
      onPress={() => {
        if (Platform.OS !== 'web') {
          void Haptics.impactAsync(recording ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Heavy);
        }
        onPress();
      }}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Animated.View style={[styles.ring, { borderColor: tint }, ring]}>
        <Animated.View style={[styles.core, core]} />
      </Animated.View>
      <View />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  ring: { width: touch.primary, height: touch.primary, borderRadius: touch.primary / 2, borderWidth: 5, alignItems: 'center', justifyContent: 'center' },
  core: { width: touch.primary - 22, height: touch.primary - 22, backgroundColor: color.bad },
});
