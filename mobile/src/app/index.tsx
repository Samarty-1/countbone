import { router, Stack } from 'expo-router';
import { History, Scan, Settings as SettingsIcon } from 'lucide-react-native';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { LiveRow, RunRow } from '@/components/RunRow.tsx';
import { UnsentRow } from '@/components/UnsentRow.tsx';
import { Button, Card, Notice, Screen, SectionTitle, T } from '@/components/ui.tsx';
import { useFocusedQuery, useRecordings } from '@/lib/hooks.ts';
import { useSettings } from '@/lib/settings.tsx';
import { color, radius, space, touch } from '@/theme.ts';

function HeaderIcons() {
  return (
    <View style={{ flexDirection: 'row', gap: space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="History"
        onPress={() => router.push('/history')}
        style={styles.headerBtn}
      >
        <History size={22} color={color.fg} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={() => router.push('/settings')}
        style={styles.headerBtn}
      >
        <SettingsIcon size={22} color={color.fg} />
      </Pressable>
    </View>
  );
}

export default function Home() {
  const { api, settings } = useSettings();
  const recordings = useRecordings();
  const health = useFocusedQuery(() => api.health(), api.base);
  const runs = useFocusedQuery(
    () => api.runs(5),
    api.base,
    (d) => (d?.inFlight.some((r) => r.status === 'queued' || r.status === 'running') ? 2000 : null),
  );
  const live =
    runs.data?.inFlight.filter((r) => r.status === 'queued' || r.status === 'running' || r.status === 'failed') ?? [];
  const liveIds = new Set(live.map((r) => r.run_id));
  const recent = runs.data?.runs.filter((r) => !liveIds.has(r.run_id)) ?? [];

  return (
    <>
      <Stack.Screen options={{ headerRight: () => <HeaderIcons /> }} />
      <Screen
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => {
              health.reload();
              runs.reload();
            }}
            tintColor={color.muted}
          />
        }
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start a count"
          accessibilityHint="Opens the camera"
          onPress={() => router.push('/capture')}
          style={({ pressed }) => [styles.start, pressed && { opacity: 0.85 }]}
        >
          <Scan size={40} color={color.accentFg} />
          <View style={{ flex: 1 }}>
            <T tone="accentFg" size="xl" weight="700">
              Start a count
            </T>
            <T tone="accentFg" size="sm" style={{ opacity: 0.8 }}>
              Walk the aisle slowly, one direction, shelf in the band
            </T>
          </View>
        </Pressable>

        {health.error ? (
          <Notice
            tone="bad"
            title="Can't reach the countbone server"
            detail={`${health.error.message}. Check the address in Settings and that the phone is on the same network.`}
            action={
              <Button label="Open settings" onPress={() => router.push('/settings')} style={{ marginTop: space.sm }} />
            }
          />
        ) : health.data ? (
          <T tone="subtle" size="sm">
            Connected to {settings.serverUrl} · detector {health.data.detect} · {health.data.count}
          </T>
        ) : null}

        {recordings.length ? (
          <Card>
            <SectionTitle>Not uploaded</SectionTitle>
            {recordings.map((r) => (
              <UnsentRow key={r.id} recording={r} />
            ))}
          </Card>
        ) : null}

        {live.length ? (
          <Card>
            <SectionTitle>In progress</SectionTitle>
            {live.map((r) => (
              <LiveRow key={r.run_id} run={r} />
            ))}
          </Card>
        ) : null}

        <Card>
          <SectionTitle
            right={
              <Pressable accessibilityRole="link" onPress={() => router.push('/history')} hitSlop={10}>
                <T tone="accent" size="sm" weight="600">
                  All counts
                </T>
              </Pressable>
            }
          >
            Recent counts
          </SectionTitle>
          {recent.length ? (
            recent.map((r) => <RunRow key={r.run_id} run={r} />)
          ) : (
            <T tone="subtle">{runs.loading ? 'Loading…' : 'No counts yet.'}</T>
          )}
        </Card>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  start: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    backgroundColor: color.accent,
    borderRadius: radius.lg,
    padding: space.xl,
    minHeight: touch.primary + 24,
  },
  headerBtn: { width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' },
});
