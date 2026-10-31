import { type AuditLog, memoryAuditLog } from '../src/audit.js';
import { type AppConfig, type ClientOptions, clientOptions, type StoreConfig } from '../src/config.js';
import { createRuntime } from '../src/server.js';
import type { Runtime, ToolContext } from '../src/tools/context.js';
import { WebhookEventStore } from '../src/webhooks.js';
import { WooCommerceClient, type ClientHooks } from '../src/woocommerce/client.js';

export function testStore(overrides: Partial<StoreConfig> = {}): StoreConfig {
  return {
    id: 'default',
    label: null,
    url: 'https://store.example.com',
    consumerKey: 'ck_test_key',
    consumerSecret: 'cs_test_secret',
    apiVersion: 'wc/v3',
    authMode: 'basic',
    readOnly: true,
    redactPii: false,
    webhookSecret: null,
    tools: { allow: [], deny: [] },
    ...overrides,
  };
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    stores: [testStore()],
    defaultStore: 'default',
    timeoutMs: 5_000,
    maxRetries: 2,
    defaultPerPage: 10,
    userAgent: 'woocommerce-mcp/0.5.0',
    debug: false,
    requireConfirmation: true,
    auditLog: null,
    telemetry: false,
    transport: 'stdio',
    httpHost: '127.0.0.1',
    httpPort: 3_000,
    httpPath: '/mcp',
    httpAllowedHosts: [],
    httpAllowedOrigins: [],
    httpAuth: null,
    rateLimit: 0,
    rateBurst: 10,
    retryBaseMs: 250,
    retryMaxMs: 10_000,
    cacheTtlMs: 0,
    cacheMaxEntries: 500,
    tools: { allow: [], deny: [] },
    webhookPath: '/webhooks/woocommerce',
    webhookBuffer: 200,
    trackingMode: 'meta',
    ...overrides,
  };
}

export function testClientOptions(overrides: Partial<ClientOptions> = {}): ClientOptions {
  return { ...clientOptions(testConfig(), testStore()), ...overrides };
}

export const testHooks = (fetchImpl: typeof fetch): ClientHooks => ({
  fetchImpl,
  sleep: async () => undefined,
  random: () => 0,
  nonce: () => 'nonce1234567890nonce1234567890',
  timestamp: () => 1_700_000_000,
});

/** Builds a tool runtime whose stores all talk to the given fetch mock. */
export function testRuntime(
  fetchImpl: typeof fetch,
  overrides: Partial<AppConfig> = {},
  options: { audit?: AuditLog; scopesEnforced?: boolean } = {},
): Runtime & { audit: AuditLog } {
  return createRuntime(testConfig(overrides), {
    hooks: testHooks(fetchImpl),
    audit: options.audit ?? memoryAuditLog(),
    ...(options.scopesEnforced !== undefined ? { scopesEnforced: options.scopesEnforced } : {}),
  });
}

export const validEnv: Record<string, string> = {
  WOOCOMMERCE_URL: 'https://store.example.com',
  WOOCOMMERCE_CONSUMER_KEY: 'ck_test_key',
  WOOCOMMERCE_CONSUMER_SECRET: 'cs_test_secret',
};

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

export function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers,
  });
}

export function createFetchMock(
  handler: (request: RecordedRequest, attempt: number) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const request: RecordedRequest = {
      url,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers,
      body,
    };
    requests.push(request);
    return handler(request, requests.length);
  };
  return { fetchImpl, requests };
}

export function clientWith(
  fetchImpl: typeof fetch,
  overrides: Partial<ClientOptions> = {},
  hooks: ClientHooks = {},
): WooCommerceClient {
  return new WooCommerceClient(testClientOptions(overrides), { ...testHooks(fetchImpl), ...hooks });
}

export function toolContext(
  client: WooCommerceClient,
  overrides: Partial<Omit<ToolContext, 'client'>> = {},
): ToolContext {
  return {
    client,
    readOnly: true,
    defaultPerPage: 10,
    storeId: 'default',
    events: new WebhookEventStore(50),
    trackingMode: 'meta',
    webhookSecret: null,
    ...overrides,
  };
}

export function queryParam(url: string, name: string): string | null {
  const query = url.split('?')[1] ?? '';
  for (const part of query.split('&')) {
    if (part === '') continue;
    const separator = part.indexOf('=');
    const rawKey = separator === -1 ? part : part.slice(0, separator);
    const rawValue = separator === -1 ? '' : part.slice(separator + 1);
    if (decodeURIComponent(rawKey) === name) return decodeURIComponent(rawValue);
  }
  return null;
}

export function resultText(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = result.content?.[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected a text result');
  }
  return block.text;
}
