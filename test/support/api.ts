import { env } from './env';

/** Cliente HTTP dos testes caixa-preta: tokens reais do Keycloak e round-robin entre as instâncias. */

const tokens = new Map<string, { token: string; expiresAt: number }>();
const SECRETS: Record<string, string> = {
  'provider-a': 'provider-a-secret',
  'provider-b': 'provider-b-secret',
  'back-office': 'back-office-secret',
};

export async function tokenFor(clientId: string): Promise<string> {
  const cached = tokens.get(clientId);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.token;
  }
  const res = await fetch(`${env.keycloakUrl}/realms/jungle/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: SECRETS[clientId]! }),
  });
  if (!res.ok) {
    throw new Error(`token request for ${clientId} failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokens.set(clientId, { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

let next = 0;
export function instanceUrl(index?: number): string {
  const urls = env.appUrls;
  const i = index ?? next++;
  return urls[i % urls.length]!;
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  instance: string;
}

export async function call<T = any>(
  method: string,
  path: string,
  opts: { as?: string; body?: unknown; headers?: Record<string, string>; instance?: number } = {},
): Promise<ApiResponse<T>> {
  const base = instanceUrl(opts.instance);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.as) {
    headers.authorization = `Bearer ${await tokenFor(opts.as)}`;
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* corpo não-JSON (ex.: /metrics) */
  }
  return { status: res.status, body, instance: base };
}

export async function createWallet(amount = '100.00', currency = 'BRL', playerId = crypto.randomUUID()) {
  const res = await call('POST', '/wallets', {
    as: 'back-office',
    body: { playerId, initialBalance: { amount, currency } },
  });
  if (res.status !== 201) {
    throw new Error(`createWallet failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
}

export interface WagerInput {
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  externalTransactionId?: string;
  reference?: string;
  providerId?: string;
  roundId?: string;
  currency?: string;
}

export function wagerBody(w: WagerInput) {
  return {
    providerId: w.providerId ?? 'provider-a',
    externalTransactionId: w.externalTransactionId ?? `ext-${crypto.randomUUID()}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: w.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind: w.kind,
    money: { amount: w.amount, currency: w.currency ?? 'BRL' },
    ...(w.reference ? { referenceExternalTransactionId: w.reference } : {}),
  };
}

export async function submit(w: WagerInput, opts: { instance?: number; idempotencyKey?: string } = {}) {
  const body = wagerBody(w);
  return call('POST', '/wagering/transactions', {
    as: body.providerId,
    body,
    instance: opts.instance,
    headers: { 'Idempotency-Key': opts.idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}` },
  });
}

export async function getWallet(walletId: string) {
  return (await call('GET', `/wallets/${walletId}`, { as: 'back-office' })).body as {
    balance: { amount: string };
    version: number;
  };
}

export async function reconcile(walletId: string) {
  return (await call('POST', `/wallets/${walletId}/reconciliation`, { as: 'back-office' })).body as {
    consistent: boolean;
    storedBalance: { amount: string };
    calculatedBalance: { amount: string };
    checkedEntries: number;
  };
}

/** Espera uma condição assíncrona (polling), falhando com a última observação. */
export async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();
  while (!ok(last)) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met in ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
    }
    await Bun.sleep(200);
    last = await fn();
  }
  return last;
}
