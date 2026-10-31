import type { ApprovalVerifier } from '../approval.js';
import type { AuditLog } from '../audit.js';
import type { StoreConfig, ToolFilter, TrackingMode } from '../config.js';
import type { WebhookEventStore } from '../webhooks.js';
import type { WooCommerceClient } from '../woocommerce/client.js';
import { UnknownStoreError } from '../woocommerce/errors.js';

/** Per-call context handed to a tool implementation, bound to one store. */
export interface ToolContext {
  client: WooCommerceClient;
  defaultPerPage: number;
  readOnly: boolean;
  storeId: string;
  events: WebhookEventStore;
  trackingMode: TrackingMode;
  /** True when the store has a webhook secret, so new webhooks can be signed with it. */
  webhookSecret: string | null;
}

export interface StoreHandle {
  config: StoreConfig;
  client: WooCommerceClient;
}

/** Everything the tool, resource, and prompt registrations share. */
export interface Runtime {
  stores: StoreHandle[];
  defaultStore: string;
  defaultPerPage: number;
  requireConfirmation: boolean;
  /** Set when WOOCOMMERCE_APPROVAL_SECRET is configured: confirmed writes need a signed approval. */
  approval: ApprovalVerifier | null;
  audit: AuditLog;
  /** True when the HTTP endpoint verifies bearer tokens, so scopes apply. */
  scopesEnforced: boolean;
  /** Tools registered on the server at all. Stores can narrow this further. */
  tools: ToolFilter;
  events: WebhookEventStore;
  trackingMode: TrackingMode;
}

export function resolveStore(runtime: Runtime, id: string | undefined): StoreHandle {
  const wanted = (id ?? runtime.defaultStore).toLowerCase();
  const match = runtime.stores.find((store) => store.config.id.toLowerCase() === wanted);
  if (!match) {
    const known = runtime.stores.map((store) => store.config.id).join(', ');
    throw new UnknownStoreError(`Unknown store "${id ?? ''}". Configured stores: ${known}.`);
  }
  return match;
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
