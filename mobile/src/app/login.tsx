import { ScanLine } from 'lucide-react-native';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';

import { Button, Card, ErrorText, Field, Screen } from '@/components/ui';
import { useSession } from '@/state/session';
import { color, font, space } from '@/theme';

export default function Login() {
  const { server: savedServer, signIn } = useSession();
  const [server, setServer] = useState(savedServer);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(server, username.trim(), password);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ gap: space.xl }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xxl }}>
          <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: color.accent + '26', alignItems: 'center', justifyContent: 'center' }}>
            <ScanLine color={color.accent} size={24} />
          </View>
          <View>
            <Text style={{ color: color.fg, fontSize: font.size.xl, fontWeight: '800' }}>countbone</Text>
            <Text style={{ color: color.muted, fontSize: font.size.sm }}>Film the shelf. Get the count.</Text>
          </View>
        </View>
        <Card>
          <Field
            label="Server"
            value={server}
            onChangeText={setServer}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            hint="The address your admin gave you, e.g. https://counts.acme.com"
          />
          <Field label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} textContentType="username" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" onSubmitEditing={submit} />
          <ErrorText error={error} />
          <Button label="Sign in" variant="primary" big busy={busy} disabled={!username || !password || !server} onPress={submit} />
        </Card>
      </KeyboardAvoidingView>
    </Screen>
  );
}
