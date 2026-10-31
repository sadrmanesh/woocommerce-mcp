import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Prefix of every approval token, and the version of the format. */
export const APPROVAL_TOKEN_PREFIX = 'wmcp1';
/** Default and maximum lifetime of an approval token, in seconds. */
export const DEFAULT_APPROVAL_TTL_SECONDS = 600;
/** Shortest approval secret the server accepts. */
export const MIN_APPROVAL_SECRET_LENGTH = 32;
/** Longest token the server will try to parse. */
export const MAX_APPROVAL_TOKEN_LENGTH = 2048;
/** Clock skew allowed between the signer and the server, in seconds. */
export const APPROVAL_CLOCK_SKEW_SECONDS = 30;

const TOKEN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** What an approval token says: who may run which previewed change, and until when. */
export interface ApprovalClaims {
  /** Format version. Always 1. */
  v: 1;
  /** The full previewId the approver reviewed, including its state part. */
  previewId: string;
  /** Tool name, such as woocommerce_bulk_adjust_prices. */
  tool: string;
  /** Store id the change is for. */
  store: string;
  /** Issued at, Unix seconds. */
  iat: number;
  /** Expires at, Unix seconds. */
  exp: number;
  /** Random token id. A token id is accepted once. */
  jti: string;
  /** Optional label of the person or system that approved, for the audit log. */
  by?: string;
}

export interface SignApprovalOptions {
  previewId: string;
  tool: string;
  store: string;
  /** Lifetime in seconds. Defaults to 600. */
  ttlSeconds?: number;
  by?: string;
  /** Current time in Unix seconds. Defaults to the system clock. */
  now?: number;
  /** Token id. Defaults to 16 random bytes, base64url encoded. */
  jti?: string;
}

/**
 * Signs an approval token:
 * `wmcp1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(secret, "wmcp1." + base64url(JSON claims)))>`.
 * Any system that holds the secret can produce the same format.
 */
export function signApproval(secret: string, options: SignApprovalOptions): { token: string; claims: ApprovalClaims } {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS;
  const claims: ApprovalClaims = {
    v: 1,
    previewId: options.previewId,
    tool: options.tool,
    store: options.store,
    iat: now,
    exp: now + ttl,
    jti: options.jti ?? randomBytes(16).toString('base64url'),
    ...(options.by !== undefined && options.by !== '' ? { by: options.by } : {}),
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signed = `${APPROVAL_TOKEN_PREFIX}.${payload}`;
  return { token: `${signed}.${mac(secret, signed).toString('base64url')}`, claims };
}

function mac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data, 'utf8').digest();
}

export type ApprovalFailure = 'approval_required' | 'approval_invalid' | 'approval_expired' | 'approval_mismatch' | 'approval_replayed';

export class ApprovalError extends Error {
  readonly code: ApprovalFailure;
  /** Token id, when the token was well formed and correctly signed. */
  readonly tokenId: string | undefined;
  readonly by: string | undefined;

  constructor(code: ApprovalFailure, message: string, claims?: ApprovalClaims) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    this.tokenId = claims?.jti;
    this.by = claims?.by;
  }
}

/** What a confirm must be bound to. */
export interface ApprovalTarget {
  previewId: string;
  tool: string;
  store: string;
}

export interface ApprovalVerifierOptions {
  secret: string;
  /** Longest lifetime the server accepts, in seconds. */
  maxTtlSeconds?: number;
  /** Current time in Unix seconds, for tests. */
  now?: () => number;
}

/**
 * Checks approval tokens and remembers the ids of tokens already presented,
 * so each is accepted once. Ids are kept in memory until their token expires.
 */
export class ApprovalVerifier {
  readonly maxTtlSeconds: number;
  private readonly secret: string;
  private readonly now: () => number;
  private readonly used = new Map<string, number>();

  constructor(options: ApprovalVerifierOptions) {
    this.secret = options.secret;
    this.maxTtlSeconds = options.maxTtlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Verifies a token for one confirm and spends it. Runs synchronously, so two
   * concurrent confirms with the same token cannot both pass.
   */
  consume(token: string | undefined, target: ApprovalTarget): ApprovalClaims {
    const action = `Refused to run ${target.tool}`;
    if (token === undefined || token.trim() === '') {
      throw new ApprovalError(
        'approval_required',
        `${action}: this server requires a signed approval for every write. Nothing was sent to the store. Show the preview to the user and ask them to approve previewId "${target.previewId}" out of band (for example with: woocommerce-mcp approve ${target.previewId}), then call the tool again with confirm: true, the previewId, and the approval token they give you.`,
      );
    }
    const claims = this.parse(token.trim());
    if (claims === null) {
      throw new ApprovalError('approval_invalid', `${action}: the approval token is malformed or its signature does not verify. Nothing was sent to the store.`);
    }
    const now = this.now();
    if (claims.exp <= now) {
      throw new ApprovalError('approval_expired', `${action}: the approval token expired. Nothing was sent to the store. Ask the user for a new approval.`, claims);
    }
    if (claims.iat > now + APPROVAL_CLOCK_SKEW_SECONDS || claims.exp - claims.iat > this.maxTtlSeconds) {
      throw new ApprovalError(
        'approval_invalid',
        `${action}: the approval token is valid for longer than this server allows (${this.maxTtlSeconds} seconds) or was issued in the future. Nothing was sent to the store.`,
        claims,
      );
    }
    if (claims.previewId !== target.previewId || claims.tool !== target.tool || claims.store.toLowerCase() !== target.store.toLowerCase()) {
      throw new ApprovalError(
        'approval_mismatch',
        `${action}: the approval token was issued for a different previewId, tool, or store. Nothing was sent to the store. An approval only covers the exact preview the user reviewed.`,
        claims,
      );
    }
    this.prune(now);
    if (this.used.has(claims.jti)) {
      throw new ApprovalError('approval_replayed', `${action}: this approval token was already used. Nothing was sent to the store. Each approval applies once.`, claims);
    }
    this.used.set(claims.jti, claims.exp);
    return claims;
  }

  private prune(now: number): void {
    for (const [id, exp] of this.used) if (exp <= now) this.used.delete(id);
  }

  private parse(token: string): ApprovalClaims | null {
    if (token.length > MAX_APPROVAL_TOKEN_LENGTH) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [prefix, payload, signature] = parts as [string, string, string];
    if (prefix !== APPROVAL_TOKEN_PREFIX || !BASE64URL.test(payload) || !BASE64URL.test(signature)) return null;
    const expected = mac(this.secret, `${prefix}.${payload}`);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    return validClaims(value);
  }
}

function validClaims(value: unknown): ApprovalClaims | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { v, previewId, tool, store, iat, exp, jti, by } = record;
  if (v !== 1) return null;
  if (typeof previewId !== 'string' || typeof tool !== 'string' || typeof store !== 'string') return null;
  if (typeof iat !== 'number' || !Number.isInteger(iat) || typeof exp !== 'number' || !Number.isInteger(exp)) return null;
  if (typeof jti !== 'string' || !TOKEN_ID.test(jti)) return null;
  if (by !== undefined && (typeof by !== 'string' || by.length > 100)) return null;
  return { v: 1, previewId, tool, store, iat, exp, jti, ...(typeof by === 'string' ? { by } : {}) };
}
