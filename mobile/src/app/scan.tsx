/**
 * Scan a bay's QR label: the count that follows is filed under that bay.
 * Uses expo-camera's scanner (iOS, Android and the web preview alike).
 */
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Field } from '@/components/ui';
import { parseLabel } from '@/labels';
import { useSession } from '@/state/session';
import { color, font, radius, space } from '@/theme';

export default function Scan() {
  const router = useRouter();
  const { target, setTarget } = useSession();
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState('');
  const [notOurs, setNotOurs] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  const choose = (code: string) => {
    if (done.current) return;
    done.current = true;
    if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTarget({ ...target, kind: 'count', location: code, title: `${code} · cycle count` });
    router.back();
  };

  return (
    <View style={styles.root}>
      {permission?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            const code = parseLabel(data);
            if (code) choose(code);
            else setNotOurs(true);
          }}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Text style={styles.msg}>The camera is needed to read the label.</Text>
        </View>
      )}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
        <View style={styles.frame} />
      </View>
      <SafeAreaView style={styles.bottom} edges={['bottom']}>
        <Text style={styles.title}>Point at the bay’s label</Text>
        {notOurs && <Text style={styles.warn}>That QR code is not a countbone bay label.</Text>}
        <Field label="Or type the code" value={manual} onChangeText={setManual} autoCapitalize="characters" placeholder="A07-B03" />
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button label="Cancel" variant="secondary" onPress={() => router.back()} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Use code" variant="primary" disabled={!manual.trim()} onPress={() => choose(manual.trim())} />
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  frame: { width: 240, height: 240, borderRadius: radius.lg, borderWidth: 3, borderColor: color.accent },
  msg: { color: color.fg, fontSize: font.size.md },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.lg, gap: space.md, backgroundColor: color.overlayStrong },
  title: { color: color.fg, fontSize: font.size.lg, fontWeight: '700' },
  warn: { color: color.warn, fontSize: font.size.sm },
});
