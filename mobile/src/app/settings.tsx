import Constants from 'expo-constants';
import { Plug } from 'lucide-react-native';
import { useState } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';

import { Button, Card, Notice, Screen, SectionTitle, T, ToggleRow } from '@/components/ui.tsx';
import { createApi, type Health } from '@/lib/api.ts';
import { normaliseServerUrl, useSettings } from '@/lib/settings.tsx';
import { color, font, radius, space, touch } from '@/theme.ts';

type Check =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'ok'; health: Health }
  | { state: 'bad'; message: string };

export default function SettingsScreen() {
  const { loaded } = useSettings();
  // The form seeds its inputs from stored settings once, so wait for them.
  return loaded ? <SettingsForm /> : <Screen>{null}</Screen>;
}

function SettingsForm() {
  const { settings, update } = useSettings();
  const [url, setUrl] = useState(settings.serverUrl);
  const [reviewer, setReviewer] = useState(settings.reviewer);
  const [check, setCheck] = useState<Check>({ state: 'idle' });

  const normalised = normaliseServerUrl(url);

  const test = async () => {
    if (!normalised) {
      setCheck({ state: 'bad', message: 'Enter an address like 192.168.1.20:8000' });
      return;
    }
    setCheck({ state: 'checking' });
    try {
      const health = await createApi(normalised).health();
      setCheck({ state: 'ok', health });
      update({ serverUrl: normalised });
    } catch (err) {
      setCheck({ state: 'bad', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <Screen>
      <SectionTitle>Server</SectionTitle>
      <Card>
        <T tone="muted" size="sm">
          The machine running{' '}
          <T mono size="sm">
            countbone serve
          </T>
          . A phone needs its network address, not localhost.
          {Platform.OS === 'web'
            ? ' The browser preview needs the server started with --allow-origin for this page.'
            : ''}
        </T>
        <TextInput
          value={url}
          onChangeText={(t) => {
            setUrl(t);
            setCheck({ state: 'idle' });
          }}
          onSubmitEditing={() => void test()}
          placeholder="http://192.168.1.20:8000"
          placeholderTextColor={color.subtle}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          inputMode="url"
          accessibilityLabel="Server address"
          style={styles.input}
        />
        <Button
          icon={Plug}
          variant="primary"
          label="Test and save"
          busy={check.state === 'checking'}
          onPress={() => void test()}
        />
        {check.state === 'ok' ? (
          <Notice
            tone="ok"
            title="Connected"
            detail={`Detector ${check.health.detect}, identifier ${check.health.identify}, counting by ${check.health.count}. ${check.health.plugins.length} plugins.`}
          />
        ) : check.state === 'bad' ? (
          <Notice tone="bad" title="Not reachable" detail={check.message} />
        ) : null}
      </Card>

      <SectionTitle>While filming</SectionTitle>
      <Card style={{ gap: 0 }}>
        <ToggleRow
          label="Vibration"
          detail="Buzz on record, and when a problem appears mid-take"
          value={settings.haptics}
          onChange={(v) => update({ haptics: v })}
        />
        <ToggleRow
          label="Framing grid"
          detail="Thirds and the shelf band"
          value={settings.grid}
          onChange={(v) => update({ grid: v })}
        />
        <ToggleRow
          label="Object outlines"
          detail="A preview of what the detector may see"
          value={settings.outlines}
          onChange={(v) => update({ outlines: v })}
        />
        <ToggleRow
          label="Stats readout"
          detail="Frame rate, sharpness, light and pace"
          value={settings.stats}
          onChange={(v) => update({ stats: v })}
        />
        <ToggleRow
          label="Record audio"
          detail="Not needed to count; off keeps aisle conversations out of the footage"
          value={settings.audio}
          onChange={(v) => update({ audio: v })}
        />
      </Card>

      <SectionTitle>Review</SectionTitle>
      <Card>
        <T tone="muted" size="sm">
          Your name on review decisions in the audit trail.
        </T>
        <TextInput
          value={reviewer}
          onChangeText={setReviewer}
          onBlur={() => update({ reviewer })}
          onSubmitEditing={() => update({ reviewer })}
          placeholder="mobile"
          placeholderTextColor={color.subtle}
          autoCapitalize="words"
          accessibilityLabel="Reviewer name"
          style={styles.input}
        />
      </Card>

      <View style={{ alignItems: 'center', paddingVertical: space.md }}>
        <T tone="subtle" size="xs" mono>
          Countbone {Constants.expoConfig?.version ?? ''} · {Platform.OS}
        </T>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: touch.min,
    borderWidth: 1,
    borderColor: color.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    color: color.fg,
    backgroundColor: color.bg,
    fontFamily: font.mono,
    fontSize: font.size.md,
  },
});
