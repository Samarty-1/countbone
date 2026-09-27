/**
 * Building blocks. Dark, high-contrast, and sized for a gloved thumb: every
 * control is at least `touch.min` tall, the primary action `touch.primary`.
 */
import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { color, font, radius, space, touch } from '@/theme';

export function Screen({ children, scroll = true, padded = true }: { children: ReactNode; scroll?: boolean; padded?: boolean }) {
  const body = <View style={[padded && styles.padded, { gap: space.lg }]}>{children}</View>;
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      {scroll ? <ScrollView contentContainerStyle={{ paddingBottom: space.xxl }}>{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

export const Title = ({ children, sub }: { children: ReactNode; sub?: ReactNode }) => (
  <View>
    <Text style={styles.title} accessibilityRole="header">
      {children}
    </Text>
    {sub ? <Text style={styles.sub}>{sub}</Text> : null}
  </View>
);

export const SectionLabel = ({ children }: { children: ReactNode }) => <Text style={styles.section}>{children}</Text>;

export const Card = ({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) => (
  <View style={[styles.card, style]}>{children}</View>
);

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';

export function Button({
  label,
  onPress,
  variant = 'secondary',
  disabled,
  busy,
  icon,
  big,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  big?: boolean;
  accessibilityLabel?: string;
}) {
  const bg = { primary: color.accent, secondary: color.raised, danger: color.raised, ghost: 'transparent', success: color.ok }[variant];
  const fg = { primary: color.accentFg, secondary: color.fg, danger: color.bad, ghost: color.muted, success: color.accentFg }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={() => {
        if (Platform.OS !== 'web') void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, minHeight: big ? 60 : touch.min, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        variant !== 'ghost' && variant !== 'primary' && variant !== 'success' && styles.buttonBorder,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : icon}
      <Text style={[styles.buttonText, { color: fg, fontSize: big ? font.size.lg : font.size.md }]}>{label}</Text>
    </Pressable>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent' }) {
  const c = { neutral: color.muted, ok: color.ok, warn: color.warn, bad: color.bad, accent: color.accent }[tone];
  return (
    <View style={[styles.badge, { borderColor: c + '55', backgroundColor: c + '1a' }]}>
      <View style={[styles.dot, { backgroundColor: c }]} />
      <Text style={[styles.badgeText, { color: c }]}>{label}</Text>
    </View>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor={color.subtle} style={styles.input} accessibilityLabel={label} {...props} />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Row({ title, sub, right, onPress }: { title: string; sub?: string; right?: ReactNode; onPress?: () => void }) {
  const body = (
    <View style={styles.row}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
        {sub ? <Text style={styles.rowSub} numberOfLines={2}>{sub}</Text> : null}
      </View>
      {right}
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => (
  <View style={styles.empty}>
    <Text style={styles.emptyTitle}>{title}</Text>
    {children ? <Text style={styles.emptyText}>{children}</Text> : null}
  </View>
);

export const ErrorText = ({ error }: { error: unknown }) =>
  error ? (
    <Text accessibilityRole="alert" style={styles.error}>
      {error instanceof Error ? error.message : String(error)}
    </Text>
  ) : null;

export const Mono = ({ children, style }: { children: ReactNode; style?: object }) => <Text style={[styles.mono, style]}>{children}</Text>;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  padded: { padding: space.lg },
  title: { color: color.fg, fontSize: font.size.xl, fontWeight: '700', letterSpacing: -0.3 },
  sub: { color: color.muted, fontSize: font.size.sm, marginTop: space.xs, lineHeight: 19 },
  section: { color: color.subtle, fontSize: font.size.xs, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' },
  card: { backgroundColor: color.surface, borderColor: color.line, borderWidth: 1, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, borderRadius: radius.md, paddingHorizontal: space.lg },
  buttonBorder: { borderWidth: 1, borderColor: color.lineStrong },
  buttonText: { fontWeight: '600' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, height: 26, alignSelf: 'flex-start' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: font.size.xs, fontWeight: '600' },
  label: { color: color.muted, fontSize: font.size.sm },
  hint: { color: color.subtle, fontSize: font.size.xs },
  input: { minHeight: touch.min, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: color.bg, color: color.fg, paddingHorizontal: space.md, fontSize: font.size.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch.min, paddingVertical: space.sm },
  rowTitle: { color: color.fg, fontSize: font.size.md, fontWeight: '600' },
  rowSub: { color: color.muted, fontSize: font.size.sm },
  empty: { alignItems: 'center', padding: space.xl, gap: space.sm },
  emptyTitle: { color: color.fg, fontSize: font.size.lg, fontWeight: '600' },
  emptyText: { color: color.muted, fontSize: font.size.sm, textAlign: 'center', lineHeight: 19 },
  error: { color: color.bad, fontSize: font.size.sm, backgroundColor: color.bad + '1a', borderRadius: radius.md, padding: space.md },
  mono: { fontFamily: font.mono, color: color.fg },
});
