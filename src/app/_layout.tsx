import { Stack } from 'expo-router';

import { Palette } from '@/constants/theme';
import { DebriefsProvider } from '@/hooks/use-debriefs';
import { ProProvider } from '@/hooks/use-pro';

export const unstable_settings = {
  initialRouteName: 'index',
};

export default function RootLayout() {
  return (
    <ProProvider>
      <DebriefsProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: Palette.background },
            animation: 'slide_from_right',
          }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="import" />
          <Stack.Screen name="debrief" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="pro" />
        </Stack>
      </DebriefsProvider>
    </ProProvider>
  );
}
