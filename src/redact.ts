import { isRecord } from './woocommerce/json.js';

const REDACTED = '[redacted]';

/** Keys whose values identify a person. Compared after removing case, dashes, and underscores. */
const PERSONAL_KEYS = new Set([
  'firstname',
  'lastname',
  'company',
  'address1',
  'address2',
  'postcode',
  'username',
  'displayname',
  'customername',
  'fullname',
  'customeripaddress',
  'customeruseragent',
  'avatarurl',
]);

const EMAIL_KEYS = new Set(['email', 'billingemail']);
const PHONE_KEYS = new Set(['phone', 'billingphone', 'shippingphone']);
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** Keeps the first character and the domain: `j***@example.com`. */
export function maskEmail(value: string): string {
  return value.replace(EMAIL_PATTERN, (match: string, domain: string) => `${match.charAt(0)}***@${domain}`);
}

/** Keeps the last two digits: `***42`. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return value === '' ? value : REDACTED;
  return `***${digits.slice(-2)}`;
}

/**
 * Returns a copy of a tool or resource result with customer personal data masked:
 * names, companies, street addresses, postcodes, usernames, IP addresses, and user agents are
 * replaced, email addresses keep their first character and domain, and phone numbers keep their
 * last two digits. City, state, and country stay, so results remain useful for analysis.
 * Email addresses inside free text, such as order notes, are masked too.
 */
export function redactPersonalData(value: unknown, depth = 0): unknown {
  if (depth > 40) return null;
  if (typeof value === 'string') return maskEmail(value);
  if (Array.isArray(value)) return value.map((item) => redactPersonalData(item, depth + 1));
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (typeof child === 'string' && child !== '') {
      if (PERSONAL_KEYS.has(normalized)) {
        output[key] = REDACTED;
        continue;
      }
      if (PHONE_KEYS.has(normalized)) {
        output[key] = maskPhone(child);
        continue;
      }
      if (EMAIL_KEYS.has(normalized)) {
        output[key] = maskEmail(child);
        continue;
      }
    }
    output[key] = redactPersonalData(child, depth + 1);
  }
  return output;
}
