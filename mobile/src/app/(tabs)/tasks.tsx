import { useFocusEffect, useRouter } from 'expo-router';
import { Minus, Plus, Video } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api, type Task } from '@/api/client';
import { Badge, Button, Card, Empty, ErrorText, Title } from '@/components/ui';
import { useSession } from '@/state/session';
import { color, font, radius, space, touch } from '@/theme';

function TaskCard({ task, onDone }: { task: Task; onDone: () => void }) {
  const router = useRouter();
  const { target, setTarget } = useSession();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(task.counted ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [now] = useState(() => Date.now());
  const overdue = task.due_at != null && task.due_at * 1000 < now;
  const v = task.variance ?? 0;

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        <Text style={styles.sku}>{task.sku}</Text>
        <Text style={styles.at}>at</Text>
        <Text style={styles.loc}>{task.location}</Text>
        {overdue ? <Badge label="overdue" tone="bad" /> : null}
      </View>
      <Text style={styles.reason}>
        The video counted {task.counted}, the book says {task.expected} (
        <Text style={{ color: v < 0 ? color.bad : color.warn, fontWeight: '700' }}>{v > 0 ? `+${v}` : v}</Text>).
        Count it by hand, or film it again.
      </Text>
      {open ? (
        <>
          <View style={styles.stepper}>
            <Pressable accessibilityRole="button" accessibilityLabel="One fewer" onPress={() => setCount((n) => Math.max(0, n - 1))} style={styles.stepBtn}>
              <Minus color={color.fg} size={24} />
            </Pressable>
            <Text style={styles.value} accessibilityLabel={`Counted ${count}`}>{count}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="One more" onPress={() => setCount((n) => n + 1)} style={styles.stepBtn}>
              <Plus color={color.fg} size={24} />
            </Pressable>
          </View>
          <ErrorText error={error} />
          <Button
            label={`Save: ${count} on the shelf`}
            variant="primary"
            big
            busy={busy}
            onPress={async () => {
              setBusy(true);
              try {
                await api.completeTask(task.task_id, count);
                onDone();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          />
        </>
      ) : (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button label="Enter count" variant="primary" onPress={() => setOpen(true)} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="Film it"
              icon={<Video color={color.fg} size={18} />}
              onPress={() => {
                setTarget({ ...target, kind: 'recount', task_id: task.task_id, location: task.location, receipt_id: null, title: `${task.location} · recount ${task.sku}` });
                router.push('/capture');
              }}
            />
          </View>
        </View>
      )}
    </Card>
  );
}

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setTasks(await api.tasks(true));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={color.accent} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      >
        <Title sub="When a count disagrees with the book, it is recounted before anything changes.">Your recounts</Title>
        <ErrorText error={error} />
        {tasks && tasks.length === 0 && <Empty title="Nothing to recount">You’re all caught up.</Empty>}
        {tasks?.map((t) => <TaskCard key={t.task_id} task={t} onDone={load} />)}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  sku: { color: color.fg, fontFamily: font.mono, fontSize: font.size.lg, fontWeight: '700' },
  at: { color: color.subtle },
  loc: { color: color.accent, fontFamily: font.mono, fontSize: font.size.lg, fontWeight: '700' },
  reason: { color: color.muted, fontSize: font.size.sm, lineHeight: 20 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xl },
  stepBtn: { width: touch.min + 8, height: touch.min + 8, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: color.raised, borderWidth: 1, borderColor: color.lineStrong },
  value: { color: color.fg, fontFamily: font.mono, fontSize: font.size.xxl, fontWeight: '700', minWidth: 80, textAlign: 'center' },
});
