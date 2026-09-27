import { Tabs } from 'expo-router';
import { Camera, ClipboardList, Settings, UploadCloud } from 'lucide-react-native';

import { useQueue } from '@/state/useQueue';
import { color, touch } from '@/theme';

export default function TabsLayout() {
  const queue = useQueue();
  const waiting = queue.filter((q) => q.state === 'waiting' || q.state === 'uploading' || q.state === 'failed').length;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.accent,
        tabBarInactiveTintColor: color.subtle,
        tabBarStyle: { backgroundColor: color.surface, borderTopColor: color.line, minHeight: touch.min + 16 },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        sceneStyle: { backgroundColor: color.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Count', tabBarIcon: ({ color: c }) => <Camera color={c} size={22} /> }} />
      <Tabs.Screen name="tasks" options={{ title: 'Recounts', tabBarIcon: ({ color: c }) => <ClipboardList color={c} size={22} /> }} />
      <Tabs.Screen
        name="queue"
        options={{
          title: 'Uploads',
          tabBarBadge: waiting || undefined,
          tabBarBadgeStyle: { backgroundColor: color.warn, color: color.accentFg },
          tabBarIcon: ({ color: c }) => <UploadCloud color={c} size={22} />,
        }}
      />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: ({ color: c }) => <Settings color={c} size={22} /> }} />
    </Tabs>
  );
}
