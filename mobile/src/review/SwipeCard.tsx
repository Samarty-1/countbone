/**
 * One review decision as a card: swipe right to accept, left to reject.
 * The buttons under the stack do the same thing, for one-handed use with
 * gloves and for screen readers, so the gesture is never the only way.
 */
import { useEffect, type ReactNode } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { color, font, radius, space } from '@/theme.ts';

export type SwipeDecision = 'accept' | 'reject';

/** Past this fraction of the card width, or a fast flick, a release decides. */
const DECIDE_AT = 0.28;
const FLICK_VELOCITY = 900;

export function SwipeCard({
  children,
  canAccept,
  onDecide,
  onBlocked,
  armed,
}: {
  children: ReactNode;
  /** false when accepting would be meaningless (e.g. no SKU chosen for an unknown object). */
  canAccept: boolean;
  onDecide: (d: SwipeDecision) => void;
  /** The operator swiped right on a card that cannot be accepted yet. */
  onBlocked: () => void;
  /** Set by the parent to fly the card off for a button press. */
  armed: SwipeDecision | null;
}) {
  const { width } = useWindowDimensions();
  const cardW = Math.min(width - space.lg * 2, 560);
  const x = useSharedValue(0);
  const y = useSharedValue(0);

  useEffect(() => {
    if (!armed) return;
    const dir = armed === 'accept' ? 1 : -1;
    x.set(
      withTiming(dir * cardW * 1.4, { duration: 220 }, (done) => {
        if (done) scheduleOnRN(onDecide, armed);
      }),
    );
  }, [armed, cardW, onDecide, x]);

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-24, 24])
    .onUpdate((e) => {
      x.set(e.translationX);
      y.set(e.translationY * 0.2);
    })
    .onEnd((e) => {
      const far = Math.abs(x.get()) > cardW * DECIDE_AT || Math.abs(e.velocityX) > FLICK_VELOCITY;
      const dir = x.get() > 0 ? 1 : -1;
      if (far && (dir < 0 || canAccept)) {
        const decision: SwipeDecision = dir > 0 ? 'accept' : 'reject';
        x.set(
          withTiming(dir * cardW * 1.4, { duration: 180 }, (done) => {
            if (done) scheduleOnRN(onDecide, decision);
          }),
        );
      } else {
        if (far && dir > 0 && !canAccept) scheduleOnRN(onBlocked);
        x.set(withSpring(0, { damping: 18 }));
      }
      y.set(withSpring(0));
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.get() },
      { translateY: y.get() },
      { rotate: `${interpolate(x.get(), [-cardW, cardW], [-12, 12], Extrapolation.CLAMP)}deg` },
    ],
  }));
  const acceptStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.get(), [0, cardW * DECIDE_AT], [0, 1], Extrapolation.CLAMP),
  }));
  const rejectStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.get(), [-cardW * DECIDE_AT, 0], [1, 0], Extrapolation.CLAMP),
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.card, { width: cardW }, cardStyle]}>
        {children}
        <Animated.View
          pointerEvents="none"
          style={[styles.stamp, styles.stampAccept, !canAccept && { borderColor: color.subtle }, acceptStyle]}
        >
          <Text style={[styles.stampText, { color: canAccept ? color.ok : color.subtle }]}>
            {canAccept ? 'ACCEPT' : 'PICK A SKU'}
          </Text>
        </Animated.View>
        <Animated.View pointerEvents="none" style={[styles.stamp, styles.stampReject, rejectStyle]}>
          <Text style={[styles.stampText, { color: color.bad }]}>REJECT</Text>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

/** The next card peeking out beneath the active one; fills its parent. */
export function CardShadow() {
  return <View pointerEvents="none" style={[styles.card, styles.shadow]} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.lineStrong,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
    alignSelf: 'center',
  },
  shadow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 10,
    bottom: -10,
    transform: [{ scale: 0.95 }],
    opacity: 0.5,
  },
  stamp: {
    position: 'absolute',
    top: space.lg,
    borderWidth: 3,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    backgroundColor: color.overlayStrong,
  },
  stampAccept: { left: space.lg, borderColor: color.ok, transform: [{ rotate: '-10deg' }] },
  stampReject: { right: space.lg, borderColor: color.bad, transform: [{ rotate: '10deg' }] },
  stampText: { fontSize: font.size.xl, fontWeight: '800', letterSpacing: 1 },
});
