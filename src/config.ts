import { readFileSync } from 'node:fs';

import * as z from 'zod/v4';

import { DEFAULT_APPROVAL_TTL_SECONDS, MIN_APPROVAL_SECRET_LENGTH } from './approval.js';
import { matchesToolPattern, TOOL_NAMES } from './tools/names.js';
import { VERSION } from './version.js';
import { AUTH_MODES, type AuthMode } from './woocommerce/auth.js';
import { ConfigError } from './woocommerce/errors.js';

const TRANSPORTS = ['stdio', 'http'] as const;
export type TransportMode = (typeof TRANSPORTS)[number];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const STORE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const MIN_TOKEN_LENGTH = 24;
const MIN_WEBHOOK_SECRET_LENGTH = 16;
const TRACKING_MODES = ['meta', 'shipment-tracking'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

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
  /** Mask customer personal data in every tool and resource result for this store. */
  redactPii: boolean;
  /** Shared secret WooCommerce signs webhook deliveries with, or null when the receiver is off for this store. */
  webhookSecret: string | null;
  /** Tool name patterns allowed and denied for this store. An empty allow list allows every tool. */
  tools: ToolFilter;
}

export interface ToolFilter {
  allow: string[];
  deny: string[];
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
  /** Sustained requests per second to this store. 0 turns the limiter off. */
  rateLimit: number;
  /** Requests that may be sent at once before the rate limit applies. */
  rateBurst: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** How long GET responses are reused. 0 turns the cache off. */
  cacheTtlMs: number;
  cacheMaxEntries: number;
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
  /**
   * Secret that approval tokens are signed with. When set, every confirmed
   * write needs a signed approval token. Null keeps the 0.5 behavior.
   */
  approvalSecret: string | null;
  /** Longest lifetime of an approval token the server accepts, in seconds. */
  approvalTtlSeconds: number;
  auditLog: string | null;
  telemetry: boolean;
  transport: TransportMode;
  httpHost: string;
  httpPort: number;
  httpPath: string;
  httpAllowedHosts: string[];
  httpAllowedOrigins: string[];
  httpAuth: HttpAuthConfig | null;
  rateLimit: number;
  rateBurst: number;
  retryBaseMs: number;
  retryMaxMs: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  /** Tool name patterns registered at all. An empty allow list allows every tool. */
  tools: ToolFilter;
  webhookPath: string;
  webhookBuffer: number;
  trackingMode: TrackingMode;
}

const toolPatternSchema = z.string().regex(/^[a-z0-9_*]{1,80}$/, 'must be a tool name or a pattern with *');

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
    redactPii: z.boolean().optional(),
    webhookSecret: z.string().optional(),
    webhookSecretEnv: z.string().optional(),
    allowTools: z.array(toolPatternSchema).max(200).optional(),
    denyTools: z.array(toolPatternSchema).max(200).optional(),
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
  const approvalSecret = parseApprovalSecret(env, issues);
  const approvalTtlSeconds = parseIntInRange(
    env,
    'WOOCOMMERCE_APPROVAL_TTL_SECONDS',
    DEFAULT_APPROVAL_TTL_SECONDS,
    30,
    3_600,
    issues,
  );
  const httpAuth = parseHttpAuth(env, issues);
  const httpHost = parseHttpHost(env, httpAuth !== null, issues);
  const httpAllowedHosts = parseList(env.MCP_HTTP_ALLOWED_HOSTS);
  const httpAllowedOrigins = parseList(env.MCP_HTTP_ALLOWED_ORIGINS);
  const redactPii = parseFlag(env, 'WOOCOMMERCE_REDACT_PII', false, issues);
  const rateLimit = parseIntInRange(env, 'WOOCOMMERCE_RATE_LIMIT', 5, 0, 1_000, issues);
  const rateBurst = parseIntInRange(env, 'WOOCOMMERCE_RATE_BURST', 10, 1, 1_000, issues);
  const retryBaseMs = parseIntInRange(env, 'WOOCOMMERCE_RETRY_BASE_MS', 250, 10, 10_000, issues);
  const retryMaxMs = parseIntInRange(env, 'WOOCOMMERCE_RETRY_MAX_MS', 10_000, 100, 60_000, issues);
  const cacheTtlMs = parseIntInRange(env, 'WOOCOMMERCE_CACHE_TTL_MS', 0, 0, 3_600_000, issues);
  const cacheMaxEntries = parseIntInRange(env, 'WOOCOMMERCE_CACHE_MAX_ENTRIES', 500, 1, 100_000, issues);
  const webhookBuffer = parseIntInRange(env, 'WOOCOMMERCE_WEBHOOK_BUFFER', 200, 1, 10_000, issues);
  const webhookPath = parsePath(env, 'WOOCOMMERCE_WEBHOOK_PATH', '/webhooks/woocommerce', issues);
  const trackingMode = parseChoice(env, 'WOOCOMMERCE_TRACKING_MODE', TRACKING_MODES, issues) ?? 'meta';
  const tools = parseToolFilter(
    parseList(env.WOOCOMMERCE_TOOLS_ALLOW),
    parseList(env.WOOCOMMERCE_TOOLS_DENY),
    'WOOCOMMERCE_TOOLS_ALLOW / WOOCOMMERCE_TOOLS_DENY',
    issues,
  );

  const { stores, documentDefault } = parseStores(env, { readOnly: globalReadOnly, redactPii }, readFile, issues);
  const defaultStore = parseDefaultStore(env, stores, documentDefault, issues);

  if (webhookPath !== undefined && httpPath !== undefined && webhookPath === httpPath) {
    issues.push('WOOCOMMERCE_WEBHOOK_PATH: must differ from MCP_HTTP_PATH');
  }
  if (retryBaseMs !== undefined && retryMaxMs !== undefined && retryBaseMs > retryMaxMs) {
    issues.push('WOOCOMMERCE_RETRY_BASE_MS: must not exceed WOOCOMMERCE_RETRY_MAX_MS');
  }

  if (
    issues.length > 0 ||
    timeoutMs === undefined ||
    maxRetries === undefined ||
    defaultPerPage === undefined ||
    httpHost === undefined ||
    httpPort === undefined ||
    httpPath === undefined ||
    userAgent === undefined ||
    defaultStore === undefined ||
    rateLimit === undefined ||
    rateBurst === undefined ||
    retryBaseMs === undefined ||
    retryMaxMs === undefined ||
    cacheTtlMs === undefined ||
    cacheMaxEntries === undefined ||
    webhookBuffer === undefined ||
    webhookPath === undefined ||
    approvalTtlSeconds === undefined
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
    approvalSecret,
    approvalTtlSeconds,
    auditLog,
    telemetry,
    transport,
    httpHost,
    httpPort,
    httpPath,
    httpAllowedHosts,
    httpAllowedOrigins,
    httpAuth,
    rateLimit,
    rateBurst,
    retryBaseMs,
    retryMaxMs,
    cacheTtlMs,
    cacheMaxEntries,
    tools,
    webhookPath,
    webhookBuffer,
    trackingMode,
  };
}

/** True when a tool passes an allow and deny filter. Deny wins over allow. */
export function toolAllowed(filter: ToolFilter, name: string): boolean {
  if (filter.deny.some((pattern) => matchesToolPattern(pattern, name))) return false;
  return filter.allow.length === 0 || filter.allow.some((pattern) => matchesToolPattern(pattern, name));
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
    rateLimit: config.rateLimit,
    rateBurst: config.rateBurst,
    retryBaseMs: config.retryBaseMs,
    retryMaxMs: config.retryMaxMs,
    cacheTtlMs: config.cacheTtlMs,
    cacheMaxEntries: config.cacheMaxEntries,
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
  if (config.approvalSecret !== null && !config.requireConfirmation) {
    warnings.push(
      'WOOCOMMERCE_REQUIRE_CONFIRMATION=false is ignored while WOOCOMMERCE_APPROVAL_SECRET is set: every write needs a preview and a signed approval.',
    );
  }
  if (config.transport !== 'http' && config.stores.some((store) => store.webhookSecret !== null)) {
    warnings.push('A webhook secret is configured, but the webhook receiver only runs with MCP_TRANSPORT=http.');
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

interface StoreDefaults {
  readOnly: boolean;
  redactPii: boolean;
}

function parseStores(
  env: Env,
  defaults: StoreDefaults,
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
    const legacy = parseLegacyStore(env, defaults, issues);
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
    const document = parseStoresDocument(documentText, source, env, defaults, issues);
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
  defaults: StoreDefaults,
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
    const webhookSecret = resolveOptionalSecret(
      entry.webhookSecret,
      entry.webhookSecretEnv,
      env,
      `${label} webhookSecret`,
      issues,
    );
    const tools = parseToolFilter(entry.allowTools ?? [], entry.denyTools ?? [], `${label} allowTools / denyTools`, issues);
    if (url === undefined || consumerKey === undefined || consumerSecret === undefined || webhookSecret === undefined) {
      continue;
    }
    stores.push({
      id: entry.id,
      label: entry.label ?? null,
      url,
      consumerKey,
      consumerSecret,
      apiVersion: entry.apiVersion ?? 'wc/v3',
      authMode: entry.authMode ?? defaultAuthMode(url),
      readOnly: entry.readOnly ?? true,
      redactPii: entry.redactPii ?? defaults.redactPii,
      webhookSecret,
      tools,
    });
  }
  return { stores, defaultStore };
}

function parseLegacyStore(env: Env, defaults: StoreDefaults, issues: string[]): StoreConfig | undefined {
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
  const webhookSecret = resolveOptionalSecret(
    clean(env.WOOCOMMERCE_WEBHOOK_SECRET),
    undefined,
    env,
    'WOOCOMMERCE_WEBHOOK_SECRET',
    issues,
  );
  if (
    url === undefined ||
    consumerKey === undefined ||
    consumerSecret === undefined ||
    apiVersion === undefined ||
    webhookSecret === undefined
  ) {
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
    readOnly: defaults.readOnly,
    redactPii: defaults.redactPii,
    webhookSecret,
    tools: { allow: [], deny: [] },
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

/** Returns null when no secret is set, undefined when the setting is invalid. */
function resolveOptionalSecret(
  direct: string | undefined,
  envName: string | undefined,
  env: Env,
  label: string,
  issues: string[],
): string | null | undefined {
  if (direct === undefined && envName === undefined) return null;
  const value = resolveSecret(direct, envName, env, label, issues);
  if (value === undefined) return undefined;
  if (value.length < MIN_WEBHOOK_SECRET_LENGTH) {
    issues.push(`${label}: must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`);
    return undefined;
  }
  return value;
}

function parseToolFilter(allow: string[], deny: string[], label: string, issues: string[]): ToolFilter {
  for (const pattern of [...allow, ...deny]) {
    if (!toolPatternSchema.safeParse(pattern).success) {
      issues.push(`${label}: "${pattern}" must be a tool name or a pattern with *`);
      continue;
    }
    if (!TOOL_NAMES.some((name) => matchesToolPattern(pattern, name))) {
      issues.push(`${label}: "${pattern}" does not match any tool`);
    }
  }
  return { allow, deny };
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

/** Reads WOOCOMMERCE_APPROVAL_SECRET. The value is never included in an error message. */
function parseApprovalSecret(env: Env, issues: string[]): string | null {
  const value = clean(env.WOOCOMMERCE_APPROVAL_SECRET);
  if (value === undefined) return null;
  if (value.length < MIN_APPROVAL_SECRET_LENGTH || value.length > 512 || /\s/.test(value)) {
    issues.push(
      `WOOCOMMERCE_APPROVAL_SECRET: must be ${MIN_APPROVAL_SECRET_LENGTH} to 512 characters without whitespace, for example the output of openssl rand -base64 32`,
    );
    return null;
  }
  return value;
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
  return parsePath(env, 'MCP_HTTP_PATH', '/mcp', issues);
}

function parsePath(env: Env, name: string, fallback: string, issues: string[]): string | undefined {
  const raw = clean(env[name]) ?? fallback;
  const value = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  const parsed = z
    .string()
    .regex(/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/, 'must be an absolute path such as /mcp')
    .safeParse(value);
  if (!parsed.success) {
    issues.push(`${name}: must be an absolute path such as ${fallback}`);
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
