export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ReadOnlyModeError extends Error {
  readonly code = 'read_only' as const;

  constructor(toolName: string, storeId?: string) {
    const target = storeId === undefined ? 'the server is' : `store "${storeId}" is`;
    super(
      `Refused to run ${toolName}: ${target} in read-only mode. Set WOOCOMMERCE_READ_ONLY=false (or readOnly: false for the store) to allow writes, and use a WooCommerce REST API key with read/write permission.`,
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

export interface PlannedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

/** Thrown by a planning client instead of sending a write. */
export class PlannedWrite extends Error {
  readonly request: PlannedRequest;

  constructor(request: PlannedRequest) {
    super(`Planned ${request.method} ${request.path}`);
    this.name = 'PlannedWrite';
    this.request = request;
  }
}

export class ForbiddenError extends Error {
  readonly code = 'insufficient_scope' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class UnknownStoreError extends Error {
  readonly code = 'unknown_store' as const;

  constructor(message: string) {
    super(message);
    this.name = 'UnknownStoreError';
  }
}

export class ToolDisabledError extends Error {
  readonly code = 'tool_disabled' as const;

  constructor(toolName: string, storeId: string) {
    super(`Refused to run ${toolName}: the tool is disabled for store "${storeId}" by its allowTools or denyTools setting.`);
    this.name = 'ToolDisabledError';
  }
}

export class PreviewMismatchError extends Error {
  readonly code = 'preview_mismatch' as const;

  constructor(toolName: string, storeId: string, previewId: string) {
    super(
      `Refused to run ${toolName}: previewId "${previewId}" does not match these arguments for store "${storeId}". Nothing was sent to the store. Repeat the exact previewed arguments, or call the tool without confirm to get a new preview.`,
    );
    this.name = 'PreviewMismatchError';
  }
}
