import { router } from 'expo-router';
import { Trash2, Upload } from 'lucide-react-native';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';

import { ago, bytes, duration } from '@/lib/format.ts';
import { removeRecording, type Recording } from '@/lib/recordings.ts';
import { color, space, touch } from '@/theme.ts';

import { T } from './ui.tsx';

function confirmDiscard(onYes: () => void) {
  const msg = 'This take has not been counted. Discard it?';
  if (Platform.OS === 'web') {
    if (window.confirm(msg)) onYes();
    return;
  }
  Alert.alert('Discard recording', msg, [
    { text: 'Keep', style: 'cancel' },
    { text: 'Discard', style: 'destructive', onPress: onYes },
  ]);
}

export function UnsentRow({ recording }: { recording: Recording }) {
  const meta = [
    ago(recording.createdAt),
    recording.durationS != null ? duration(recording.durationS) : null,
    recording.sizeBytes != null ? bytes(recording.sizeBytes) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View style={styles.row}>
      <View style={{ flex: 1, gap: 2 }}>
        <T numberOfLines={1} weight="500">
          {recording.media.name}
        </T>
        <T tone="subtle" size="sm">
          {meta}
        </T>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Discard recording"
        onPress={() => confirmDiscard(() => removeRecording(recording.id))}
        style={styles.icon}
      >
        <Trash2 size={20} color={color.subtle} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Upload recording"
        onPress={() => router.push({ pathname: '/upload/[id]', params: { id: recording.id } })}
        style={[styles.icon, { borderColor: color.accent, borderWidth: 1, borderRadius: 8 }]}
      >
        <Upload size={20} color={color.accent} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: touch.min + 8,
    paddingHorizontal: space.md,
  },
  icon: { width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' },
});
