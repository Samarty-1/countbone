import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, type RunSummary } from '@/api/client';
import { discard, pump, retry, waitsForSomeoneElse, type QueueItem } from '@/api/uploadQueue';
import { Badge, Button, Card, Empty, Row, SectionLabel, Title } from '@/components/ui';
import { useQueue } from '@/state/useQueue';
import { color, font, radius, space } from '@/theme';

function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function Item({ item }: { item: QueueItem }) {
  const router = useRouter();
  const frac = item.recording.size ? item.sent / item.recording.size : 0;
  const tone = item.state === 'done' ? 'ok' : item.state === 'failed' ? 'bad' : item.state === 'uploading' ? 'accent' : 'warn';
  const label = { done: 'sent', failed: 'refused', uploading: `${Math.round(frac * 100)}%`, waiting: 'waiting' }[item.state];
  return (
    <Card>
      <Row
        title={item.target.title}
        sub={`${ago(item.createdAt)} · ${mb(item.recording.size)}${item.durationS ? ` · ${Math.round(item.durationS)} s` : ''}`}
        right={<Badge label={label} tone={tone} />}
        onPress={() => router.push({ pathname: '/run/[id]', params: { id: item.runId ?? item.id } })}
      />
      {item.state === 'uploading' && (
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.round(frac * 100)}%` }]} />
        </View>
      )}
      {item.state === 'waiting' && waitsForSomeoneElse(item) ? (
        <Text style={styles.err}>
          Filmed by {item.ownerName ?? 'someone else'}: it uploads when they sign in on this phone.
        </Text>
      ) : item.error && item.state !== 'done' ? (
        <Text style={styles.err}>{item.error}</Text>
      ) : null}
      {item.state === 'failed' && (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button label="Try again" variant="primary" onPress={() => void retry(item.id)} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Delete video" variant="danger" onPress={() => void discard(item.id)} />
          </View>
        </View>
      )}
    </Card>
  );
}

export default function Queue() {
  const router = useRouter();
  const queue = useQueue();
  const [recent, setRecent] = useState<RunSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    void pump();
    try {
      setRecent((await api.runs(20)).runs);
    } catch {
      /* offline: the queue still shows */
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const onPhone = queue.filter((q) => q.state !== 'done');
  const pendingBytes = onPhone.reduce((s, q) => s + (q.recording.size - q.sent), 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={color.accent} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      >
        <Title sub={onPhone.length ? `${onPhone.length} video(s), ${mb(pendingBytes)} still to send. They go by themselves when there is a connection.` : 'Everything is sent.'}>
          Uploads
        </Title>
        {onPhone.length > 0 && <SectionLabel>On this phone</SectionLabel>}
        {onPhone.map((q) => <Item key={q.id} item={q} />)}
        <SectionLabel>Recent counts</SectionLabel>
        {recent.length === 0 ? (
          <Empty title="No counts yet" />
        ) : (
          <Card>
            {recent.map((r) => (
              <Row
                key={r.run_id}
                title={`${r.location ?? 'No bay'} · ${r.total} units`}
                sub={`${r.kind === 'receive' ? 'Delivery' : r.kind === 'recount' ? 'Recount' : 'Cycle count'} · ${ago(r.started_at * 1000)}`}
                right={r.needs_review ? <Badge label="check" tone="warn" /> : <Badge label="final" tone="ok" />}
                onPress={() => router.push({ pathname: '/run/[id]', params: { id: r.run_id } })}
              />
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  track: { height: 6, borderRadius: radius.pill, backgroundColor: color.line, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: color.accent },
  err: { color: color.subtle, fontSize: font.size.xs },
});
