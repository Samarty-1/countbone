import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SessionProvider, useSession } from '@/state/session';
import { color } from '@/theme';

/**
 * Signed-out people can reach only the sign-in screen; signed-in people
 * never see it. Route guards, not a redirect effect: with an effect, the
 * first screen rendered (and fetched from the server) before the redirect.
 */
function AuthGate() {
  const { ready, user } = useSession();

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.bg }}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg }, animation: 'fade' }}>
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="capture" options={{ animation: 'slide_from_bottom', gestureEnabled: false }} />
        <Stack.Screen name="scan" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="run/[id]/index" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="run/[id]/review" options={{ animation: 'slide_from_right' }} />
      </Stack.Protected>
      <Stack.Protected guard={!user}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.bg }}>
      <SafeAreaProvider>
        <SessionProvider>
          <StatusBar style="light" />
          <AuthGate />
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
