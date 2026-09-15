/**
 * Registering for reminder pushes.
 *
 * Asked for at the point the user turns them on in Settings, never at launch. A permission prompt on
 * first run gets denied by reflex, and on iOS a denial is close to permanent — the user has to go to
 * the system settings to undo it. Asking after they have said they want reminders means the prompt
 * arrives as the answer to something they just did.
 *
 * Notifications are the only reason this app needs a device identity at all, so all of that lives
 * here rather than in the session.
 */

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

import { api } from './api.ts';

/** Show a notification even when the app is open. Reminders are worth interrupting for. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export type PushOutcome =
  | { ok: true; token: string }
  | { ok: false; reason: 'unsupported' | 'denied' | 'no-project' | 'failed'; detail: string };

export async function enablePush(): Promise<PushOutcome> {
  // The simulator cannot receive a push, and asking there produces a confusing failure rather than a
  // prompt. Say so instead.
  if (!Device.isDevice) {
    return {
      ok: false,
      reason: 'unsupported',
      detail: 'Push notifications need a real device — a simulator cannot receive them.',
    };
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== 'granted') {
    return {
      ok: false,
      reason: 'denied',
      detail: 'Notifications are turned off for this app. Turn them on in your device settings, then try again.',
    };
  }

  // Android needs a channel before anything will show. Violet to match the app's date accent, since
  // every notification this app sends is about a date.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('reminders', {
      name: 'Reminders',
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: '#B9A0F5',
    });
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;

  try {
    // `projectId` is required in a production build and inferred in Expo Go. Passing it as undefined
    // rather than omitting the call keeps the one code path.
    const token = await Notifications.getExpoPushTokenAsync(projectId === undefined ? undefined : { projectId });
    await api.registerDevice(token.data, Platform.OS === 'android' ? 'android' : Platform.OS === 'web' ? 'web' : 'ios');
    return { ok: true, token: token.data };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The common cause in a standalone build, and it has a specific fix: run `eas init` so the
    // project has an id to mint tokens against.
    if (/projectId/i.test(detail)) {
      return {
        ok: false,
        reason: 'no-project',
        detail: 'This build has no EAS project id, so it cannot mint a push token. Run `eas init` and rebuild.',
      };
    }
    return { ok: false, reason: 'failed', detail };
  }
}

export async function disablePush(token: string): Promise<void> {
  await api.unregisterDevice(token).catch(() => undefined);
}

/** The token this device already has, if permission was granted before. Null otherwise. */
export async function currentPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  const permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted') return null;

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
  try {
    const token = await Notifications.getExpoPushTokenAsync(projectId === undefined ? undefined : { projectId });
    return token.data;
  } catch {
    return null;
  }
}
