import { RefreshControl } from 'react-native';

import { LiveRow, RunRow } from '@/components/RunRow.tsx';
import { UnsentRow } from '@/components/UnsentRow.tsx';
import { Card, Notice, Screen, SectionTitle, T } from '@/components/ui.tsx';
import { useFocusedQuery, useRecordings } from '@/lib/hooks.ts';
import { useSettings } from '@/lib/settings.tsx';
import { color } from '@/theme.ts';

export default function HistoryScreen() {
  const { api } = useSettings();
  const recordings = useRecordings();
  const runs = useFocusedQuery(
    () => api.runs(100),
    api.base,
    (d) => (d?.inFlight.some((r) => r.status === 'queued' || r.status === 'running') ? 2000 : null),
  );
  const stored = new Set(runs.data?.runs.map((r) => r.run_id));
  // In flight, or failed before the store ever saw them (the tracker is memory-only).
  const live = runs.data?.inFlight.filter((r) => !stored.has(r.run_id) && r.status !== 'done') ?? [];
  const needsReview = runs.data?.runs.filter((r) => r.needs_review).length ?? 0;

  return (
    <Screen refreshControl={<RefreshControl refreshing={false} onRefresh={runs.reload} tintColor={color.muted} />}>
      {runs.error ? <Notice tone="bad" title="Could not load history" detail={runs.error.message} /> : null}

      {recordings.length ? (
        <Card>
          <SectionTitle>On this device, not uploaded</SectionTitle>
          {recordings.map((r) => (
            <UnsentRow key={r.id} recording={r} />
          ))}
        </Card>
      ) : null}

      {live.length ? (
        <Card>
          <SectionTitle>On the server, in progress</SectionTitle>
          {live.map((r) => (
            <LiveRow key={r.run_id} run={r} />
          ))}
        </Card>
      ) : null}

      <Card>
        <SectionTitle
          right={
            needsReview ? (
              <T tone="warn" size="xs">
                {needsReview} need review
              </T>
            ) : null
          }
        >
          Counts
        </SectionTitle>
        {runs.data?.runs.length ? (
          runs.data.runs.map((r) => <RunRow key={r.run_id} run={r} />)
        ) : (
          <T tone="subtle">{runs.loading ? 'Loading…' : 'No counts on this server yet.'}</T>
        )}
      </Card>
    </Screen>
  );
}
