import type { CallToolResult } from '@modelcontextprotocol/server';

import {
  ForbiddenError,
  InputError,
  PreviewMismatchError,
  ReadOnlyModeError,
  ToolDisabledError,
  UnknownStoreError,
  WooCommerceApiError,
} from '../woocommerce/errors.js';
import type { ToolContext } from './context.js';

export type ToolResult = CallToolResult;

export interface ErrorPayload {
  error: {
    message: string;
    code: string;
    status?: number;
    retryAfterMs?: number;
    details?: unknown;
  };
}

/** Runs one tool body against a store context and maps errors to a tool error result. */
export async function execute<T>(
  ctx: ToolContext,
  name: string,
  write: boolean,
  fn: () => Promise<T>,
): Promise<ToolResult> {
  try {
    if (write && ctx.readOnly) {
      throw new ReadOnlyModeError(name);
    }
    return jsonResult(await fn());
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(serializeError(error), null, 2) }],
    };
  }
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function serializeError(error: unknown): ErrorPayload {
  if (
    error instanceof ReadOnlyModeError ||
    error instanceof InputError ||
    error instanceof ForbiddenError ||
    error instanceof PreviewMismatchError ||
    error instanceof UnknownStoreError ||
    error instanceof ToolDisabledError
  ) {
    return { error: { message: error.message, code: error.code } };
  }
  if (error instanceof WooCommerceApiError) {
    return {
      error: {
        message: error.message,
        code: error.code,
        status: error.status,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        ...(error.data !== undefined ? { details: error.data } : {}),
      },
    };
  }
  if (error instanceof Error && error.message.trim() !== '') {
    return { error: { message: error.message, code: 'internal_error' } };
  }
  return { error: { message: 'Unexpected error.', code: 'internal_error' } };
}
