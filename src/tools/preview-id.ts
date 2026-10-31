import { createHash } from 'node:crypto';

/**
 * Serializes a value with object keys sorted and undefined members dropped,
 * so the same arguments always give the same text regardless of key order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Preview id for a write: `pv_` and the first 16 hex characters of the
 * SHA-256 of the tool name, store id, and canonical arguments. It is a
 * fingerprint, not a secret or a one-time token: the same call always gets
 * the same id, so it needs no server-side state and survives restarts.
 */
export function previewIdFor(tool: string, store: string, args: Record<string, unknown>): string {
  const digest = createHash('sha256').update(`${tool}\n${store}\n${canonicalJson(args)}`).digest('hex');
  return `pv_${digest.slice(0, 16)}`;
}
