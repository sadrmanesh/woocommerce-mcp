import { createHash, timingSafeEqual } from 'node:crypto';

import { type AuthInfo, OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from '@modelcontextprotocol/server';

import { type HttpAuthConfig, type IntrospectionConfig, SCOPES } from './config.js';

/** Static tokens never expire on their own; the SDK still wants an expiry, so report a rolling hour. */
const STATIC_TOKEN_TTL_SECONDS = 3_600;
const INTROSPECTION_CACHE_SECONDS = 60;
const INTROSPECTION_CACHE_LIMIT = 1_000;

export interface VerifierOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function fingerprint(token: string): string {
  return digest(token).toString('hex').slice(0, 12);
}

function sameUrl(value: string, expected: string | null): boolean {
  if (expected === null) return false;
  try {
    return new URL(value).href === new URL(expected).href;
  } catch {
    return false;
  }
}

function invalid(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}

/**
 * Checks bearer tokens against the static token lists first, then against an
 * RFC 7662 introspection endpoint when one is configured.
 */
export function createTokenVerifier(auth: HttpAuthConfig, options: VerifierOptions = {}): OAuthTokenVerifier {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const staticTokens = [
    ...auth.tokens.map((token) => ({ hash: digest(token), scopes: [SCOPES.read, SCOPES.write] })),
    ...auth.readTokens.map((token) => ({ hash: digest(token), scopes: [SCOPES.read] })),
  ];
  const cache = new Map<string, { info: AuthInfo; until: number }>();

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const hash = digest(token);
      // Compare against every entry so timing does not reveal which list matched.
      let match: { scopes: string[] } | undefined;
      for (const entry of staticTokens) {
        if (timingSafeEqual(entry.hash, hash) && match === undefined) match = entry;
      }
      if (match) {
        return {
          token,
          clientId: `static:${fingerprint(token)}`,
          scopes: [...match.scopes, ...auth.requiredScopes.filter((scope) => !match.scopes.includes(scope))],
          expiresAt: Math.floor(now() / 1000) + STATIC_TOKEN_TTL_SECONDS,
          ...(auth.resource !== null ? { resource: new URL(auth.resource) } : {}),
        };
      }
      if (auth.introspection === null) throw invalid('Unknown access token');

      const key = hash.toString('hex');
      const cached = cache.get(key);
      if (cached && cached.until > now()) return cached.info;
      cache.delete(key);

      const info = await introspect(auth.introspection, token, fetchImpl, now, auth.resource);
      const until = Math.min(now() + INTROSPECTION_CACHE_SECONDS * 1000, (info.expiresAt ?? 0) * 1000);
      if (cache.size >= INTROSPECTION_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { info, until });
      return info;
    },
  };
}

async function introspect(
  config: IntrospectionConfig,
  token: string,
  fetchImpl: typeof fetch,
  now: () => number,
  expectedResource: string | null,
): Promise<AuthInfo> {
  let response: Response;
  try {
    response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new OAuthError(OAuthErrorCode.ServerError, 'Token introspection is unavailable');
  }
  if (!response.ok) {
    throw new OAuthError(OAuthErrorCode.ServerError, `Token introspection failed with HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OAuthError(OAuthErrorCode.ServerError, 'Token introspection returned invalid JSON');
  }
  if (typeof body !== 'object' || body === null) throw new OAuthError(OAuthErrorCode.ServerError, 'Invalid introspection response');
  const data = body as Record<string, unknown>;
  if (data.active !== true) throw invalid('Token is not active');
  const exp = typeof data.exp === 'number' ? data.exp : undefined;
  if (exp === undefined) throw invalid('Token has no expiry');
  if (exp * 1000 <= now()) throw invalid('Token has expired');
  const audiences = (Array.isArray(data.aud) ? data.aud : [data.aud]).filter(
    (value): value is string => typeof value === 'string',
  );
  // A token may name several audiences; report the one this server expects when present.
  const audience = audiences.find((value) => sameUrl(value, expectedResource)) ?? audiences[0];
  const scopes = typeof data.scope === 'string' ? data.scope.split(' ').filter((scope) => scope !== '') : [];
  const clientId =
    typeof data.client_id === 'string' ? data.client_id : typeof data.sub === 'string' ? data.sub : 'unknown';
  let resource: URL | undefined;
  if (typeof audience === 'string') {
    try {
      resource = new URL(audience);
    } catch {
      resource = undefined;
    }
  }
  return { token, clientId, scopes, expiresAt: exp, ...(resource ? { resource } : {}) };
}
