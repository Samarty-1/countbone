import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SettingsProvider } from '@/lib/settings.tsx';
import { color } from '@/theme.ts';

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: color.bg,
    card: color.surface,
    border: color.line,
    text: color.fg,
    primary: color.accent,
  },
};

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.bg }}>
      <SafeAreaProvider>
        <SettingsProvider>
          <ThemeProvider value={theme}>
            <StatusBar style="light" />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: color.surface },
                headerTintColor: color.fg,
                headerTitleStyle: { fontWeight: '600' },
                contentStyle: { backgroundColor: color.bg },
              }}
            >
              <Stack.Screen name="index" options={{ title: 'Countbone' }} />
              <Stack.Screen name="capture" options={{ headerShown: false, animation: 'fade', gestureEnabled: false }} />
              <Stack.Screen
                name="upload/[id]"
                options={{ title: 'Uploading', headerBackVisible: false, gestureEnabled: false }}
              />
              <Stack.Screen name="run/[id]/index" options={{ title: 'Count' }} />
              <Stack.Screen name="run/[id]/review" options={{ title: 'Review' }} />
              <Stack.Screen name="history" options={{ title: 'History' }} />
              <Stack.Screen name="settings" options={{ title: 'Settings' }} />
            </Stack>
          </ThemeProvider>
        </SettingsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
