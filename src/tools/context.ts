import type { WooCommerceClient } from '../woocommerce/client.js';

export interface ToolContext {
  client: WooCommerceClient;
  defaultPerPage: number;
  readOnly: boolean;
}

export interface Page<T> {
  items: T[];
  pagination: {
    page: number;
    perPage: number;
    total: number | null;
    totalPages: number | null;
  };
}

export function pageQuery(
  input: { page?: number; perPage?: number },
  defaultPerPage: number,
): { page: number; per_page: number } {
  return {
    page: input.page ?? 1,
    per_page: input.perPage ?? defaultPerPage,
  };
}
