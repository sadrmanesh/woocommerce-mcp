import { readFileSync } from 'node:fs';

import * as z from 'zod/v4';

import { VERSION } from './version.js';
import { AUTH_MODES, type AuthMode } from './woocommerce/auth.js';
import { ConfigError } from './woocommerce/errors.js';

const TRANSPORTS = ['stdio', 'http'] as const;
export type TransportMode = (typeof TRANSPORTS)[number];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const STORE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const MIN_TOKEN_LENGTH = 24;

export const SCOPES = {
  read: 'woocommerce:read',
  write: 'woocommerce:write',
} as const;

const flagSchema = z.enum(['true', '1', 'yes', 'on', 'false', '0', 'no', 'off'], {
  error: 'must be true or false',
});

const secretSchema = z
  .string()
  .min(1, 'is required')
  .max(200, 'must be at most 200 characters')
  .refine((value) => !/\s/.test(value), 'must not contain whitespace');

/** One WooCommerce store the server can talk to. */
export interface StoreConfig {
  id: string;
  label: string | null;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  apiVersion: string;
  authMode: AuthMode;
  readOnly: boolean;
}

/** Settings the REST client needs for one store. */
export interface ClientOptions {
  url: string;
  consumerKey: string;
  consumerSecret: string;
  apiVersion: string;
  authMode: AuthMode;
  timeoutMs: number;
  maxRetries: number;
  userAgent: string;
  debug: boolean;
}

export interface IntrospectionConfig {
  url: string;
  clientId: string;
  clientSecret: string;
}

export interface HttpAuthConfig {
  /** Tokens with read and write scopes. */
  tokens: string[];
  /** Tokens limited to the read scope. */
  readTokens: string[];
  introspection: IntrospectionConfig | null;
  issuer: string | null;
  resource: string | null;
  requiredScopes: string[];
}

export interface AppConfig {
  stores: StoreConfig[];
  defaultStore: string;
  timeoutMs: number;
  maxRetries: number;
  defaultPerPage: number;
  userAgent: string;
  debug: boolean;
  requireConfirmation: boolean;
  auditLog: string | null;
  telemetry: boolean;
  transport: TransportMode;
  httpHost: string;
  httpPort: number;
  httpPath: string;
  httpAllowedHosts: string[];
  httpAllowedOrigins: string[];
  httpAuth: HttpAuthConfig | null;
}

const storeEntrySchema = z
  .object({
    id: z.string().regex(STORE_ID, 'must be 1 to 40 letters, digits, dashes, or underscores'),
    label: z.string().trim().min(1).max(100).optional(),
    url: z.string(),
    consumerKey: z.string().optional(),
    consumerKeyEnv: z.string().optional(),
    consumerSecret: z.string().optional(),
    consumerSecretEnv: z.string().optional(),
    apiVersion: z.string().regex(/^wc\/v\d+$/, 'must look like wc/v3').optional(),
    authMode: z.enum(AUTH_MODES).optional(),
    readOnly: z.boolean().optional(),
  })
  .strict();

const storesDocumentSchema = z.union([
  z.array(storeEntrySchema),
  z
    .object({
      defaultStore: z.string().optional(),
      stores: z.array(storeEntrySchema),
    })
    .strict(),
]);

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env, readFile: (path: string) => string = defaultReadFile): AppConfig {
  const issues: string[] = [];

  const globalReadOnly = parseFlag(env, 'WOOCOMMERCE_READ_ONLY', true, issues);
  const debug = parseFlag(env, 'WOOCOMMERCE_DEBUG', false, issues);
  const requireConfirmation = parseFlag(env, 'WOOCOMMERCE_REQUIRE_CONFIRMATION', true, issues);
  const telemetry = parseFlag(env, 'WOOCOMMERCE_OTEL_ENABLED', false, issues);
  const timeoutMs = parseIntInRange(env, 'WOOCOMMERCE_TIMEOUT_MS', 30_000, 1_000, 120_000, issues);
  const maxRetries = parseIntInRange(env, 'WOOCOMMERCE_MAX_RETRIES', 2, 0, 5, issues);
  const defaultPerPage = parseIntInRange(env, 'WOOCOMMERCE_DEFAULT_PER_PAGE', 10, 1, 100, issues);
  const transport = parseChoice(env, 'MCP_TRANSPORT', TRANSPORTS, issues) ?? 'stdio';
  const httpPort = parseIntInRange(env, 'MCP_HTTP_PORT', 3000, 1, 65_535, issues);
  const httpPath = parseHttpPath(env, issues);
  const userAgent = parseUserAgent(env, issues);
  const auditLog = clean(env.WOOCOMMERCE_AUDIT_LOG) ?? null;
  const httpAuth = parseHttpAuth(env, issues);
  const httpHost = parseHttpHost(env, httpAuth !== null, issues);
  const httpAllowedHosts = parseList(env.MCP_HTTP_ALLOWED_HOSTS);
  const httpAllowedOrigins = parseList(env.MCP_HTTP_ALLOWED_ORIGINS);

  const { stores, documentDefault } = parseStores(env, globalReadOnly, readFile, issues);
  const defaultStore = parseDefaultStore(env, stores, documentDefault, issues);

  if (
    issues.length > 0 ||
    timeoutMs === undefined ||
    maxRetries === undefined ||
    defaultPerPage === undefined ||
    httpHost === undefined ||
    httpPort === undefined ||
    httpPath === undefined ||
    userAgent === undefined ||
    defaultStore === undefined
  ) {
    throw new ConfigError(`Invalid configuration:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
  }

  return {
    stores,
    defaultStore,
    timeoutMs,
    maxRetries,
    defaultPerPage,
    userAgent,
    debug,
    requireConfirmation,
    auditLog,
    telemetry,
    transport,
    httpHost,
    httpPort,
    httpPath,
    httpAllowedHosts,
    httpAllowedOrigins,
    httpAuth,
  };
}

export function clientOptions(config: AppConfig, store: StoreConfig): ClientOptions {
  return {
    url: store.url,
    consumerKey: store.consumerKey,
    consumerSecret: store.consumerSecret,
    apiVersion: store.apiVersion,
    authMode: store.authMode,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    userAgent: config.userAgent,
    debug: config.debug,
  };
}

export function authWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  const multiple = config.stores.length > 1;
  for (const store of config.stores) {
    const prefix = multiple ? `Store "${store.id}": ` : '';
    if (store.url.startsWith('http:') && store.authMode !== 'oauth1') {
      warnings.push(
        `${prefix}This store URL uses http:// and the selected auth mode sends the consumer secret without encryption. Use https://, or set the auth mode to oauth1.`,
      );
    }
    if (store.authMode === 'query') {
      warnings.push(
        `${prefix}Query-string authentication puts the consumer secret in the request URL. Prefer HTTP Basic over https://.`,
      );
    }
  }
  if (config.transport === 'http' && config.httpAuth === null && config.stores.some((store) => !store.readOnly)) {
    warnings.push(
      'The HTTP endpoint has no bearer authentication while writes are enabled. Any local process can call write tools. Set MCP_HTTP_AUTH_TOKENS.',
    );
  }
  return warnings;
}

export function publicStoreLabel(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
  return `${parsed.host}${path}`;
}

interface ParsedStores {
  stores: StoreConfig[];
  documentDefault: string | undefined;
}

function parseStores(
  env: Env,
  globalReadOnly: boolean,
  readFile: (path: string) => string,
  issues: string[],
): ParsedStores {
  const stores: StoreConfig[] = [];
  let documentDefault: string | undefined;
  const inline = clean(env.WOOCOMMERCE_STORES);
  const file = clean(env.WOOCOMMERCE_STORES_FILE);
  const hasLegacy = clean(env.WOOCOMMERCE_URL) !== undefined;

  if (inline !== undefined && file !== undefined) {
    issues.push('WOOCOMMERCE_STORES: set WOOCOMMERCE_STORES or WOOCOMMERCE_STORES_FILE, not both');
    return { stores, documentDefault };
  }

  if (hasLegacy || (inline === undefined && file === undefined)) {
    const legacy = parseLegacyStore(env, globalReadOnly, issues);
    if (legacy) stores.push(legacy);
  }

  let documentText: string | undefined;
  let source = 'WOOCOMMERCE_STORES';
  if (inline !== undefined) documentText = inline;
  if (file !== undefined) {
    source = 'WOOCOMMERCE_STORES_FILE';
    try {
      documentText = readFile(file);
    } catch {
      issues.push(`WOOCOMMERCE_STORES_FILE: could not read ${file}`);
      return { stores, documentDefault };
    }
  }
  if (documentText !== undefined) {
    const document = parseStoresDocument(documentText, source, env, issues);
    stores.push(...document.stores);
    documentDefault = document.defaultStore;
  }

  const seen = new Set<string>();
  for (const store of stores) {
    const key = store.id.toLowerCase();
    if (seen.has(key)) issues.push(`${source}: duplicate store id "${store.id}"`);
    seen.add(key);
  }
  return { stores, documentDefault };
}

function parseStoresDocument(
  text: string,
  source: string,
  env: Env,
  issues: string[],
): { stores: StoreConfig[]; defaultStore: string | undefined } {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    issues.push(`${source}: must be valid JSON`);
    return { stores: [], defaultStore: undefined };
  }
  const parsed = storesDocumentSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
    issues.push(`${source}: ${issue?.message ?? 'is invalid'}${path}`);
    return { stores: [], defaultStore: undefined };
  }
  const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.stores;
  const defaultStore = Array.isArray(parsed.data) ? undefined : parsed.data.defaultStore;
  if (entries.length === 0) {
    issues.push(`${source}: must list at least one store`);
    return { stores: [], defaultStore };
  }
  const stores: StoreConfig[] = [];
  for (const entry of entries) {
    const label = `${source} store "${entry.id}"`;
    const url = parseStoreUrl(entry.url, `${label} url`, issues);
    const consumerKey = resolveSecret(entry.consumerKey, entry.consumerKeyEnv, env, `${label} consumerKey`, issues);
    const consumerSecret = resolveSecret(
      entry.consumerSecret,
      entry.consumerSecretEnv,
      env,
      `${label} consumerSecret`,
      issues,
    );
    if (url === undefined || consumerKey === undefined || consumerSecret === undefined) continue;
    stores.push({
      id: entry.id,
      label: entry.label ?? null,
      url,
      consumerKey,
      consumerSecret,
      apiVersion: entry.apiVersion ?? 'wc/v3',
      authMode: entry.authMode ?? defaultAuthMode(url),
      readOnly: entry.readOnly ?? true,
    });
  }
  return { stores, defaultStore };
}

function parseLegacyStore(env: Env, readOnly: boolean, issues: string[]): StoreConfig | undefined {
  const urlText = required(env, 'WOOCOMMERCE_URL', issues);
  const url = urlText === undefined ? undefined : parseStoreUrl(urlText, 'WOOCOMMERCE_URL', issues);
  const consumerKey = parseSecret(env, 'WOOCOMMERCE_CONSUMER_KEY', issues);
  const consumerSecret = parseSecret(env, 'WOOCOMMERCE_CONSUMER_SECRET', issues);
  const apiVersion = parseApiVersion(env, issues);
  const authMode = parseChoice(env, 'WOOCOMMERCE_AUTH_MODE', AUTH_MODES, issues);
  const id = clean(env.WOOCOMMERCE_STORE_ID) ?? 'default';
  if (!STORE_ID.test(id)) {
    issues.push('WOOCOMMERCE_STORE_ID: must be 1 to 40 letters, digits, dashes, or underscores');
    return undefined;
  }
  if (url === undefined || consumerKey === undefined || consumerSecret === undefined || apiVersion === undefined) {
    return undefined;
  }
  return {
    id,
    label: clean(env.WOOCOMMERCE_STORE_LABEL) ?? null,
    url,
    consumerKey,
    consumerSecret,
    apiVersion,
    authMode: authMode ?? defaultAuthMode(url),
    readOnly,
  };
}

function parseDefaultStore(
  env: Env,
  stores: StoreConfig[],
  documentDefault: string | undefined,
  issues: string[],
): string | undefined {
  const requested = clean(env.WOOCOMMERCE_DEFAULT_STORE) ?? documentDefault;
  if (stores.length === 0) return undefined;
  if (requested === undefined) return stores[0]?.id;
  const match = stores.find((store) => store.id.toLowerCase() === requested.toLowerCase());
  if (!match) {
    issues.push(`WOOCOMMERCE_DEFAULT_STORE: no store with id "${requested}"`);
    return undefined;
  }
  return match.id;
}

function resolveSecret(
  direct: string | undefined,
  envName: string | undefined,
  env: Env,
  label: string,
  issues: string[],
): string | undefined {
  if (direct !== undefined && envName !== undefined) {
    issues.push(`${label}: set the value or the Env reference, not both`);
    return undefined;
  }
  const value = envName !== undefined ? clean(env[envName]) : clean(direct);
  if (value === undefined) {
    issues.push(envName !== undefined ? `${label}: environment variable ${envName} is not set` : `${label}: is required`);
    return undefined;
  }
  const parsed = secretSchema.safeParse(value);
  if (!parsed.success) {
    issues.push(`${label}: ${firstIssue(parsed.error)}`);
    return undefined;
  }
  return parsed.data;
}

function parseHttpAuth(env: Env, issues: string[]): HttpAuthConfig | null {
  const tokens = parseList(env.MCP_HTTP_AUTH_TOKENS);
  const readTokens = parseList(env.MCP_HTTP_AUTH_READ_TOKENS);
  for (const [name, list] of [
    ['MCP_HTTP_AUTH_TOKENS', tokens],
    ['MCP_HTTP_AUTH_READ_TOKENS', readTokens],
  ] as const) {
    if (list.some((token) => token.length < MIN_TOKEN_LENGTH || /\s/.test(token))) {
      issues.push(`${name}: each token must be at least ${MIN_TOKEN_LENGTH} characters without whitespace`);
    }
  }

  const introspectionUrl = clean(env.MCP_OAUTH_INTROSPECTION_URL);
  let introspection: IntrospectionConfig | null = null;
  if (introspectionUrl !== undefined) {
    const url = parseHttpsUrl(introspectionUrl, 'MCP_OAUTH_INTROSPECTION_URL', issues);
    const clientId = required(env, 'MCP_OAUTH_CLIENT_ID', issues);
    const clientSecret = required(env, 'MCP_OAUTH_CLIENT_SECRET', issues);
    if (url !== undefined && clientId !== undefined && clientSecret !== undefined) {
      introspection = { url, clientId, clientSecret };
    }
  }
  const issuerText = clean(env.MCP_OAUTH_ISSUER);
  const issuer = issuerText === undefined ? null : (parseHttpsUrl(issuerText, 'MCP_OAUTH_ISSUER', issues) ?? null);
  const resourceText = clean(env.MCP_OAUTH_RESOURCE);
  const resource =
    resourceText === undefined ? null : (parseHttpsUrl(resourceText, 'MCP_OAUTH_RESOURCE', issues) ?? null);
  if (introspectionUrl !== undefined && issuer === null && issuerText === undefined) {
    issues.push('MCP_OAUTH_ISSUER: is required when MCP_OAUTH_INTROSPECTION_URL is set');
  }

  if (tokens.length === 0 && readTokens.length === 0 && introspectionUrl === undefined) return null;
  return {
    tokens,
    readTokens,
    introspection,
    issuer,
    resource,
    requiredScopes: parseList(env.MCP_OAUTH_REQUIRED_SCOPES),
  };
}

function parseHttpsUrl(value: string, name: string, issues: string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issues.push(`${name}: must be an absolute URL`);
    return undefined;
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    issues.push(`${name}: must use https (http is allowed for localhost only)`);
    return undefined;
  }
  return parsed.toString();
}

function parseList(value: string | undefined): string[] {
  const text = clean(value);
  if (text === undefined) return [];
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function required(env: Env, name: string, issues: string[]): string | undefined {
  const value = clean(env[name]);
  if (value === undefined) {
    issues.push(`${name}: is required`);
    return undefined;
  }
  return value;
}

function parseSecret(env: Env, name: string, issues: string[]): string | undefined {
  const value = required(env, name, issues);
  if (value === undefined) return undefined;
  const parsed = secretSchema.safeParse(value);
  if (!parsed.success) {
    issues.push(`${name}: ${firstIssue(parsed.error)}`);
    return undefined;
  }
  return parsed.data;
}

function parseFlag(env: Env, name: string, fallback: boolean, issues: string[]): boolean {
  const value = clean(env[name]);
  if (value === undefined) return fallback;
  const parsed = flagSchema.safeParse(value.toLowerCase());
  if (!parsed.success) {
    issues.push(`${name}: must be true or false`);
    return fallback;
  }
  return parsed.data === 'true' || parsed.data === '1' || parsed.data === 'yes' || parsed.data === 'on';
}

function parseChoice<T extends string>(env: Env, name: string, allowed: readonly T[], issues: string[]): T | undefined {
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
  env: Env,
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

function parseApiVersion(env: Env, issues: string[]): string | undefined {
  const value = clean(env.WOOCOMMERCE_API_VERSION);
  if (value === undefined) return 'wc/v3';
  const parsed = z.string().regex(/^wc\/v\d+$/, 'must look like wc/v3').safeParse(value);
  if (!parsed.success) {
    issues.push(`WOOCOMMERCE_API_VERSION: must look like wc/v3`);
    return undefined;
  }
  return parsed.data;
}

function parseHttpHost(env: Env, authenticated: boolean, issues: string[]): string | undefined {
  const value = clean(env.MCP_HTTP_HOST) ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(value) && !authenticated) {
    issues.push(
      'MCP_HTTP_HOST: binding beyond loopback requires bearer authentication (MCP_HTTP_AUTH_TOKENS or MCP_OAUTH_INTROSPECTION_URL)',
    );
    return undefined;
  }
  if (!/^[A-Za-z0-9.:_-]{1,253}$/.test(value)) {
    issues.push('MCP_HTTP_HOST: must be a hostname or IP address');
    return undefined;
  }
  return value;
}

function parseHttpPath(env: Env, issues: string[]): string | undefined {
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

function parseUserAgent(env: Env, issues: string[]): string | undefined {
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

function parseStoreUrl(value: string, name: string, issues: string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    issues.push(`${name}: must be an absolute http or https URL`);
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    issues.push(`${name}: must use http or https`);
    return undefined;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    issues.push(`${name}: must not include credentials`);
    return undefined;
  }
  if (parsed.hostname === '') {
    issues.push(`${name}: must include a host`);
    return undefined;
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    issues.push(`${name}: must not include a query string or hash`);
    return undefined;
  }
  if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
    parsed.port = '';
  }
  return parsed.toString().replace(/\/$/, '');
}

function defaultAuthMode(url: string): AuthMode {
  return url.startsWith('https:') ? 'basic' : 'oauth1';
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'is invalid';
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}
