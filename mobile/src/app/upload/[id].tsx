import { router, useLocalSearchParams } from 'expo-router';
import { CloudUpload, RotateCcw, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { buzz } from '@/capture/haptics.ts';
import { Button, Card, Notice, ProgressBar, Screen, T } from '@/components/ui.tsx';
import type { UploadHandle } from '@/lib/api.ts';
import { bytes, duration } from '@/lib/format.ts';
import { getRecording, hydrateRecordings, removeRecording, type Recording } from '@/lib/recordings.ts';
import { useSettings } from '@/lib/settings.tsx';
import { color, space } from '@/theme.ts';

type State =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'uploading'; progress: number }
  | { phase: 'failed'; message: string };

export default function UploadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, settings } = useSettings();
  const [rec, setRec] = useState<Recording | null>(null);
  const [state, setState] = useState<State>({ phase: 'loading' });
  const handle = useRef<UploadHandle | null>(null);
  const started = useRef(false);

  const start = useCallback(
    (r: Recording) => {
      setState({ phase: 'uploading', progress: 0 });
      const h = api.upload(r.media, (progress) => setState({ phase: 'uploading', progress }));
      handle.current = h;
      h.promise
        .then(({ run_id }) => {
          // Only now is the footage safe on the server.
          removeRecording(r.id);
          buzz('success', settings.haptics);
          router.replace({ pathname: '/run/[id]', params: { id: run_id } });
        })
        .catch((err: unknown) => {
          setState({ phase: 'failed', message: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          handle.current = null;
        });
    },
    [api, settings.haptics],
  );

  useEffect(() => {
    if (started.current || !id) return;
    started.current = true;
    void hydrateRecordings().then(() => {
      const r = getRecording(id);
      if (!r) {
        setState({ phase: 'missing' });
        return;
      }
      setRec(r);
      start(r);
    });
  }, [id, start]);

  useEffect(() => () => handle.current?.cancel(), []);

  const size = rec?.sizeBytes ?? (rec?.media.kind === 'blob' ? rec.media.blob.size : null);

  return (
    <Screen>
      <Card>
        <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
          <CloudUpload size={28} color={state.phase === 'failed' ? color.bad : color.accent} />
          <View style={{ flex: 1 }}>
            <T weight="600" numberOfLines={1}>
              {rec?.media.name ?? 'Recording'}
            </T>
            <T tone="subtle" size="sm">
              {[
                rec?.durationS != null ? duration(rec.durationS) : null,
                size != null ? bytes(size) : null,
                `to ${settings.serverUrl}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </T>
          </View>
        </View>

        {state.phase === 'uploading' || state.phase === 'loading' ? (
          <>
            <ProgressBar value={state.phase === 'uploading' ? state.progress : null} />
            <T tone="muted" size="sm" mono>
              {state.phase === 'uploading'
                ? `${Math.round(state.progress * 100)}%${size != null ? ` · ${bytes(size * state.progress)} of ${bytes(size)}` : ''}`
                : 'Preparing…'}
            </T>
            <Button
              icon={X}
              label="Cancel and keep for later"
              onPress={() => {
                handle.current?.cancel();
                router.replace('/');
              }}
            />
          </>
        ) : null}
      </Card>

      {state.phase === 'failed' && rec ? (
        <>
          <Notice tone="bad" title="Upload failed" detail={`${state.message}. The recording is kept on this device.`} />
          <Button variant="primary" icon={RotateCcw} label="Try again" onPress={() => start(rec)} />
          <Button label="Keep for later" onPress={() => router.replace('/')} />
          <Button
            variant="danger"
            label="Discard recording"
            onPress={() => {
              removeRecording(rec.id);
              router.replace('/');
            }}
          />
        </>
      ) : null}

      {state.phase === 'missing' ? (
        <>
          <Notice
            tone="warn"
            title="Recording not found"
            detail="It was already uploaded, or it was a browser recording and the page has been reloaded since."
          />
          <Button label="Home" onPress={() => router.replace('/')} />
        </>
      ) : null}
    </Screen>
  );
}
