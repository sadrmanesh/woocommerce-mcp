export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ReadOnlyModeError extends Error {
  readonly code = 'read_only' as const;

  constructor(toolName: string) {
    super(
      `Refused to run ${toolName}: the server is in read-only mode. Set WOOCOMMERCE_READ_ONLY=false to allow writes, and use a WooCommerce REST API key with read/write permission.`,
    );
    this.name = 'ReadOnlyModeError';
  }
}

export class InputError extends Error {
  readonly code = 'invalid_input' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

export interface WooCommerceApiErrorOptions {
  code: string;
  status: number;
  retryAfterMs?: number;
  data?: unknown;
}

export class WooCommerceApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly data?: unknown;

  constructor(message: string, options: WooCommerceApiErrorOptions) {
    super(message);
    this.name = 'WooCommerceApiError';
    this.code = options.code;
    this.status = options.status;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.data !== undefined) {
      this.data = options.data;
    }
  }
}
