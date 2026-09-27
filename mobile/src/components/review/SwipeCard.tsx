/**
 * One review question as a card: swipe right to confirm, left to reject.
 * The gesture is a shortcut, never the only way: the same decisions are
 * buttons under the card (and screen readers get those).
 */
import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { color, font, radius, space } from '@/theme';

export type Swipe = 'accept' | 'reject';

export function SwipeCard({ children, onSwipe, acceptLabel, rejectLabel }: {
  children: ReactNode;
  onSwipe: (s: Swipe) => void;
  acceptLabel: string;
  rejectLabel: string;
}) {
  const { width } = useWindowDimensions();
  const x = useSharedValue(0);
  const threshold = width * 0.28;
  const crossed = useSharedValue(0);

  const tick = () => {
    if (Platform.OS !== 'web') void Haptics.selectionAsync();
  };
  const done = (s: Swipe) => {
    if (Platform.OS !== 'web') void Haptics.notificationAsync(s === 'accept' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
    onSwipe(s);
  };

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .onUpdate((e) => {
      x.value = e.translationX;
      const side = Math.abs(e.translationX) > threshold ? Math.sign(e.translationX) : 0;
      if (side !== crossed.value) {
        crossed.value = side;
        if (side !== 0) runOnJS(tick)();
      }
    })
    .onEnd((e) => {
      if (Math.abs(e.translationX) > threshold || Math.abs(e.velocityX) > 900) {
        const dir = e.translationX > 0 ? 1 : -1;
        x.value = withTiming(dir * width * 1.3, { duration: 180 }, () => {
          runOnJS(done)(dir > 0 ? 'accept' : 'reject');
        });
      } else {
        x.value = withSpring(0, { damping: 16 });
      }
      crossed.value = 0;
    });

  const card = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { rotate: `${interpolate(x.value, [-width, width], [-10, 10])}deg` }],
  }));
  const acceptStamp = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [0, threshold], [0, 1], 'clamp') }));
  const rejectStamp = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [-threshold, 0], [1, 0], 'clamp') }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.card, card]}>
        {children}
        <Animated.View pointerEvents="none" style={[styles.stamp, styles.stampAccept, acceptStamp]}>
          <Text style={[styles.stampText, { color: color.ok }]}>{acceptLabel}</Text>
        </Animated.View>
        <Animated.View pointerEvents="none" style={[styles.stamp, styles.stampReject, rejectStamp]}>
          <Text style={[styles.stampText, { color: color.bad }]}>{rejectLabel}</Text>
        </Animated.View>
        <View />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.surface, borderColor: color.lineStrong, borderWidth: 1, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  stamp: { position: 'absolute', top: space.lg, borderWidth: 2.5, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.xs },
  stampAccept: { left: space.lg, borderColor: color.ok, transform: [{ rotate: '-12deg' }] },
  stampReject: { right: space.lg, borderColor: color.bad, transform: [{ rotate: '12deg' }] },
  stampText: { fontSize: font.size.lg, fontWeight: '900', letterSpacing: 1 },
});
