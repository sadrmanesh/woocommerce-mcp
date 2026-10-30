import type { AppConfig } from '../src/config.js';
import type { ToolContext } from '../src/tools/context.js';
import { WooCommerceClient, type ClientHooks } from '../src/woocommerce/client.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    url: 'https://store.example.com',
    consumerKey: 'ck_test_key',
    consumerSecret: 'cs_test_secret',
    apiVersion: 'wc/v3',
    readOnly: true,
    timeoutMs: 5_000,
    maxRetries: 2,
    defaultPerPage: 10,
    authMode: 'basic',
    userAgent: 'woocommerce-mcp/0.1.0',
    debug: false,
    transport: 'stdio',
    httpHost: '127.0.0.1',
    httpPort: 3_000,
    httpPath: '/mcp',
    ...overrides,
  };
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
  overrides: Partial<AppConfig> = {},
  hooks: ClientHooks = {},
): WooCommerceClient {
  return new WooCommerceClient(testConfig(overrides), {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
    nonce: () => 'nonce1234567890nonce1234567890',
    timestamp: () => 1_700_000_000,
    ...hooks,
  });
}

export function toolContext(
  client: WooCommerceClient,
  overrides: { readOnly?: boolean; defaultPerPage?: number } = {},
): ToolContext {
  return {
    client,
    readOnly: overrides.readOnly ?? true,
    defaultPerPage: overrides.defaultPerPage ?? 10,
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
