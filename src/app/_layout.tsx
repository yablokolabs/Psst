import { Stack } from 'expo-router';

import { Palette } from '@/constants/theme';
import { ProProvider } from '@/hooks/use-pro';
import { SessionHistoryProvider } from '@/hooks/use-session-history';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function RootLayout() {
  return (
    <ProProvider>
      <SessionHistoryProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: Palette.background },
            animation: 'slide_from_right',
          }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="prep" />
          <Stack.Screen name="live" />
          <Stack.Screen name="recap" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="pro" />
        </Stack>
      </SessionHistoryProvider>
    </ProProvider>
  );
}
