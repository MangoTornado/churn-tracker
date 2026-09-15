/**
 * The client for the churn-tracker server.
 *
 * Every derived value — the 5/24 count, the reminders, the plan, a single card's verdicts — is
 * computed on the server and fetched, never recomputed here. That is why `@core/*` is a types-only
 * import: the rules are one implementation, tested once, and a second copy in the app would be a
 * second set of answers to drift apart. What the app owns is presentation.
 *
 * The base URL defaults to the origin the page came from and is overridable at runtime. On the web
 * that default is the whole configuration story — the server serves this bundle, so the API is
 * already wherever the app is. The override exists for the two cases where there is no useful origin
 * to inherit: a phone, and a dev server running against a deployed API.
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type {
  BankAccount,
  BankOffer,
  Card,
  CardAccount,
  CardOffer,
  Inquiry,
  IssuerId,
  Player,
  User,
} from '@core/model.ts';
import type { Assessment, Severity, Standing } from '@core/rules/issuers.ts';
import type { Plan } from '@core/rules/recommend.ts';
import type { ReminderView, Reminder } from '@core/rules/reminders.ts';

export type {
  Assessment,
  BankAccount,
  BankOffer,
  Card,
  CardAccount,
  CardOffer,
  Inquiry,
  IssuerId,
  Plan,
  Player,
  Reminder,
  ReminderView,
  Severity,
  Standing,
  User,
};

const BASE_URL_KEY = 'churn-tracker.baseUrl';

/**
 * Where the server is, by default.
 *
 * On the web this is **the origin the page was served from**, and that is the point of the whole
 * arrangement: the server serves this bundle, so opening `churn.example.com` needs no configuration
 * at all — no address to type, no CORS, and the API is wherever the app came from. Changing it stays
 * possible and becomes an escape hatch rather than a first step.
 *
 * On a phone there is no origin to inherit, so it falls back to a LAN address. Deliberately not
 * `localhost`: on a device running through Expo Go, localhost is the phone, which is never where the
 * server is.
 */
export const DEFAULT_BASE_URL =
  Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin.replace(/\/+$/, '')
    : 'http://127.0.0.1:8811';

/**
 * Whether the app is talking to the server that served it.
 *
 * Drives one thing: the sign-in screen only asks for a server address when the answer is no. A user
 * who opened the deployed hostname should not be shown a field they have no reason to touch.
 */
export function isSameOrigin(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  return baseUrl === (window.location?.origin ?? '').replace(/\/+$/, '');
}

let baseUrl = DEFAULT_BASE_URL;
let token: string | null = null;

export async function loadBaseUrl(): Promise<string> {
  const stored = await AsyncStorage.getItem(BASE_URL_KEY);
  if (stored !== null && stored !== '') baseUrl = stored;
  return baseUrl;
}

/** Forgets a stored override and goes back to the origin this app was served from. */
export async function resetBaseUrl(): Promise<string> {
  await AsyncStorage.removeItem(BASE_URL_KEY);
  baseUrl = DEFAULT_BASE_URL;
  return baseUrl;
}

export async function setBaseUrl(next: string): Promise<void> {
  baseUrl = next.trim().replace(/\/+$/, '');
  await AsyncStorage.setItem(BASE_URL_KEY, baseUrl);
}

export function currentBaseUrl(): string {
  return baseUrl;
}

export function setToken(next: string | null): void {
  token = next;
}

export class ApiError extends Error {
  readonly status: number;
  /** Which input the server objected to, when it said. Lets a form highlight the right field. */
  readonly field: string | null;

  constructor(status: number, message: string, field: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.field = field;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Skips the bearer token. For the routes that answer before anyone has signed in. */
  anonymous?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers: {
        ...(token !== null && options.anonymous !== true ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    // A network failure is the most common error this app will ever show, and "TypeError: Network
    // request failed" tells the user nothing they can act on. Status 0 marks it as reachability so
    // the UI can offer the one thing that helps: check the address.
    throw new ApiError(0, `Cannot reach the server at ${baseUrl}. Check the address and that it is running.`, null);
  }

  const text = await response.text();
  const payload = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);

  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : `Request failed (${response.status})`;
    throw new ApiError(response.status, message, typeof payload?.field === 'string' ? payload.field : null);
  }

  return payload as T;
}

// ---- shapes the server returns ---------------------------------------------

export interface Session {
  token: string;
  expiresAt: string;
  user: User;
  players: Player[];
}

export interface CatalogResponse {
  cards: Array<Card & { familyLabel: string }>;
  issuers: Record<IssuerId, string>;
  offers: CardOffer[];
  offersFetchedAt: string;
  flowchart: {
    version: string;
    updatedAt: string | null;
    source: string;
    sections: Record<string, { id: string; heading: string; body: string }>;
  };
}

export interface RemindersResponse {
  asOf: string;
  active: ReminderView[];
  all: Reminder[];
  dismissed: string[];
}

export interface AssessResponse {
  card: Card & { familyLabel: string };
  offer: CardOffer | null;
  assessment: Assessment;
  standing: Standing;
}

export interface HealthResponse {
  ok: boolean;
  /** Whether this server also serves the web app. See `isSameOrigin`. */
  servesWebApp: boolean;
  catalog: { cards: number };
  flowchart: { version: string; updatedAt: string | null };
  offers: { cards: number; banks: number; cardsFetchedAt: string | null; banksFetchedAt: string | null };
  registrationOpen: boolean;
}

// ---- the calls -------------------------------------------------------------

export const api = {
  health: () => request<HealthResponse>('/health', { anonymous: true }),

  signIn: (email: string, password: string) =>
    request<Session>('/v1/auth/login', { method: 'POST', body: { email, password }, anonymous: true }),

  register: (email: string, password: string, name: string) =>
    request<Session>('/v1/auth/register', { method: 'POST', body: { email, password, name }, anonymous: true }),

  signOut: () => request<{ ok: true }>('/v1/auth/logout', { method: 'POST' }),

  me: () => request<{ user: User; players: Player[] }>('/v1/me'),

  catalog: () => request<CatalogResponse>('/v1/catalog', { anonymous: true }),

  bankOffers: () =>
    request<{ fetchedAt: string; offers: BankOffer[] }>('/v1/bank-offers', { anonymous: true }),

  standing: (playerId?: string, asOf?: string) =>
    request<Standing>('/v1/standing', { query: { playerId, asOf } }),

  reminders: (playerId?: string, asOf?: string) =>
    request<RemindersResponse>('/v1/reminders', { query: { playerId, asOf } }),

  dismissReminder: (reminderId: string, playerId?: string) =>
    request<{ ok: true }>(`/v1/reminders/${encodeURIComponent(reminderId)}/dismiss`, {
      method: 'POST',
      query: { playerId },
    }),

  restoreReminder: (reminderId: string, playerId?: string) =>
    request<{ ok: true }>(`/v1/reminders/${encodeURIComponent(reminderId)}/dismiss`, {
      method: 'DELETE',
      query: { playerId },
    }),

  plan: (options: {
    playerId?: string;
    asOf?: string;
    goal?: 'travel' | 'cashback';
    businessCards?: boolean;
    monthlyRentCents?: number;
    maxMinSpendCents?: number;
    excludeIssuers?: IssuerId[];
  }) =>
    request<Plan & { offersFetchedAt: string }>('/v1/plan', {
      query: {
        playerId: options.playerId,
        asOf: options.asOf,
        goal: options.goal,
        businessCards: options.businessCards === false ? 'false' : undefined,
        monthlyRentCents: options.monthlyRentCents,
        maxMinSpendCents: options.maxMinSpendCents,
        excludeIssuers: options.excludeIssuers?.join(','),
      },
    }),

  assess: (cardId: string, playerId?: string, asOf?: string) =>
    request<AssessResponse>('/v1/assess', { query: { cardId, playerId, asOf } }),

  cards: (playerId?: string) => request<{ cards: CardAccount[] }>('/v1/cards', { query: { playerId } }),

  card: (id: string, playerId?: string) =>
    request<{ card: CardAccount }>(`/v1/cards/${id}`, { query: { playerId } }),

  createCard: (body: Record<string, unknown>, playerId?: string) =>
    request<{ card: CardAccount }>('/v1/cards', { method: 'POST', body, query: { playerId } }),

  updateCard: (id: string, body: Record<string, unknown>, playerId?: string) =>
    request<{ card: CardAccount }>(`/v1/cards/${id}`, { method: 'PATCH', body, query: { playerId } }),

  deleteCard: (id: string, playerId?: string) =>
    request<{ ok: true }>(`/v1/cards/${id}`, { method: 'DELETE', query: { playerId } }),

  banks: (playerId?: string) => request<{ banks: BankAccount[] }>('/v1/banks', { query: { playerId } }),

  createBank: (body: Record<string, unknown>, playerId?: string) =>
    request<{ bank: BankAccount; closeNotBeforeAtWasSuggested: boolean }>('/v1/banks', {
      method: 'POST',
      body,
      query: { playerId },
    }),

  updateBank: (id: string, body: Record<string, unknown>, playerId?: string) =>
    request<{ bank: BankAccount }>(`/v1/banks/${id}`, { method: 'PATCH', body, query: { playerId } }),

  deleteBank: (id: string, playerId?: string) =>
    request<{ ok: true }>(`/v1/banks/${id}`, { method: 'DELETE', query: { playerId } }),

  inquiries: (playerId?: string) =>
    request<{ inquiries: Inquiry[] }>('/v1/inquiries', { query: { playerId } }),

  createInquiry: (body: Record<string, unknown>, playerId?: string) =>
    request<{ inquiry: Inquiry }>('/v1/inquiries', { method: 'POST', body, query: { playerId } }),

  deleteInquiry: (id: string, playerId?: string) =>
    request<{ ok: true }>(`/v1/inquiries/${id}`, { method: 'DELETE', query: { playerId } }),

  players: () => request<{ players: Player[] }>('/v1/players'),

  createPlayer: (name: string) => request<{ player: Player }>('/v1/players', { method: 'POST', body: { name } }),

  renamePlayer: (id: string, name: string) =>
    request<{ ok: true }>(`/v1/players/${id}`, { method: 'PATCH', body: { name } }),

  deletePlayer: (id: string) => request<{ ok: true }>(`/v1/players/${id}`, { method: 'DELETE' }),

  registerDevice: (pushToken: string, platform: 'ios' | 'android' | 'web') =>
    request<{ ok: true }>('/v1/devices', { method: 'POST', body: { pushToken, platform } }),

  unregisterDevice: (pushToken: string) =>
    request<{ ok: true }>('/v1/devices', { method: 'DELETE', query: { pushToken } }),
};
