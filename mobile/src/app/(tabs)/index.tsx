import { useFocusEffect, useRouter } from 'expo-router';
import { Camera, Footprints, MapPin, QrCode, Truck, Undo2 } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { api, type Location, type Receipt, type ServiceJob, type Task } from '@/api/client';
import type { Target } from '@/api/uploadQueue';
import { Badge, Button, Card, Empty, ErrorText, Field, Row, Screen, SectionLabel, Title } from '@/components/ui';
import { useSession } from '@/state/session';
import { color, font, radius, space, touch } from '@/theme';

type Kind = Target['kind'];

const KINDS: { kind: Kind; label: string; icon: typeof Camera }[] = [
  { kind: 'count', label: 'Bay', icon: MapPin },
  { kind: 'receive', label: 'Delivery', icon: Truck },
  { kind: 'recount', label: 'Recount', icon: Undo2 },
];

export default function CaptureHome() {
  const router = useRouter();
  const { user, target, setTarget } = useSession();
  const [locations, setLocations] = useState<Location[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [jobs, setJobs] = useState<ServiceJob[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [offline, setOffline] = useState(false);
  const [walkBusy, setWalkBusy] = useState(false);
  // Deliveries only where the site has Receive switched on (the server
  // refuses them otherwise). Off until known, so nothing offers it wrongly.
  const [receiveOn, setReceiveOn] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      Promise.all([api.locations(), api.settings(), api.tasks(true), api.serviceJobs()])
        .then(async ([l, s, t, j]) => {
          const r = s.modules.receive ? await api.receipts() : [];
          if (!alive) return;
          setReceiveOn(s.modules.receive);
          setLocations(l);
          setReceipts(r.filter((x) => x.status !== 'closed'));
          setTasks(t);
          setJobs(j.filter((x) => x.status === 'planned' || x.status === 'in_progress'));
          setOffline(false);
        })
        .catch(() => alive && setOffline(true));
      return () => {
        alive = false;
      };
    }, []),
  );

  const set = (patch: Partial<Target>) => setTarget({ ...target, ...patch });
  const pickKind = (kind: Kind) =>
    setTarget({ ...target, kind, receipt_id: null, task_id: null, title: kind === 'count' ? 'Cycle count' : kind === 'receive' ? 'Delivery' : 'Recount' });

  const ready =
    target.kind === 'receive' ? !!target.receipt_id : target.kind === 'recount' ? !!target.task_id : true;
  const shown = locations.filter((l) => !filter || `${l.code} ${l.name ?? ''}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 8);

  return (
    <Screen>
      <Title sub={`Signed in as ${user?.display_name ?? ''}`}>What are you filming?</Title>
      {offline && (
        <Card style={{ borderColor: color.warn + '66' }}>
          <Text style={{ color: color.warn, fontWeight: '700' }}>No connection to the server</Text>
          <Text style={{ color: color.muted }}>You can still record: videos wait in Uploads and send themselves when you are back online.</Text>
        </Card>
      )}

      <View style={styles.kinds} accessibilityRole="radiogroup">
        {KINDS.filter(({ kind }) => kind !== 'receive' || receiveOn || target.kind === 'receive').map(({ kind, label, icon: Icon }) => {
          const on = target.kind === kind;
          return (
            <Pressable
              key={kind}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => pickKind(kind)}
              style={[styles.kind, on && styles.kindOn]}
            >
              <Icon color={on ? color.accent : color.muted} size={22} />
              <Text style={[styles.kindText, on && { color: color.fg }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      {target.kind === 'count' && (
        <Card>
          <SectionLabel>Bay</SectionLabel>
          {target.location ? (
            <Row
              title={target.location}
              sub={locations.find((l) => l.code === target.location)?.name ?? 'Selected'}
              right={<Button label="Change" variant="ghost" onPress={() => set({ location: null, walk_id: null, title: 'Cycle count' })} />}
            />
          ) : (
            <>
              <Button
                label="Scan the bay's label"
                variant="primary"
                big
                icon={<QrCode color={color.accentFg} size={22} />}
                onPress={() => router.push('/scan')}
              />
              <Text style={styles.or}>or choose it</Text>
              <Field label="Find a bay" value={filter} onChangeText={setFilter} placeholder="A07-B03" autoCapitalize="characters" />
              {shown.map((l) => (
                <Row
                  key={l.code}
                  title={l.code}
                  sub={l.name ?? undefined}
                  onPress={() => set({ location: l.code, title: `${l.code} · cycle count` })}
                />
              ))}
              <Text style={styles.hint}>Not sure? Film the label at the start of the video: the bay is read from it.</Text>
            </>
          )}
          {target.location && (
            <Row
              title={target.walk_id ? 'Part of a walk' : 'One video covers this bay'}
              sub={target.walk_id ? 'Film the rest now: overlaps are counted once.' : 'Needs more than one video? Start a walk.'}
              right={
                target.walk_id ? (
                  <Badge label="walk" tone="accent" />
                ) : (
                  <Button
                    label="Start walk"
                    variant="secondary"
                    busy={walkBusy}
                    icon={<Footprints color={color.fg} size={18} />}
                    onPress={async () => {
                      setWalkBusy(true);
                      try {
                        const w = await api.createWalk(target.location);
                        set({ walk_id: w.walk_id });
                      } catch (e) {
                        setError(e);
                      } finally {
                        setWalkBusy(false);
                      }
                    }}
                  />
                )
              }
            />
          )}
        </Card>
      )}

      {target.kind === 'receive' && (
        <Card>
          <SectionLabel>Which delivery</SectionLabel>
          {receipts.length === 0 ? (
            <Empty title="No open deliveries">A manager creates a receipt from the purchase order first.</Empty>
          ) : (
            receipts.map((r) => (
              <Row
                key={r.receipt_id}
                title={`PO ${r.po_number}`}
                sub={`${r.supplier ?? 'Unknown supplier'}${r.dock ? ` · dock ${r.dock}` : ''} · ${r.expected_units ?? '?'} units ordered`}
                right={target.receipt_id === r.receipt_id ? <Badge label="selected" tone="accent" /> : undefined}
                onPress={() => set({ receipt_id: r.receipt_id, title: `PO ${r.po_number} · delivery` })}
              />
            ))
          )}
        </Card>
      )}

      {target.kind === 'recount' && (
        <Card>
          <SectionLabel>Your recounts</SectionLabel>
          {tasks.length === 0 ? (
            <Empty title="Nothing to recount" />
          ) : (
            tasks.map((t) => (
              <Row
                key={t.task_id}
                title={`${t.sku} at ${t.location}`}
                sub={t.reason ?? undefined}
                right={target.task_id === t.task_id ? <Badge label="selected" tone="accent" /> : undefined}
                onPress={() => set({ task_id: t.task_id, location: t.location, title: `${t.location} · recount ${t.sku}` })}
              />
            ))
          )}
        </Card>
      )}

      {jobs.length > 0 && (
        <Card>
          <SectionLabel>Service job</SectionLabel>
          {jobs.map((j) => (
            <Row
              key={j.job_id}
              title={j.title}
              sub={j.site_name ?? undefined}
              right={target.job_id === j.job_id ? <Badge label="on" tone="accent" /> : undefined}
              onPress={() => set({ job_id: target.job_id === j.job_id ? null : j.job_id })}
            />
          ))}
        </Card>
      )}

      <ErrorText error={error} />
      <Button
        label="Open camera"
        variant="primary"
        big
        disabled={!ready}
        icon={<Camera color={color.accentFg} size={22} />}
        onPress={() => router.push('/capture')}
      />
      <Text style={styles.hint}>
        Hold the phone upright, a steady arm’s length from the shelf, and walk at an even pace. The screen tells you if
        anything needs changing.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  kinds: { flexDirection: 'row', gap: space.sm },
  kind: {
    flex: 1,
    minHeight: touch.min + 16,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  kindOn: { borderColor: color.accent, backgroundColor: color.accent + '14' },
  kindText: { color: color.muted, fontWeight: '600', fontSize: font.size.sm },
  or: { color: color.subtle, textAlign: 'center', fontSize: font.size.sm },
  hint: { color: color.subtle, fontSize: font.size.xs, lineHeight: 17 },
});
