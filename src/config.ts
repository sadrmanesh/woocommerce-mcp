import * as z from 'zod/v4';

import { VERSION } from './version.js';
import { AUTH_MODES, type AuthMode } from './woocommerce/auth.js';
import { ConfigError } from './woocommerce/errors.js';

const TRANSPORTS = ['stdio', 'http'] as const;
export type TransportMode = (typeof TRANSPORTS)[number];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

const flagSchema = z.enum(['true', '1', 'yes', 'on', 'false', '0', 'no', 'off'], {
  error: 'must be true or false',
});

const secretSchema = z
  .string()
  .min(1, 'is required')
  .max(200, 'must be at most 200 characters')
  .refine((value) => !/\s/.test(value), 'must not contain whitespace');

export interface AppConfig {
  url: string;
  consumerKey: string;
  consumerSecret: string;
  apiVersion: string;
  readOnly: boolean;
  timeoutMs: number;
  maxRetries: number;
  defaultPerPage: number;
  authMode: AuthMode;
  userAgent: string;
  debug: boolean;
  transport: TransportMode;
  httpHost: string;
  httpPort: number;
  httpPath: string;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const issues: string[] = [];

  const urlText = required(env, 'WOOCOMMERCE_URL', issues);
  const url = urlText === undefined ? undefined : parseStoreUrl(urlText, issues);
  const consumerKey = parseSecret(env, 'WOOCOMMERCE_CONSUMER_KEY', issues);
  const consumerSecret = parseSecret(env, 'WOOCOMMERCE_CONSUMER_SECRET', issues);
  const readOnly = parseFlag(env, 'WOOCOMMERCE_READ_ONLY', true, issues);
  const debug = parseFlag(env, 'WOOCOMMERCE_DEBUG', false, issues);
  const apiVersion = parseApiVersion(env, issues);
  const timeoutMs = parseIntInRange(env, 'WOOCOMMERCE_TIMEOUT_MS', 30_000, 1_000, 120_000, issues);
  const maxRetries = parseIntInRange(env, 'WOOCOMMERCE_MAX_RETRIES', 2, 0, 5, issues);
  const defaultPerPage = parseIntInRange(env, 'WOOCOMMERCE_DEFAULT_PER_PAGE', 10, 1, 100, issues);
  const authMode = parseChoice(env, 'WOOCOMMERCE_AUTH_MODE', AUTH_MODES, issues);
  const transport = parseChoice(env, 'MCP_TRANSPORT', TRANSPORTS, issues) ?? 'stdio';
  const httpHost = parseHttpHost(env, issues);
  const httpPort = parseIntInRange(env, 'MCP_HTTP_PORT', 3000, 1, 65_535, issues);
  const httpPath = parseHttpPath(env, issues);
  const userAgent = parseUserAgent(env, issues);

  if (
    issues.length > 0 ||
    url === undefined ||
    consumerKey === undefined ||
    consumerSecret === undefined ||
    apiVersion === undefined ||
    timeoutMs === undefined ||
    maxRetries === undefined ||
    defaultPerPage === undefined ||
    httpHost === undefined ||
    httpPort === undefined ||
    httpPath === undefined ||
    userAgent === undefined
  ) {
    throw new ConfigError(`Invalid configuration:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
  }

  return {
    url,
    consumerKey,
    consumerSecret,
    apiVersion,
    readOnly,
    timeoutMs,
    maxRetries,
    defaultPerPage,
    authMode: authMode ?? (url.startsWith('https:') ? 'basic' : 'oauth1'),
    userAgent,
    debug,
    transport,
    httpHost,
    httpPort,
    httpPath,
  };
}

export function authWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  const insecure = config.url.startsWith('http:');
  if (insecure && config.authMode !== 'oauth1') {
    warnings.push(
      'This store URL uses http:// and the selected auth mode sends the consumer secret without encryption. Use https://, or set WOOCOMMERCE_AUTH_MODE=oauth1.',
    );
  }
  if (config.authMode === 'query') {
    warnings.push(
      'Query-string authentication puts the consumer secret in the request URL. Prefer HTTP Basic over https://.',
    );
  }
  return warnings;
}

export function publicStoreLabel(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  return `${parsed.host}${path}`;
}

function required(env: Record<string, string | undefined>, name: string, issues: string[]): string | undefined {
  const value = clean(env[name]);
  if (value === undefined) {
    issues.push(`${name}: is required`);
    return undefined;
  }
  return value;
}

function parseSecret(
  env: Record<string, string | undefined>,
  name: string,
  issues: string[],
): string | undefined {
  const value = required(env, name, issues);
  if (value === undefined) return undefined;
  const parsed = secretSchema.safeParse(value);
  if (!parsed.success) {
    issues.push(`${name}: ${firstIssue(parsed.error)}`);
    return undefined;
  }
  return parsed.data;
}

function parseFlag(
  env: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
  issues: string[],
): boolean {
  const value = clean(env[name]);
  if (value === undefined) return fallback;
  const parsed = flagSchema.safeParse(value.toLowerCase());
  if (!parsed.success) {
    issues.push(`${name}: must be true or false`);
    return fallback;
  }
  return parsed.data === 'true' || parsed.data === '1' || parsed.data === 'yes' || parsed.data === 'on';
}

function parseChoice<T extends string>(
  env: Record<string, string | undefined>,
  name: string,
  allowed: readonly T[],
  issues: string[],
): T | undefined {
  const value = clean(env[name]);
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  const parsed = z.enum(allowed).safeParse(normalized);
  if (!parsed.success) {
    issues.push(`${name}: must be one of: ${allowed.join(', ')}`);
    return undefined;
  }
  return parsed.data;
}

function parseIntInRange(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
  issues: string[],
): number | undefined {
  const value = clean(env[name]);
  if (value === undefined) return fallback;
  const parsed = z
    .string()
    .regex(/^\d+$/, 'must be an integer')
    .transform((text) => Number(text))
    .refine((parsedValue) => parsedValue >= min && parsedValue <= max, `must be between ${min} and ${max}`)
    .safeParse(value);
  if (!parsed.success) {
    issues.push(`${name}: ${firstIssue(parsed.error)}`);
    return undefined;
  }
  return parsed.data;
}

function parseApiVersion(env: Record<string, string | undefined>, issues: string[]): string | undefined {
  const value = clean(env.WOOCOMMERCE_API_VERSION);
  if (value === undefined) return 'wc/v3';
  const parsed = z.string().regex(/^wc\/v\d+$/, 'must look like wc/v3').safeParse(value);
  if (!parsed.success) {
    issues.push(`WOOCOMMERCE_API_VERSION: must look like wc/v3`);
    return undefined;
  }
  return parsed.data;
}

function parseHttpHost(env: Record<string, string | undefined>, issues: string[]): string | undefined {
  const value = clean(env.MCP_HTTP_HOST) ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(value)) {
    issues.push('MCP_HTTP_HOST: must be a loopback address (127.0.0.1 or localhost)');
    return undefined;
  }
  return value;
}

function parseHttpPath(env: Record<string, string | undefined>, issues: string[]): string | undefined {
  const raw = clean(env.MCP_HTTP_PATH) ?? '/mcp';
  const value = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  const parsed = z
    .string()
    .regex(/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/, 'must be an absolute path such as /mcp')
    .safeParse(value);
  if (!parsed.success) {
    issues.push('MCP_HTTP_PATH: must be an absolute path such as /mcp');
    return undefined;
  }
  return parsed.data;
}

function parseUserAgent(env: Record<string, string | undefined>, issues: string[]): string | undefined {
  const value = clean(env.WOOCOMMERCE_USER_AGENT);
  if (value === undefined) return `woocommerce-mcp/${VERSION}`;
  const parsed = z
    .string()
    .regex(/^[^\r\n]{1,200}$/, 'must be 1 to 200 characters without line breaks')
    .safeParse(value);
  if (!parsed.success) {
    issues.push('WOOCOMMERCE_USER_AGENT: must be 1 to 200 characters without line breaks');
    return undefined;
  }
  return parsed.data;
}

function parseStoreUrl(value: string, issues: string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issues.push('WOOCOMMERCE_URL: must be an absolute http or https URL');
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    issues.push('WOOCOMMERCE_URL: must use http or https');
    return undefined;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    issues.push('WOOCOMMERCE_URL: must not include credentials');
    return undefined;
  }
  if (parsed.hostname === '') {
    issues.push('WOOCOMMERCE_URL: must include a host');
    return undefined;
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    issues.push('WOOCOMMERCE_URL: must not include a query string or hash');
    return undefined;
  }
  if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
    parsed.port = '';
  }
  return parsed.toString().replace(/\/$/, '');
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'is invalid';
}
