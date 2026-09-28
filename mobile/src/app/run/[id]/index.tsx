/**
 * After filming: upload, counting, then the summary.
 *
 * The id is either a recording (rec_…, still on the phone or uploading) or
 * a run (run_…, on the server). A recording's screen follows it through the
 * queue and turns into the run's screen when the server has it.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CheckCircle2, ClipboardCheck, CloudOff, Loader, TriangleAlert } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { api, isPending, type RunResponse } from '@/api/client';
import { retry } from '@/api/uploadQueue';
import { Badge, Button, Card, ErrorText, Mono, Screen, SectionLabel, Title } from '@/components/ui';
import { useQueue } from '@/state/useQueue';
import { color, font, radius, space } from '@/theme';

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

function Progress({ fraction, label }: { fraction: number | null; label: string }) {
  return (
    <View style={{ gap: space.sm }}>
      <Text style={styles.progressLabel}>{label}</Text>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.round((fraction ?? 0.05) * 100)}%` }]} />
      </View>
    </View>
  );
}

export default function RunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queue = useQueue();
  const item = id?.startsWith('rec_') ? queue.find((q) => q.id === id) : undefined;
  const runId = id?.startsWith('run_') ? id : item?.runId ?? null;
  const [run, setRun] = useState<RunResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api.run(runId);
        if (!alive) return;
        setRun(r);
        setError(null);
        if (isPending(r) && r.pending.status !== 'failed') timer = setTimeout(poll, 1000);
      } catch (e) {
        if (!alive) return;
        setError(e);
        timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [runId]);

  // -- still on the phone -------------------------------------------------------
  if (!runId) {
    if (!item) {
      return (
        <Screen>
          <Title>Recording not found</Title>
          <Button label="Back" onPress={() => router.replace('/')} />
        </Screen>
      );
    }
    const frac = item.recording.size ? item.sent / item.recording.size : 0;
    return (
      <Screen>
        <Title sub={item.target.title}>{item.state === 'failed' ? 'Upload refused' : 'Sending the video'}</Title>
        <Card>
          {item.state === 'uploading' && <Progress fraction={frac} label={`Uploading… ${pct(frac)}`} />}
          {item.state === 'waiting' && (
            <View style={styles.inline}>
              <CloudOff color={color.warn} size={22} />
              <Text style={styles.body}>
                {item.error
                  ? `Waiting for a connection (${item.error}). It sends itself when the server can be reached.`
                  : 'Queued. It sends itself as soon as there is a connection.'}
              </Text>
            </View>
          )}
          {item.state === 'failed' && (
            <>
              <ErrorText error={item.error} />
              <Button label="Try again" variant="primary" onPress={() => void retry(item.id)} />
            </>
          )}
          <Text style={styles.hint}>You can close this screen and keep counting: uploads carry on in the background.</Text>
        </Card>
        <Button label="Count the next bay" variant="primary" big onPress={() => router.replace('/')} />
      </Screen>
    );
  }

  // -- on the server ------------------------------------------------------------
  if (!run || isPending(run)) {
    const live = run && isPending(run) ? run.pending : null;
    const t = live?.telemetry;
    const frac = t?.frames_expected ? Math.min(1, t.frames_read / t.frames_expected) : null;
    return (
      <Screen>
        <Title sub={item?.target.title}>{live?.status === 'failed' ? 'Counting failed' : 'Counting'}</Title>
        <Card>
          {live?.status === 'failed' ? (
            <ErrorText error={live.error} />
          ) : (
            <>
              <Progress
                fraction={frac}
                label={live?.status === 'queued' ? 'In the queue…' : `Reading frames${frac != null ? ` ${pct(frac)}` : '…'}`}
              />
              {t && <Text style={styles.hint}>{t.tracks} objects tracked so far</Text>}
            </>
          )}
          <ErrorText error={error} />
        </Card>
        <Button label="Count the next bay" variant="secondary" onPress={() => router.replace('/')} />
      </Screen>
    );
  }

  const r = run;
  const pending = r.reviews.filter((x) => x.status === 'pending').length;
  const mismatches = r.final.rows.filter((x) => x.variance != null && x.variance !== 0);
  const hasBook = r.final.rows.some((x) => x.expected != null);
  const warnings = r.meta.warnings ?? [];

  return (
    <Screen>
      <Animated.View entering={FadeIn.duration(250)} style={{ gap: space.lg }}>
        <Title sub={[r.location ?? 'No bay', r.kind === 'receive' ? 'delivery' : r.kind === 'recount' ? 'recount' : 'cycle count'].join(' · ')}>
          Counted {r.final.total}
        </Title>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {r.final.settled ? <Badge label="final" tone="ok" /> : <Badge label={`${pending} to check`} tone="warn" />}
          {hasBook && (mismatches.length ? <Badge label={`${mismatches.length} differ from the book`} tone="bad" /> : <Badge label="matches the book" tone="ok" />)}
          <Badge label={`confidence ${pct(r.overall_confidence)}`} tone={r.overall_confidence >= 0.85 ? 'ok' : 'warn'} />
          {r.meta.shelf?.missing_facings ? <Badge label={`${r.meta.shelf.missing_facings} empty facings`} tone="warn" /> : null}
        </View>

        {pending > 0 && (
          <Button
            label={`Check ${pending} item${pending > 1 ? 's' : ''}`}
            variant="primary"
            big
            icon={<ClipboardCheck color={color.accentFg} size={22} />}
            onPress={() => router.push({ pathname: '/run/[id]/review', params: { id: r.run_id } })}
          />
        )}

        <Card>
          <SectionLabel>By product</SectionLabel>
          {r.final.rows.map((row) => {
            const v = row.variance;
            const tone = v == null ? color.muted : v === 0 ? color.ok : v < 0 ? color.bad : color.warn;
            return (
              <View key={row.sku} style={styles.row} accessibilityLabel={`${row.label}: ${row.final}${row.expected != null ? `, book ${row.expected}` : ''}`}>
                <View style={{ flex: 1 }}>
                  <Mono style={{ fontWeight: '700' }}>{row.sku === 'UNKNOWN' ? 'Not recognised' : row.sku}</Mono>
                  <Text style={styles.hint} numberOfLines={1}>
                    {row.sku === 'UNKNOWN' ? 'Check them: each needs a product or "not stock"' : row.label}
                  </Text>
                </View>
                <Text style={styles.count}>{row.final}</Text>
                <View style={[styles.var, { borderColor: tone }]}>
                  <Text style={[styles.varText, { color: tone }]}>
                    {v == null ? '—' : v === 0 ? '✓' : v > 0 ? `+${v}` : String(v)}
                  </Text>
                </View>
              </View>
            );
          })}
        </Card>

        {warnings.length > 0 && (
          <Card style={{ borderColor: color.warn + '55' }}>
            <View style={styles.inline}>
              <TriangleAlert color={color.warn} size={18} />
              <SectionLabel>Worth knowing</SectionLabel>
            </View>
            {warnings.map((w) => (
              <Text key={w} style={styles.body}>• {w}</Text>
            ))}
          </Card>
        )}

        {mismatches.length > 0 && r.kind === 'count' && (
          <Text style={styles.hint}>Differences from the book become recount tasks; you’ll find yours under Recounts.</Text>
        )}

        <Button label="Count the next bay" variant={pending ? 'secondary' : 'primary'} big icon={<CheckCircle2 color={pending ? color.fg : color.accentFg} size={20} />} onPress={() => router.replace('/')} />
        <Text style={[styles.hint, { textAlign: 'center' }]}>
          <Loader size={10} color={color.subtle} /> {r.run_id}
        </Text>
      </Animated.View>
      {!run && <ActivityIndicator />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  progressLabel: { color: color.fg, fontSize: font.size.md, fontWeight: '600' },
  track: { height: 8, borderRadius: radius.pill, backgroundColor: color.line, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: color.accent },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  body: { color: color.fg, fontSize: font.size.sm, lineHeight: 20, flexShrink: 1 },
  hint: { color: color.subtle, fontSize: font.size.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 48, borderBottomColor: color.line, borderBottomWidth: StyleSheet.hairlineWidth },
  count: { color: color.fg, fontFamily: font.mono, fontSize: font.size.xl, fontWeight: '700', minWidth: 44, textAlign: 'right' },
  var: { minWidth: 48, height: 30, borderRadius: radius.pill, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  varText: { fontFamily: font.mono, fontWeight: '700', fontSize: font.size.sm },
});
