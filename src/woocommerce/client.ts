import type { AppConfig } from '../config.js';
import { createNonce, authorize } from './auth.js';
import { WooCommerceApiError } from './errors.js';
import { isRecord } from './json.js';
import { parseRetryAfter, readTotalHeader, type Pagination } from './pagination.js';

const MAX_BODY_CHARS = 5_000_000;
const MAX_RETRY_WAIT_MS = 10_000;

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface ApiResponse<T> {
  data: T;
  pagination: Pagination;
  status: number;
}

export interface ClientHooks {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  nonce?: () => string;
  timestamp?: () => number;
}

export class WooCommerceClient {
  constructor(
    private readonly options: AppConfig,
    private readonly hooks: ClientHooks = {},
  ) {}

  get<T = unknown>(path: string, query?: QueryParams): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, query, undefined);
  }

  post<T = unknown>(path: string, body?: unknown, query?: QueryParams): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, query, body ?? {});
  }

  put<T = unknown>(path: string, body?: unknown, query?: QueryParams): Promise<ApiResponse<T>> {
    return this.request<T>('PUT', path, query, body ?? {});
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    query: QueryParams | undefined,
    body: unknown,
  ): Promise<ApiResponse<T>> {
    const safePath = assertApiPath(path);
    let lastError: WooCommerceApiError | undefined;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        return await this.send<T>(method, safePath, query, body);
      } catch (error) {
        const mapped = this.asApiError(error);
        lastError = mapped;
        if (attempt >= this.options.maxRetries || !this.isRetryable(method, mapped)) {
          throw mapped;
        }
        await this.sleep(this.delayMs(mapped, attempt));
      }
    }
    throw lastError ?? new WooCommerceApiError('The WooCommerce request failed.', { code: 'network', status: 0 });
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    query: QueryParams | undefined,
    body: unknown,
  ): Promise<ApiResponse<T>> {
    if (this.options.debug) {
      console.error(`woocommerce-mcp ${method} ${path}`);
    }
    const params = normalizeQuery(query);
    const signed = authorize({
      method,
      url: `${this.options.url}/wp-json/${this.options.apiVersion}/${path}`,
      query: params,
      consumerKey: this.options.consumerKey,
      consumerSecret: this.options.consumerSecret,
      mode: this.options.authMode,
      timestamp: (this.hooks.timestamp ?? defaultTimestamp)(),
      nonce: (this.hooks.nonce ?? createNonce)(),
    });
    const headers = new Headers(signed.headers);
    headers.set('Accept', 'application/json');
    headers.set('User-Agent', this.options.userAgent);
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers.set('Content-Type', 'application/json');
    }

    const response = await (this.hooks.fetchImpl ?? fetch)(signed.url, {
      method,
      headers,
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    return this.readResponse<T>(response, query);
  }

  private async readResponse<T>(response: Response, query: QueryParams | undefined): Promise<ApiResponse<T>> {
    const text = await response.text();
    if (text.length > MAX_BODY_CHARS) {
      throw new WooCommerceApiError('The WooCommerce response exceeded 5 MB.', {
        code: 'response_too_large',
        status: response.status,
      });
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new WooCommerceApiError(
        `WooCommerce redirected the request (HTTP ${response.status}). Set WOOCOMMERCE_URL to the final store URL.`,
        { code: 'redirect', status: response.status },
      );
    }

    const parsed = parseJson(text);
    if (!response.ok) {
      throw this.httpError(response, parsed, text);
    }
    if (text.trim() !== '' && parsed === undefined) {
      throw new WooCommerceApiError('WooCommerce returned a response that was not valid JSON.', {
        code: 'invalid_response',
        status: response.status,
      });
    }

    const paging = requestedPaging(query);
    return {
      data: (parsed ?? null) as T,
      status: response.status,
      pagination: {
        page: paging.page,
        perPage: paging.perPage,
        total: readTotalHeader(response.headers, 'x-wp-total'),
        totalPages: readTotalHeader(response.headers, 'x-wp-totalpages'),
      },
    };
  }

  private httpError(response: Response, parsed: unknown, raw: string): WooCommerceApiError {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), (this.hooks.now ?? Date.now)());
    if (isRecord(parsed) && typeof parsed.message === 'string') {
      const code =
        typeof parsed.code === 'string' && parsed.code.trim() !== '' ? parsed.code : defaultHttpCode(response.status);
      const data = isRecord(parsed.data) ? this.scrubUnknown(parsed.data) : undefined;
      return new WooCommerceApiError(this.scrub(parsed.message), {
        code,
        status: response.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(data !== undefined ? { data } : {}),
      });
    }
    const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
    const message =
      snippet === ''
        ? `WooCommerce request failed with HTTP ${response.status}.`
        : `WooCommerce request failed with HTTP ${response.status}: ${this.scrub(snippet)}`;
    return new WooCommerceApiError(message, {
      code: defaultHttpCode(response.status),
      status: response.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  // GET retries rate limits, timeouts, and gateway failures.
  // Writes retry only on 429, where the store rejected the call before applying it.
  // A Retry-After above 10 seconds is returned to the caller instead of blocking the tool.
  private isRetryable(method: string, error: WooCommerceApiError): boolean {
    if (error.retryAfterMs !== undefined && error.retryAfterMs > MAX_RETRY_WAIT_MS) return false;
    if (error.status === 429) return true;
    if (method !== 'GET') return false;
    if (error.status === 502 || error.status === 503 || error.status === 504) return true;
    return error.code === 'timeout' || error.code === 'network';
  }

  private delayMs(error: WooCommerceApiError, attempt: number): number {
    const backoff = Math.min(MAX_RETRY_WAIT_MS, 250 * 2 ** attempt);
    const base = error.retryAfterMs ?? backoff;
    const jitter = Math.floor((this.hooks.random ?? Math.random)() * 100);
    return base + jitter;
  }

  private async sleep(ms: number): Promise<void> {
    await (this.hooks.sleep ?? defaultSleep)(Math.max(0, ms));
  }

  private asApiError(error: unknown): WooCommerceApiError {
    if (error instanceof WooCommerceApiError) {
      return new WooCommerceApiError(this.scrub(error.message), {
        code: error.code,
        status: error.status,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        ...(error.data !== undefined ? { data: this.scrubUnknown(error.data) } : {}),
      });
    }
    if (isTimeoutError(error)) {
      return new WooCommerceApiError('The WooCommerce request timed out.', { code: 'timeout', status: 0 });
    }
    return new WooCommerceApiError('Could not reach the WooCommerce store.', { code: 'network', status: 0 });
  }

  private scrub(message: string): string {
    return scrubText(message, [this.options.consumerKey, this.options.consumerSecret]);
  }

  private scrubUnknown(value: unknown): unknown {
    return scrubValue(value, [this.options.consumerKey, this.options.consumerSecret], 0);
  }
}

function assertApiPath(path: string): string {
  if (path.length === 0 || path.startsWith('/') || path.includes('..') || path.includes('://') || path.includes('?') || path.includes('#')) {
    throw new WooCommerceApiError('Refused to call an unsafe API path.', { code: 'invalid_path', status: 0 });
  }
  return path;
}

function normalizeQuery(query: QueryParams | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  if (!query) return output;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    output[key] = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  }
  return output;
}

function requestedPaging(query: QueryParams | undefined): { page: number | null; perPage: number | null } {
  return {
    page: asQueryInt(query?.page),
    perPage: asQueryInt(query?.per_page),
  };
}

function asQueryInt(value: string | number | boolean | undefined): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function defaultHttpCode(status: number): string {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  return `http_${status}`;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

function scrubText(message: string, secrets: readonly string[]): string {
  let output = message;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    output = output.split(secret).join('[redacted]');
  }
  return output;
}

function scrubValue(value: unknown, secrets: readonly string[], depth: number): unknown {
  if (depth > 20) return null;
  if (typeof value === 'string') return scrubText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, secrets, depth + 1));
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = scrubValue(child, secrets, depth + 1);
  }
  return output;
}
