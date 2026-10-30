import { WooCommerceApiError } from './errors.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asDecimal(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function asCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new WooCommerceApiError(`Expected ${label} to be a JSON object.`, {
      code: 'invalid_response',
      status: 0,
    });
  }
  return value;
}

export function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new WooCommerceApiError(`Expected ${label} to be a JSON array.`, {
      code: 'invalid_response',
      status: 0,
    });
  }
  return value;
}

export function stripLinks(value: unknown, depth = 0): unknown {
  if (depth > 40) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripLinks(item, depth + 1));
  }
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '_links') continue;
    output[key] = stripLinks(child, depth + 1);
  }
  return output;
}

export function compact(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}
