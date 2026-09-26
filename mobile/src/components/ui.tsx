import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  type RefreshControlProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { color, font, radius, space, touch } from '@/theme.ts';

export function Screen({
  children,
  scroll = true,
  edges = ['bottom', 'left', 'right'],
  refreshControl,
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  edges?: Edge[];
  refreshControl?: React.ReactElement<RefreshControlProps>;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <SafeAreaView style={styles.screen} edges={edges}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[styles.content, contentStyle]}
          refreshControl={refreshControl}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.content, styles.fill, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function T({
  children,
  tone = 'fg',
  size = 'md',
  weight = '400',
  mono,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  tone?: 'fg' | 'muted' | 'subtle' | 'ok' | 'warn' | 'bad' | 'accent' | 'accentFg';
  size?: keyof typeof font.size;
  weight?: '400' | '500' | '600' | '700';
  mono?: boolean;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        { color: color[tone], fontSize: font.size[size], fontWeight: weight },
        mono && { fontFamily: font.mono, fontVariant: ['tabular-nums'] },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  label,
  onPress,
  icon: Icon,
  variant = 'secondary',
  disabled,
  busy,
  style,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  icon?: LucideIcon;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}) {
  const fg = variant === 'primary' ? color.accentFg : variant === 'danger' ? color.bad : color.fg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && { backgroundColor: color.accent, borderColor: color.accent },
        variant === 'danger' && { borderColor: color.bad },
        variant === 'ghost' && { backgroundColor: 'transparent', borderColor: 'transparent' },
        pressed && { opacity: 0.75 },
        (disabled || busy) && { opacity: 0.45 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} size="small" /> : Icon ? <Icon size={18} color={fg} /> : null}
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.sectionTitle}>
      <T tone="subtle" size="xs" weight="600" style={{ letterSpacing: 0.8, textTransform: 'uppercase' }}>
        {children}
      </T>
      {right}
    </View>
  );
}

export function Pill({ label, tone = 'muted' }: { label: string; tone?: 'ok' | 'warn' | 'bad' | 'muted' | 'accent' }) {
  const c = color[tone];
  return (
    <View style={[styles.pill, { borderColor: c }]}>
      <Text style={{ color: c, fontSize: font.size.xs, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

export function ProgressBar({
  value,
  tone = 'accent',
}: {
  value: number | null;
  tone?: 'accent' | 'ok' | 'warn' | 'bad';
}) {
  const v = value == null ? null : Math.max(0, Math.min(1, value));
  return (
    <View
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityValue={v == null ? undefined : { min: 0, max: 100, now: Math.round(v * 100) }}
    >
      <View style={[styles.bar, { backgroundColor: color[tone], width: v == null ? '30%' : `${v * 100}%` }]} />
    </View>
  );
}

export function Swatch({ hex, size = 14 }: { hex: string | null; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 4,
        backgroundColor: hex ?? color.raised,
        borderWidth: 1,
        borderColor: color.lineStrong,
      }}
    />
  );
}

export function ToggleRow({
  label,
  detail,
  value,
  onChange,
}: {
  label: string;
  detail?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={() => onChange(!value)}
      style={styles.row}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <T>{label}</T>
        {detail ? (
          <T tone="subtle" size="sm">
            {detail}
          </T>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: color.lineStrong, true: color.accent }}
        thumbColor={color.fg}
      />
    </Pressable>
  );
}

export function Notice({
  tone = 'warn',
  title,
  detail,
  action,
}: {
  tone?: 'warn' | 'bad' | 'ok' | 'muted';
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <View style={[styles.notice, { borderColor: color[tone] }]} accessibilityRole="alert">
      <T weight="600" tone={tone === 'muted' ? 'fg' : tone}>
        {title}
      </T>
      {detail ? (
        <T tone="muted" size="sm">
          {detail}
        </T>
      ) : null}
      {action}
    </View>
  );
}

export function Stat({
  label,
  value,
  tone = 'fg',
}: {
  label: string;
  value: string;
  tone?: 'fg' | 'ok' | 'warn' | 'bad';
}) {
  return (
    <View style={styles.stat}>
      <T mono size="xl" weight="600" tone={tone}>
        {value}
      </T>
      <T tone="subtle" size="xs">
        {label}
      </T>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  fill: { flex: 1 },
  content: { padding: space.lg, gap: space.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },
  button: {
    minHeight: touch.min,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.lineStrong,
    backgroundColor: color.raised,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  buttonText: { fontSize: font.size.md, fontWeight: '600' },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.line,
    padding: space.lg,
    gap: space.md,
  },
  sectionTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: -space.sm,
  },
  pill: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  track: { height: 6, borderRadius: 3, backgroundColor: color.raised, overflow: 'hidden' },
  bar: { height: 6, borderRadius: 3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch.min },
  notice: {
    borderLeftWidth: 3,
    backgroundColor: color.surface,
    borderRadius: radius.sm,
    padding: space.md,
    gap: space.xs,
  },
  stat: { flex: 1, gap: 2 },
});
