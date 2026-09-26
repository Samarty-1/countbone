import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Check, ClipboardCheck, Loader2, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import { buzz } from '@/capture/haptics.ts';
import { Button, Card, Notice, Pill, ProgressBar, Screen, SectionTitle, Stat, Swatch, T } from '@/components/ui.tsx';
import { isPending, type LiveRun, type Phase, type RunDetail } from '@/lib/api.ts';
import { DROP_REASONS, duration, pct, runTitle, signed } from '@/lib/format.ts';
import { useFocusedQuery } from '@/lib/hooks.ts';
import { useSettings } from '@/lib/settings.tsx';
import { buildRows, TIER_LABEL, type SkuRow, type Tier } from '@/lib/status.ts';
import { color, space } from '@/theme.ts';

/* ------------------------------------------------------------ processing */

const STEPS: { key: Phase | 'queued'; label: string }[] = [
  { key: 'queued', label: 'Queued' },
  { key: 'frames', label: 'Reading frames' },
  { key: 'count', label: 'Counting' },
  { key: 'output', label: 'Writing results' },
];

function stepIndex(live: LiveRun): number {
  if (live.status === 'queued') return 0;
  const i = STEPS.findIndex((s) => s.key === (live.phase ?? 'frames'));
  return i < 0 ? 1 : i;
}

function Processing({ live }: { live: LiveRun }) {
  const t = live.telemetry;
  const current = stepIndex(live);
  const failed = live.status === 'failed';
  const frameProgress = t?.frames_expected ? t.frames_read / t.frames_expected : null;
  return (
    <>
      <Card>
        <T size="lg" weight="600">
          {failed ? 'Count failed' : 'Counting on the server'}
        </T>
        <T tone="muted" size="sm">
          {failed
            ? (live.error ?? 'The pipeline stopped with an error.')
            : 'You can leave this screen; the count keeps going.'}
        </T>
        <View style={{ gap: space.sm }}>
          <StepRow label="Uploaded" state="done" />
          {STEPS.map((s, i) => (
            <StepRow
              key={s.key}
              label={s.label}
              state={failed && i === current ? 'failed' : i < current ? 'done' : i === current ? 'active' : 'todo'}
            />
          ))}
        </View>
        {!failed && current === 1 ? (
          <View style={{ gap: space.xs }}>
            <ProgressBar value={frameProgress} />
            <T tone="subtle" size="xs" mono>
              {t ? `${t.frames_read}${t.frames_expected ? ` / ${t.frames_expected}` : ''} frames` : 'starting…'}
            </T>
          </View>
        ) : null}
      </Card>
      {t ? (
        <Card>
          <SectionTitle>Live</SectionTitle>
          <View style={styles.stats}>
            <Stat label="kept" value={String(t.frames_kept)} />
            <Stat
              label="dropped"
              value={String(t.frames_dropped)}
              tone={t.frames_dropped > t.frames_kept * 0.3 ? 'warn' : 'fg'}
            />
            <Stat label="detections" value={String(t.detections)} />
            <Stat label="tracks" value={String(t.tracks)} />
          </View>
          <T tone="subtle" size="xs" mono>
            {t.fps.toFixed(1)} fps · {duration(t.elapsed_s)} elapsed
            {t.blur_avg != null ? ` · sharpness ${t.blur_avg.toFixed(0)}` : ''}
          </T>
        </Card>
      ) : null}
      {failed ? <Button label="Home" onPress={() => router.replace('/')} /> : null}
    </>
  );
}

function StepRow({ label, state }: { label: string; state: 'done' | 'active' | 'todo' | 'failed' }) {
  const Icon = state === 'done' ? Check : state === 'failed' ? X : Loader2;
  const tint =
    state === 'done' ? color.ok : state === 'failed' ? color.bad : state === 'active' ? color.accent : color.lineStrong;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <View style={[styles.stepDot, { borderColor: tint }]}>
        {state === 'todo' ? null : <Icon size={12} color={tint} />}
      </View>
      <T tone={state === 'todo' ? 'subtle' : 'fg'} weight={state === 'active' ? '600' : '400'}>
        {label}
      </T>
    </View>
  );
}

/* --------------------------------------------------------------- summary */

const TIER_TONE: Record<Tier, 'ok' | 'warn' | 'bad'> = { high: 'ok', medium: 'warn', review: 'bad' };

function SkuLine({ row }: { row: SkuRow }) {
  const shown = row.reviewedCount ?? row.count;
  const variance = row.expected != null ? shown - row.expected : null;
  return (
    <View style={styles.skuRow}>
      <Swatch hex={row.swatch} size={18} />
      <View style={{ flex: 1, gap: 2 }}>
        <T mono size="sm" numberOfLines={1}>
          {row.sku}
        </T>
        <T tone="subtle" size="xs" numberOfLines={1}>
          {[row.label, row.pending ? `${row.pending} to review` : null].filter(Boolean).join(' · ') || ' '}
        </T>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <T mono size="lg" weight="600">
          {shown}
          {row.reviewedCount != null && row.reviewedCount !== row.count ? (
            <T mono size="xs" tone="subtle">
              {' '}
              (was {row.count})
            </T>
          ) : null}
        </T>
        {row.expected != null ? (
          <T mono size="xs" tone={variance === 0 ? 'ok' : 'warn'}>
            exp {row.expected} · {signed(variance)}
          </T>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Pill label={`${TIER_LABEL[row.tier]} ${pct(row.confidence)}`} tone={TIER_TONE[row.tier]} />
      </View>
    </View>
  );
}

function Summary({ run, rows }: { run: RunDetail; rows: SkuRow[] }) {
  const pending = run.reviews.filter((r) => r.status === 'pending').length;
  const decided = run.reviews.length - pending;
  const q = run.meta.capture_quality;
  const reasons = q ? Object.entries(q.reasons).filter(([, n]) => n > 0) : [];
  const warnings = run.meta.warnings ?? [];
  return (
    <>
      <Card>
        <View style={styles.headline}>
          <View>
            <T mono size="xxl" weight="700">
              {rows.reduce((s, r) => s + (r.reviewedCount ?? r.count), 0)}
            </T>
            <T tone="subtle" size="sm">
              units across {rows.length} SKU{rows.length === 1 ? '' : 's'}
            </T>
          </View>
          <View style={{ alignItems: 'flex-end', gap: space.xs }}>
            <T
              mono
              size="xl"
              weight="600"
              tone={
                TIER_TONE[
                  rows.some((r) => r.tier === 'review') ? 'review' : run.overall_confidence >= 0.85 ? 'high' : 'medium'
                ]
              }
            >
              {pct(run.overall_confidence)}
            </T>
            <T tone="subtle" size="sm">
              confidence
            </T>
          </View>
        </View>
        {pending ? (
          <Button
            variant="primary"
            icon={ClipboardCheck}
            label={`Review ${pending} item${pending === 1 ? '' : 's'}`}
            onPress={() => router.push({ pathname: '/run/[id]/review', params: { id: run.run_id } })}
          />
        ) : run.reviews.length ? (
          <Notice
            tone="ok"
            title="Review complete"
            detail={`${decided} decision${decided === 1 ? '' : 's'} recorded.`}
          />
        ) : run.needs_review ? (
          // Flagged by the run as a whole (e.g. too many frames failed the
          // quality gate), not by any one item, so there is nothing to swipe.
          <Notice
            tone="warn"
            title="Count flagged"
            detail="The footage itself was the problem; see the warnings below. A re-shoot is the fix."
          />
        ) : (
          <Notice tone="ok" title="Nothing needs review" detail="Every SKU cleared the confidence threshold." />
        )}
      </Card>

      <SectionTitle>Counts</SectionTitle>
      <Card style={{ paddingVertical: space.sm, gap: 0 }}>
        {rows.length ? rows.map((r) => <SkuLine key={r.sku} row={r} />) : <T tone="subtle">Nothing was counted.</T>}
      </Card>

      {warnings.length ? (
        <>
          <SectionTitle>Warnings</SectionTitle>
          {warnings.map((w, i) => (
            <Notice key={i} tone="warn" title={w} />
          ))}
        </>
      ) : null}

      <SectionTitle>Capture</SectionTitle>
      <Card>
        <View style={styles.stats}>
          <Stat label="frames used" value={String(run.frames_used)} />
          <Stat label="dropped" value={String(run.frames_dropped)} tone={q && q.drop_rate > 0.3 ? 'warn' : 'fg'} />
          <Stat label="tracks" value={String(run.tracks)} />
          <Stat label="took" value={duration(run.duration_s)} />
        </View>
        {reasons.length ? (
          <T tone="muted" size="sm">
            Dropped as {reasons.map(([k, n]) => `${DROP_REASONS[k] ?? k} ×${n}`).join(', ')}
            {q && q.drop_rate > 0.3 ? ' — film slower or with more light next time.' : '.'}
          </T>
        ) : null}
        {run.meta.source_info ? (
          <T tone="subtle" size="xs" mono>
            {sourceLine(run.meta.source_info)}
          </T>
        ) : null}
      </Card>
    </>
  );
}

/**
 * Browser recordings (MediaRecorder WebM) carry no frame rate or duration in
 * their header, and OpenCV reports its 1 kHz timebase and a sentinel
 * duration for them. Show only what is plausible.
 */
function sourceLine(info: NonNullable<RunDetail['meta']['source_info']>): string {
  const parts = [`${info.width}×${info.height}`];
  if (Number.isFinite(info.fps) && info.fps > 0 && info.fps <= 240) parts.push(`${info.fps.toFixed(0)} fps`);
  if (info.duration_s != null && Number.isFinite(info.duration_s) && info.duration_s > 0 && info.duration_s < 86_400) {
    parts.push(duration(info.duration_s));
  }
  return parts.join(' · ');
}

/* ---------------------------------------------------------------- screen */

export default function RunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, settings } = useSettings();
  const run = useFocusedQuery(
    () => api.run(id),
    `${api.base}|${id}`,
    (d) => (!d || (isPending(d) && d.pending.status !== 'failed') ? 1000 : null),
  );
  const catalog = useFocusedQuery(() => api.catalog(), api.base);
  const health = useFocusedQuery(() => api.health(), api.base);
  const wasPending = useRef(false);

  const detail = run.data && !isPending(run.data) ? run.data : null;
  const rows = useMemo(
    () => (detail ? buildRows(detail.counts, detail.reviews, catalog.data, health.data?.unknown_sku ?? 'UNKNOWN') : []),
    [detail, catalog.data, health.data],
  );

  // The count just finished while the operator watched: tell their hand.
  useEffect(() => {
    if (run.data && isPending(run.data)) wasPending.current = true;
    else if (detail && wasPending.current) {
      wasPending.current = false;
      buzz('success', settings.haptics);
    }
  }, [run.data, detail, settings.haptics]);

  const title = detail
    ? runTitle(detail.run_id, detail.source)
    : run.data && isPending(run.data)
      ? 'Processing'
      : 'Count';

  return (
    <>
      <Stack.Screen options={{ title }} />
      <Screen refreshControl={<RefreshControl refreshing={false} onRefresh={run.reload} tintColor={color.muted} />}>
        {run.error && !run.data ? (
          <Notice
            tone="bad"
            title={run.error.message.includes('unknown run') ? 'Count not found' : 'Could not load this count'}
            detail={run.error.message}
            action={<Button label="Retry" onPress={run.reload} style={{ marginTop: space.sm }} />}
          />
        ) : !run.data ? (
          <T tone="subtle">Loading…</T>
        ) : isPending(run.data) ? (
          <Processing live={run.data.pending} />
        ) : (
          <Summary run={run.data} rows={rows} />
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  stats: { flexDirection: 'row', gap: space.md },
  stepDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  skuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
});
