import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Check, Minus, Plus, Undo2, X } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { buzz } from '@/capture/haptics.ts';
import { Button, Notice, Pill, ProgressBar, Screen, Swatch, T } from '@/components/ui.tsx';
import { artifactUrl, isPending, type CatalogEntry, type Review, type ReviewStatus } from '@/lib/api.ts';
import { pct, REASONS } from '@/lib/format.ts';
import { useFocusedQuery } from '@/lib/hooks.ts';
import { useSettings } from '@/lib/settings.tsx';
import { hsvToHex, rankCandidates } from '@/lib/status.ts';
import { CardShadow, SwipeCard, type SwipeDecision } from '@/review/SwipeCard.tsx';
import { color, radius, space, touch } from '@/theme.ts';

/** Whole-SKU reviews first (they move the number most), then least confident. */
function order(reviews: Review[]): Review[] {
  return reviews
    .filter((r) => r.status === 'pending')
    .sort((a, b) => Number(b.meta.scope === 'sku') - Number(a.meta.scope === 'sku') || a.confidence - b.confidence);
}

interface Draft {
  sku: string | null;
  count: number | null;
}

const EMPTY_DRAFT: Draft = { sku: null, count: null };

function ItemBody({
  review,
  catalog,
  unknownSku,
  base,
  draft,
  setDraft,
}: {
  review: Review;
  catalog: CatalogEntry[];
  unknownSku: string;
  base: string;
  draft: Draft;
  setDraft: (d: Draft) => void;
}) {
  const { hue, sat, val } = review.meta;
  const measured = hue != null && sat != null && val != null ? hsvToHex(hue, sat, val) : null;
  const candidates = useMemo(() => rankCandidates(catalog, hue, sat).slice(0, 6), [catalog, hue, sat]);
  const chosen = draft.sku ?? (review.sku === unknownSku ? null : review.sku);
  return (
    <>
      <View style={styles.cropBox}>
        {review.crop_path ? (
          <Image
            source={{ uri: artifactUrl(base, review.run_id, review.crop_path) }}
            style={styles.crop}
            resizeMode="contain"
            accessibilityLabel={`Camera crop flagged as ${review.sku}`}
          />
        ) : (
          <T tone="subtle">No crop saved</T>
        )}
      </View>
      <View style={styles.metaRow}>
        <View style={{ flex: 1, gap: 2 }}>
          <T mono weight="600">
            {review.sku === unknownSku ? 'Unidentified object' : review.sku}
          </T>
          <T tone="subtle" size="sm">
            {REASONS[review.reason] ?? review.reason} · frame {review.frame_index}
          </T>
        </View>
        {measured ? <Swatch hex={measured} size={24} /> : null}
        <Pill label={pct(review.confidence)} tone={review.confidence < 0.4 ? 'bad' : 'warn'} />
      </View>
      <T tone="subtle" size="xs">
        {review.sku === unknownSku
          ? 'Pick what it is, or swipe left if it is not stock'
          : 'Tap another SKU to correct it'}
      </T>
      <View style={styles.chips}>
        {candidates.map((c) => {
          const on = chosen === c.entry.sku;
          return (
            <Pressable
              key={c.entry.sku}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${c.entry.sku} ${c.entry.label}`}
              onPress={() => setDraft({ ...draft, sku: c.entry.sku })}
              style={[styles.chip, on && { borderColor: color.accent, backgroundColor: 'rgba(91,140,255,0.14)' }]}
            >
              <Swatch hex={c.entry.swatch} size={14} />
              <T mono size="sm" tone={on ? 'fg' : 'muted'}>
                {c.entry.sku}
              </T>
              {c.entry.sku === review.sku ? (
                <T size="xs" tone="subtle">
                  model
                </T>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </>
  );
}

function SkuBody({ review, draft, setDraft }: { review: Review; draft: Draft; setDraft: (d: Draft) => void }) {
  const counted = review.meta.count ?? 0;
  const value = draft.count ?? counted;
  const expected = review.meta.expected;
  const step = (d: number) => setDraft({ ...draft, count: Math.max(0, value + d) });
  return (
    <>
      <View style={{ gap: 2 }}>
        <T mono size="lg" weight="600">
          {review.sku}
        </T>
        <T tone="subtle" size="sm">
          {REASONS[review.reason] ?? review.reason} · {pct(review.confidence)} confidence
        </T>
      </View>
      <T tone="muted">
        The camera counted {counted}
        {expected != null ? `, against ${expected} expected` : ''}. Check the shelf and confirm or correct the number.
      </T>
      <View style={styles.stepper}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="One fewer"
          onPress={() => step(-1)}
          style={styles.stepBtn}
        >
          <Minus size={28} color={color.fg} />
        </Pressable>
        <View style={{ alignItems: 'center', minWidth: 96 }}>
          <T mono size="xxl" weight="700" tone={value === counted ? 'fg' : 'warn'}>
            {value}
          </T>
          <T tone="subtle" size="xs">
            {value === counted ? 'as counted' : `was ${counted}`}
          </T>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="One more"
          onPress={() => step(1)}
          style={styles.stepBtn}
        >
          <Plus size={28} color={color.fg} />
        </Pressable>
      </View>
    </>
  );
}

type Decision = { status: Exclude<ReviewStatus, 'pending'>; resolved_sku?: string; resolved_count?: number };

export default function ReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, settings } = useSettings();
  const run = useFocusedQuery(() => api.run(id), `${api.base}|${id}`);
  const catalog = useFocusedQuery(() => api.catalog(), api.base);
  const health = useFocusedQuery(() => api.health(), api.base);
  const unknownSku = health.data?.unknown_sku ?? 'UNKNOWN';

  const [queue, setQueue] = useState<Review[] | null>(null);
  const [total, setTotal] = useState(0);
  const [history, setHistory] = useState<Review[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Per-card state is tagged with the card it belongs to, so a new card
  // starts clean without an effect resetting it.
  const [cardState, setCardState] = useState<{
    id: string | null;
    draft: Draft;
    armed: SwipeDecision | null;
    hint: string | null;
  }>({ id: null, draft: EMPTY_DRAFT, armed: null, hint: null });

  // Seed the queue once (during render, not in an effect); after that it is
  // ours, so a refetch cannot resurrect decided cards.
  if (!queue && run.data && !isPending(run.data)) {
    const q = order(run.data.reviews);
    setQueue(q);
    setTotal(q.length);
  }

  const active = queue?.[0];
  const mine = cardState.id === (active?.review_id ?? null) ? cardState : null;
  const draft = mine?.draft ?? EMPTY_DRAFT;
  const armed = mine?.armed ?? null;
  const hint = mine?.hint ?? null;
  const patchCard = useCallback(
    (patch: Partial<{ draft: Draft; armed: SwipeDecision | null; hint: string | null }>) =>
      setCardState((s) => {
        const id = active?.review_id ?? null;
        const base = s.id === id ? s : { id, draft: EMPTY_DRAFT, armed: null, hint: null };
        return { ...base, ...patch };
      }),
    [active?.review_id],
  );
  const setDraft = useCallback((d: Draft) => patchCard({ draft: d }), [patchCard]);
  const setArmed = (a: SwipeDecision) => patchCard({ armed: a });
  const setHint = (h: string) => patchCard({ hint: h });

  const decisionFor = useCallback(
    (r: Review, d: SwipeDecision): Decision | null => {
      if (d === 'reject') return { status: 'rejected' };
      if (r.meta.scope === 'sku') {
        const counted = r.meta.count ?? 0;
        return draft.count != null && draft.count !== counted
          ? { status: 'corrected', resolved_sku: r.sku, resolved_count: draft.count }
          : { status: 'accepted' };
      }
      if (draft.sku && draft.sku !== r.sku) return { status: 'corrected', resolved_sku: draft.sku };
      if (r.sku === unknownSku) return null; // nothing to approve: pick a SKU or reject
      return { status: 'accepted' };
    },
    [draft, unknownSku],
  );

  const canAccept = !!active && decisionFor(active, 'accept') !== null;

  const onDecide = useCallback(
    (d: SwipeDecision) => {
      if (!active) return;
      const decision = decisionFor(active, d);
      if (!decision) return;
      buzz('tap', settings.haptics);
      // Optimistic: the next card appears now; a failure puts this one back.
      setQueue((q) => q?.slice(1) ?? null);
      setHistory((h) => [active, ...h]);
      setError(null);
      api.resolveReview(active.review_id, decision, settings.reviewer).catch((err: unknown) => {
        setQueue((q) => [active, ...(q ?? [])]);
        setHistory((h) => h.filter((r) => r.review_id !== active.review_id));
        setError(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    [active, decisionFor, api, settings.haptics, settings.reviewer],
  );

  const undo = useCallback(() => {
    const last = history[0];
    if (!last) return;
    setHistory((h) => h.slice(1));
    setQueue((q) => [last, ...(q ?? [])]);
    buzz('tap', settings.haptics);
    api.resolveReview(last.review_id, { status: 'pending' }, settings.reviewer).catch((err: unknown) => {
      setError(`Couldn't undo: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [history, api, settings.haptics, settings.reviewer]);

  const done = total - (queue?.length ?? total);

  return (
    <>
      <Stack.Screen options={{ title: queue ? `Review ${Math.min(done + 1, total)} of ${total}` : 'Review' }} />
      <Screen scroll={!active} contentStyle={{ gap: space.md }}>
        {run.error ? <Notice tone="bad" title="Could not load reviews" detail={run.error.message} /> : null}
        {queue ? <ProgressBar value={total ? done / total : 1} tone="ok" /> : null}
        {error ? <Notice tone="bad" title={error} /> : null}

        {!queue ? (
          <T tone="subtle">Loading…</T>
        ) : active ? (
          <>
            <View style={{ flex: 1, justifyContent: 'center' }}>
              <View style={{ alignSelf: 'center' }}>
                {queue[1] ? <CardShadow /> : null}
                <SwipeCard
                  key={active.review_id}
                  canAccept={canAccept}
                  armed={armed}
                  onDecide={onDecide}
                  onBlocked={() => setHint('Pick a SKU first, or swipe left to reject')}
                >
                  {active.meta.scope === 'sku' ? (
                    <SkuBody review={active} draft={draft} setDraft={setDraft} />
                  ) : (
                    <ItemBody
                      review={active}
                      catalog={catalog.data ?? []}
                      unknownSku={unknownSku}
                      base={api.base}
                      draft={draft}
                      setDraft={setDraft}
                    />
                  )}
                </SwipeCard>
              </View>
            </View>
            {hint ? (
              <T tone="warn" size="sm" style={{ textAlign: 'center' }}>
                {hint}
              </T>
            ) : (
              <T tone="subtle" size="sm" style={{ textAlign: 'center' }}>
                Swipe right to accept · left to reject
              </T>
            )}
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Undo last decision"
                disabled={!history.length}
                onPress={undo}
                style={[styles.round, !history.length && { opacity: 0.3 }]}
              >
                <Undo2 size={22} color={color.fg} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Reject"
                onPress={() => setArmed('reject')}
                style={[styles.round, styles.big, { borderColor: color.bad }]}
              >
                <X size={34} color={color.bad} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={active.meta.scope === 'sku' ? 'Confirm count' : 'Accept'}
                accessibilityState={{ disabled: !canAccept }}
                onPress={() => (canAccept ? setArmed('accept') : setHint('Pick a SKU first, or reject'))}
                style={[styles.round, styles.big, { borderColor: canAccept ? color.ok : color.lineStrong }]}
              >
                <Check size={34} color={canAccept ? color.ok : color.subtle} />
              </Pressable>
              {/* Balances the undo button so the two decisions stay centred. */}
              <View style={[styles.round, { borderWidth: 0 }]} />
            </View>
          </>
        ) : (
          <>
            <Notice
              tone="ok"
              title={total ? 'All reviewed' : 'Nothing to review'}
              detail={total ? `${total} decision${total === 1 ? '' : 's'} saved to the audit trail.` : undefined}
            />
            {history.length ? <Button icon={Undo2} label="Undo last" onPress={undo} /> : null}
            <Button variant="primary" label="Back to the count" onPress={() => router.back()} />
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  cropBox: {
    height: 220,
    borderRadius: radius.md,
    backgroundColor: color.bg,
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  crop: { width: '100%', height: '100%' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.lineStrong,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xl,
    paddingVertical: space.md,
  },
  stepBtn: {
    width: touch.primary - 20,
    height: touch.primary - 20,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.lineStrong,
    backgroundColor: color.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.xl,
    paddingBottom: space.md,
  },
  round: {
    width: touch.min,
    height: touch.min,
    borderRadius: touch.min / 2,
    borderWidth: 1,
    borderColor: color.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  big: { width: touch.primary - 8, height: touch.primary - 8, borderRadius: (touch.primary - 8) / 2, borderWidth: 2 },
});
