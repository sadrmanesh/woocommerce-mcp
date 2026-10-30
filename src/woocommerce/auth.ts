import { createHmac, randomBytes } from 'node:crypto';

export const AUTH_MODES = ['basic', 'oauth1', 'query'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export interface AuthorizeInput {
  method: string;
  url: string;
  query: Record<string, string>;
  consumerKey: string;
  consumerSecret: string;
  mode: AuthMode;
  timestamp: number;
  nonce: string;
}

export interface AuthorizedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * WooCommerce authenticates REST requests with a consumer key and secret.
 * HTTPS uses HTTP Basic by default. Plain HTTP uses OAuth 1.0a one-legged
 * HMAC-SHA1. Query-string auth is an explicit override for hosts that drop
 * the Authorization header. The JSON body is not part of the OAuth signature.
 */
export function authorize(input: AuthorizeInput): AuthorizedRequest {
  if (input.mode === 'basic') {
    const token = Buffer.from(`${input.consumerKey}:${input.consumerSecret}`, 'utf8').toString('base64');
    return {
      url: appendQuery(input.url, input.query),
      headers: { Authorization: `Basic ${token}` },
    };
  }

  if (input.mode === 'query') {
    return {
      url: appendQuery(input.url, {
        ...input.query,
        consumer_key: input.consumerKey,
        consumer_secret: input.consumerSecret,
      }),
      headers: {},
    };
  }

  const oauth: Record<string, string> = {
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: input.nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(input.timestamp),
  };
  const signedParams = { ...input.query, ...oauth };
  const signature = signOauth(input.method, input.url, signedParams, input.consumerSecret);
  return {
    url: appendQuery(input.url, { ...signedParams, oauth_signature: signature }),
    headers: {},
  };
}

export function signOauth(
  method: string,
  baseUrl: string,
  params: Record<string, string>,
  consumerSecret: string,
): string {
  const paramString = buildQuery(params);
  const baseString = [method.toUpperCase(), encodeRfc3986(baseUrl), encodeRfc3986(paramString)].join('&');
  const key = `${encodeRfc3986(consumerSecret)}&`;
  return createHmac('sha1', key).update(baseString).digest('base64');
}

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(params[key] ?? '')}`)
    .join('&');
}

export function createNonce(): string {
  return randomBytes(16).toString('hex');
}

function appendQuery(url: string, params: Record<string, string>): string {
  const query = buildQuery(params);
  return query === '' ? url : `${url}?${query}`;
}
