/**
 * Push notifications, via Expo's service, and the daily job that decides what to send.
 *
 * Expo rather than APNs and FCM directly: the app is one Expo codebase across iOS, Android and web,
 * and Expo's push API is a single unauthenticated POST of JSON. Talking to Apple would mean a signed
 * JWT with a p8 key, and to Google a service account — two more secrets on the host and two more
 * things to rotate, to reach the same phones.
 *
 * The rules about *what* to send are the substance here, and they all point the same way: a
 * reminder app that cries wolf gets its notifications switched off, and then the annual fee that
 * actually mattered arrives in silence.
 *
 *   - **One notification per reminder, ever.** Keyed on the reminder's content-addressed id, so a
 *     job that runs twice sends once. Because the id folds in the due date, a deadline that *moves*
 *     is a new reminder and does get a second notification — which is right.
 *   - **Only urgent and overdue.** Everything else is on the home screen already, where the user
 *     will see it when they look. A push is for something with days left.
 *   - **At most three per user per run,** highest stake first. Four notifications at once is not
 *     four times as useful as one; it is how people learn to swipe them away unread.
 */

import type { ReminderView } from '../core/rules/reminders.ts';
import { activeReminders } from '../core/rules/reminders.ts';
import type { Store } from './db.ts';
import type { Settings } from './config.ts';
import { today } from '../core/dates.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Expo's own cap on a single request. Batching is only relevant if this ever gets popular. */
const MAX_PER_REQUEST = 100;

const MAX_PER_USER_PER_RUN = 3;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Deep-link payload: enough for the app to open the right screen. */
  data: { reminderId: string; kind: string; playerId: string; subjectId: string };
  sound: 'default';
  /**
   * Android only, and deliberately not `high`. A churning deadline is not a phone call — `default`
   * still shows in the tray and does not interrupt.
   */
  priority: 'default';
}

export interface PushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Sends a batch to Expo and reports which tokens are dead.
 *
 * Never throws. This runs from a timer with nothing to catch it, and a network blip must not take
 * the process down — the reminder is derived, so it will still be there on the next run.
 */
export async function sendPush(
  messages: PushMessage[],
): Promise<{ sent: number; deadTokens: string[]; error?: string }> {
  if (messages.length === 0) return { sent: 0, deadTokens: [] };

  const deadTokens: string[] = [];
  let sent = 0;

  for (let index = 0; index < messages.length; index += MAX_PER_REQUEST) {
    const batch = messages.slice(index, index + MAX_PER_REQUEST);
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) return { sent, deadTokens, error: `Expo returned HTTP ${response.status}` };

      const payload = (await response.json()) as { data?: PushTicket[] };
      const tickets = payload.data ?? [];

      tickets.forEach((ticket, position) => {
        if (ticket.status === 'ok') {
          sent += 1;
          return;
        }
        // The one error worth acting on: the token belongs to an app that has been uninstalled.
        // Everything else is transient and the next run will retry.
        if (ticket.details?.error === 'DeviceNotRegistered') {
          deadTokens.push(batch[position].to);
        }
      });
    } catch (error) {
      return { sent, deadTokens, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { sent, deadTokens };
}

function messageFor(reminder: ReminderView): { title: string; body: string } {
  // The date goes in the body rather than the title: a tray notification truncates the title hard,
  // and "Spend $2,500 more" is the part that has to survive truncation.
  const when = reminder.daysUntil < 0 ? 'overdue' : reminder.whenText;
  return { title: reminder.title, body: `${reminder.subject.name} — ${when}. ${reminder.detail}`.slice(0, 400) };
}

export interface NotifyResult {
  users: number;
  considered: number;
  sent: number;
  deadTokens: number;
  errors: string[];
}

/**
 * One pass over every user with a registered device.
 *
 * Returns rather than throws, for the same reason `sendPush` does — this is called from a timer.
 */
export async function notifyEveryone(
  store: Store,
  settings: Settings,
  asOf = today(),
): Promise<NotifyResult> {
  const result: NotifyResult = { users: 0, considered: 0, sent: 0, deadTokens: 0, errors: [] };
  if (!settings.read().notificationsEnabled) return result;

  const now = new Date().toISOString();

  for (const userId of store.userIdsWithDevices()) {
    const devices = store.devices(userId);
    if (devices.length === 0) continue;
    result.users += 1;

    const due: ReminderView[] = [];
    for (const player of store.players(userId)) {
      const state = store.playerState(player);
      const active = activeReminders(state, asOf, store.dismissed(player.id));
      for (const reminder of active) {
        if (reminder.urgency !== 'urgent' && reminder.urgency !== 'overdue') continue;
        if (store.alreadyNotified(userId, reminder.id)) continue;
        due.push(reminder);
      }
    }

    result.considered += due.length;
    if (due.length === 0) continue;

    // Highest stake first, then soonest. If three is not enough, the ones that matter are the ones
    // with money attached.
    due.sort((a, b) => b.stakeCents - a.stakeCents || a.daysUntil - b.daysUntil);
    const chosen = due.slice(0, MAX_PER_USER_PER_RUN);

    const messages: PushMessage[] = [];
    for (const reminder of chosen) {
      const { title, body } = messageFor(reminder);
      for (const device of devices) {
        messages.push({
          to: device.pushToken,
          title,
          body,
          data: {
            reminderId: reminder.id,
            kind: reminder.kind,
            playerId: reminder.playerId,
            subjectId: reminder.subject.id,
          },
          sound: 'default',
          priority: 'default',
        });
      }
    }

    const outcome = await sendPush(messages);
    result.sent += outcome.sent;
    if (outcome.error !== undefined) result.errors.push(outcome.error);

    for (const token of outcome.deadTokens) {
      store.markDeviceFailed(token, now);
      result.deadTokens += 1;
    }

    // Recorded even when the send partly failed. The alternative is retrying every hour against a
    // service that is down and then delivering a burst of duplicates when it comes back; a
    // reminder that goes unsent once still shows on the home screen, which is where it belongs.
    for (const reminder of chosen) store.recordNotified(userId, reminder.id, now);
  }

  return result;
}
