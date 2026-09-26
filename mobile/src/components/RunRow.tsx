import { router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import type { LiveRun, RunSummary } from '@/lib/api.ts';
import { ago, pct, runTitle } from '@/lib/format.ts';
import { tierOf } from '@/lib/status.ts';
import { color, space, touch } from '@/theme.ts';

import { Pill, T } from './ui.tsx';

export function RunRow({ run }: { run: RunSummary }) {
  const tier = tierOf(run.overall_confidence);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${runTitle(run.run_id, run.source)}, ${run.total} counted`}
      onPress={() => router.push({ pathname: '/run/[id]', params: { id: run.run_id } })}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: color.hover }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <T numberOfLines={1} weight="500">
          {runTitle(run.run_id, run.source)}
        </T>
        <T tone="subtle" size="sm">
          {ago(run.started_at)} · {pct(run.overall_confidence)} confidence
        </T>
      </View>
      {run.needs_review ? <Pill label="Review" tone="warn" /> : null}
      <T mono size="lg" weight="600" tone={tier === 'high' ? 'fg' : tier === 'medium' ? 'warn' : 'bad'}>
        {run.total}
      </T>
      <ChevronRight size={18} color={color.subtle} />
    </Pressable>
  );
}

export function LiveRow({ run }: { run: LiveRun }) {
  const failed = run.status === 'failed';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/run/[id]', params: { id: run.run_id } })}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: color.hover }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <T numberOfLines={1} weight="500">
          {runTitle(run.run_id, run.source, run.filename)}
        </T>
        <T tone={failed ? 'bad' : 'subtle'} size="sm" numberOfLines={1}>
          {failed
            ? (run.error ?? 'Failed')
            : run.status === 'queued'
              ? 'Queued'
              : `Processing · ${run.phase ?? 'frames'}`}
        </T>
      </View>
      <Pill label={failed ? 'Failed' : 'Live'} tone={failed ? 'bad' : 'accent'} />
      <ChevronRight size={18} color={color.subtle} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: touch.min + 12,
    paddingHorizontal: space.md,
    borderRadius: 8,
  },
});
