/**
 * Check what the counter was unsure about, one card at a time, on the spot.
 * Swipe right = right as it is, left = not a real item; or pick the right
 * product. A whole-product question gets a stepper for the recount.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Minus, Plus } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, isPending, type CatalogEntry, type Review, type RunDetail } from '@/api/client';
import { AuthedImage } from '@/components/AuthedImage';
import { SwipeCard, type Swipe } from '@/components/review/SwipeCard';
import { Badge, Button, Empty, ErrorText, Screen, Title } from '@/components/ui';
import { color, font, radius, space, touch } from '@/theme';

const REASONS: Record<string, string> = {
  low_sku_confidence: 'Unsure about this product’s total',
  low_item_confidence: 'Unsure what this is',
  unidentified: 'Not matched to any product',
  possible_missed_item: 'Seen clearly, but only once: not counted yet',
};

export default function ReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [index, setIndex] = useState(0);
  // Per-question state, keyed by the review it belongs to: moving to the
  // next card starts fresh without an effect resetting it.
  const [picked, setPicked] = useState<{ id: string; sku: string } | null>(null);
  const [counted, setCounted] = useState<{ id: string; n: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [decided, setDecided] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([api.run(id!), api.catalog()])
      .then(([r, c]) => {
        if (!alive) return;
        if (!isPending(r)) setRun(r);
        setCatalog(c);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [id]);

  const queue = useMemo(() => (run?.reviews ?? []).filter((r) => r.status === 'pending'), [run]);
  const active: Review | undefined = queue[index];
  const isSku = active?.meta.scope === 'sku';
  const miss = active?.reason === 'possible_missed_item';
  // An object nobody could name needs a name before it can be confirmed.
  const unnamed = !isSku && active?.sku === 'UNKNOWN';

  const choice = picked && active && picked.id === active.review_id ? picked.sku : null;
  const recount = counted && active && counted.id === active.review_id ? counted.n : (active?.meta.count ?? 0);
  const setChoice = (sku: string) => active && setPicked({ id: active.review_id, sku });
  const setRecount = (f: (n: number) => number) => active && setCounted({ id: active.review_id, n: f(recount) });

  const decide = async (status: Review['status'], extra: { resolved_sku?: string; resolved_count?: number } = {}) => {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      await api.resolveReview(active.review_id, { status, ...extra });
      setDecided((n) => n + 1);
      setIndex((i) => i + 1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const accept = () => {
    if (isSku) {
      const changed = recount !== (active!.meta.count ?? 0);
      return changed ? decide('corrected', { resolved_sku: active!.sku, resolved_count: recount }) : decide('accepted');
    }
    if (choice && choice !== active!.sku) return decide('corrected', { resolved_sku: choice });
    if (unnamed) {
      setError('Pick the product first, or choose "Not stock".');
      return;
    }
    return decide('accepted');
  };

  const onSwipe = (s: Swipe) => (s === 'accept' ? accept() : decide('rejected'));

  // Candidates: the model's own ranking when it identified by photo, then the rest.
  const candidates = useMemo(() => {
    if (!active) return [];
    const ranked = (active.meta.candidates ?? []).map((c) => c.sku);
    const rest = catalog.map((c) => c.sku).filter((s) => !ranked.includes(s));
    return [...ranked, ...rest].slice(0, 8);
  }, [active, catalog]);

  if (!run) {
    return (
      <Screen>
        <Title>Loading…</Title>
        <ErrorText error={error} />
      </Screen>
    );
  }

  if (!active) {
    return (
      <Screen>
        <Title sub={`${decided} decision${decided === 1 ? '' : 's'} saved`}>All checked</Title>
        <Empty title="Nothing left to check">The count is final once every item is checked.</Empty>
        <Button label="See the result" variant="primary" big onPress={() => router.replace({ pathname: '/run/[id]', params: { id: run.run_id } })} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title sub={`${index + 1} of ${queue.length} · ${run.location ?? 'no bay'}`}>Check this</Title>
      <SwipeCard key={active.review_id} onSwipe={onSwipe} acceptLabel={miss ? 'ADD' : 'RIGHT'} rejectLabel="NOT STOCK">
        <Badge label={REASONS[active.reason] ?? active.reason} tone={miss ? 'accent' : 'warn'} />
        {active.crop_path ? (
          <AuthedImage
            path={`/api/runs/${run.run_id}/artifacts/${active.crop_path.replace(/\\/g, '/')}`}
            style={styles.crop}
            label="What the camera saw"
          />
        ) : null}
        <Text style={styles.question}>
          {isSku
            ? `The video counted ${active.meta.count ?? '?'} of ${active.sku}. Is that right?`
            : unnamed
              ? 'What is this? Pick the product, or “Not stock”.'
              : miss
                ? `Is this a real ${active.sku}? Swipe right to add it to the count.`
                : `Counted as ${active.sku}. Right?`}
        </Text>
        {isSku ? (
          <View style={styles.stepper}>
            <Pressable accessibilityRole="button" accessibilityLabel="One fewer" onPress={() => setRecount((n) => Math.max(0, n - 1))} style={styles.stepBtn}>
              <Minus color={color.fg} size={24} />
            </Pressable>
            <Text style={styles.stepValue} accessibilityLabel={`Recount ${recount}`}>{recount}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="One more" onPress={() => setRecount((n) => n + 1)} style={styles.stepBtn}>
              <Plus color={color.fg} size={24} />
            </Pressable>
          </View>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            {candidates.map((sku) => {
              const on = (choice ?? active.sku) === sku;
              const entry = catalog.find((c) => c.sku === sku);
              return (
                <Pressable
                  key={sku}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => setChoice(sku)}
                  style={[styles.chip, on && styles.chipOn]}
                >
                  {entry?.swatch ? <View style={[styles.swatch, { backgroundColor: entry.swatch }]} /> : null}
                  <Text style={[styles.chipText, on && { color: color.fg }]}>{sku}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </SwipeCard>
      <ErrorText error={error} />
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button label="Not stock" variant="danger" big busy={busy} onPress={() => void decide('rejected')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            label={isSku ? (recount !== (active.meta.count ?? 0) ? `Save ${recount}` : 'Right') : choice && choice !== active.sku ? `It's ${choice}` : miss ? 'Add it' : 'Right'}
            variant="success"
            big
            busy={busy}
            disabled={unnamed && !choice}
            onPress={() => void accept()}
          />
        </View>
      </View>
      <Button label="Skip for now" variant="ghost" onPress={() => setIndex((i) => i + 1)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  crop: { width: '100%', height: 220, borderRadius: radius.md, backgroundColor: '#000' },
  question: { color: color.fg, fontSize: font.size.lg, fontWeight: '700', lineHeight: 24 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xl },
  stepBtn: { width: touch.min + 8, height: touch.min + 8, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: color.raised, borderWidth: 1, borderColor: color.lineStrong },
  stepValue: { color: color.fg, fontFamily: font.mono, fontSize: font.size.xxl, fontWeight: '700', minWidth: 80, textAlign: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: touch.min, paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1, borderColor: color.line, backgroundColor: color.bg },
  chipOn: { borderColor: color.accent, backgroundColor: color.accent + '1f' },
  chipText: { color: color.muted, fontFamily: font.mono, fontSize: font.size.sm },
  swatch: { width: 14, height: 14, borderRadius: 3 },
});
