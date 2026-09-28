import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { api } from '@/api/client';
import { Badge, Button, Card, Row, Screen, SectionLabel, Title } from '@/components/ui';
import { useSession } from '@/state/session';
import { color, font } from '@/theme';

export default function Settings() {
  const { user, server, signOut } = useSession();
  const [health, setHealth] = useState<{ ok: boolean; detail: string } | null>(null);

  useEffect(() => {
    api
      .health()
      .then((h) => setHealth({ ok: true, detail: `server ${h.version} · identifies by ${h.identify}` }))
      .catch(() => setHealth({ ok: false, detail: 'cannot reach the server right now' }));
  }, []);

  return (
    <Screen>
      <Title>Settings</Title>
      <Card>
        <SectionLabel>Account</SectionLabel>
        <Row title={user?.display_name ?? '—'} sub={`${user?.username ?? ''} · ${user?.role ?? ''}`} />
        <Button label="Sign out" variant="danger" onPress={() => void signOut()} />
      </Card>
      <Card>
        <SectionLabel>Server</SectionLabel>
        <Row title={server} sub={health?.detail ?? 'checking…'} right={health ? <Badge label={health.ok ? 'online' : 'offline'} tone={health.ok ? 'ok' : 'warn'} /> : undefined} />
        <Text style={{ color: color.subtle, fontSize: font.size.xs }}>To use another server, sign out and enter its address on the sign-in screen.</Text>
      </Card>
      <Card>
        <SectionLabel>Filming well</SectionLabel>
        <Text style={{ color: color.muted, fontSize: font.size.sm, lineHeight: 20 }}>
          Film one bay per video, starting on its label. Keep the whole bay height in the frame, walk at an even pace,
          and don’t walk back over what you’ve filmed. If the screen says slow down, slow down: a count from a rushed
          video is flagged, not trusted.
        </Text>
      </Card>
      <Text style={{ color: color.subtle, fontSize: font.size.xs, textAlign: 'center' }}>
        countbone {Constants.expoConfig?.version ?? ''}
      </Text>
    </Screen>
  );
}
