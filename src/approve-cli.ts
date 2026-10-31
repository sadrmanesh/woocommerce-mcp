import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import {
  DEFAULT_APPROVAL_TTL_SECONDS,
  MIN_APPROVAL_SECRET_LENGTH,
  signApproval,
} from './approval.js';
import type { AuditEntry } from './audit.js';
import { ConfigError } from './woocommerce/errors.js';

const PREVIEW_ID = /^pv_[0-9a-f]{16}(?:_[0-9a-f]{16})?$/;
const TOOL_NAME = /^woocommerce_[a-z0-9_]{1,80}$/;
const STORE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const MAX_LISTED = 20;

export const APPROVE_USAGE = `Usage: woocommerce-mcp approve <previewId> [options]

Signs a single-use approval for one previewed write. Run it where the
approval secret lives, never inside the agent's own tools.

Options:
  --tool <name>       Tool name. Read from the audit log when the preview is there.
  --store <id>        Store id. Read from the audit log, else WOOCOMMERCE_DEFAULT_STORE or "default".
  --ttl <seconds>     Token lifetime. Defaults to WOOCOMMERCE_APPROVAL_TTL_SECONDS or 600.
  --by <label>        Approver label recorded in the audit log, such as a name or team.
  --audit-log <path>  Audit log to read the preview from. Defaults to WOOCOMMERCE_AUDIT_LOG.
  --yes               Approve without the interactive prompt.
  -h, --help          Show this help.

Reads the secret from WOOCOMMERCE_APPROVAL_SECRET. The token is printed on
stdout; everything else goes to stderr.`;

export interface ApproveIo {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Asks a yes or no question. Null when there is no terminal to ask on. */
  ask: ((question: string) => Promise<boolean>) | null;
  readFile?: (path: string) => string;
  now?: () => number;
}

type Env = Record<string, string | undefined>;

/** Runs `woocommerce-mcp approve`. Returns the process exit code. */
export async function runApprove(argv: string[], env: Env, io: ApproveIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        tool: { type: 'string' },
        store: { type: 'string' },
        ttl: { type: 'string' },
        by: { type: 'string' },
        'audit-log': { type: 'string' },
        yes: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${APPROVE_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.err(APPROVE_USAGE);
    return 0;
  }
  try {
    const previewId = positionals[0]?.trim() ?? '';
    if (positionals.length !== 1 || !PREVIEW_ID.test(previewId)) {
      throw new ConfigError(`Pass exactly one previewId, such as pv_4f1c9a2e7b3d0856.\n\n${APPROVE_USAGE}`);
    }
    const secret = env.WOOCOMMERCE_APPROVAL_SECRET?.trim() ?? '';
    if (secret === '') throw new ConfigError('WOOCOMMERCE_APPROVAL_SECRET is not set.');
    if (secret.length < MIN_APPROVAL_SECRET_LENGTH || /\s/.test(secret)) {
      throw new ConfigError(`WOOCOMMERCE_APPROVAL_SECRET must be at least ${MIN_APPROVAL_SECRET_LENGTH} characters without whitespace.`);
    }
    const maxTtl = parseTtl(env.WOOCOMMERCE_APPROVAL_TTL_SECONDS, DEFAULT_APPROVAL_TTL_SECONDS, 3_600, 'WOOCOMMERCE_APPROVAL_TTL_SECONDS');
    const ttl = parseTtl(values.ttl, maxTtl, maxTtl, '--ttl');
    const by = values.by?.trim();
    if (by !== undefined && (by === '' || by.length > 100)) throw new ConfigError('--by must be 1 to 100 characters.');

    const auditPath = values['audit-log']?.trim() || env.WOOCOMMERCE_AUDIT_LOG?.trim() || '';
    const entry = auditPath !== '' && auditPath !== 'stderr' ? findPreview(auditPath, previewId, io.readFile) : null;

    const tool = values.tool?.trim() ?? entry?.tool;
    if (tool === undefined) {
      throw new ConfigError('The preview is not in the audit log. Pass --tool with the tool name shown in the preview.');
    }
    if (!TOOL_NAME.test(tool)) throw new ConfigError('--tool must be a woocommerce_ tool name.');
    const store = values.store?.trim() ?? entry?.store ?? (env.WOOCOMMERCE_DEFAULT_STORE?.trim() || 'default');
    if (!STORE_ID.test(store)) throw new ConfigError('--store must be a store id.');
    if (entry !== null && (entry.tool !== tool || entry.store.toLowerCase() !== store.toLowerCase())) {
      throw new ConfigError(
        `The audit log has this preview for ${entry.tool} on store "${entry.store}", not ${tool} on "${store}". Nothing was signed.`,
      );
    }

    io.err(describe(previewId, tool, store, entry));
    if (!values.yes) {
      if (io.ask === null) throw new ConfigError('No terminal to confirm on. Pass --yes to approve without a prompt.');
      if (!(await io.ask('Approve this change? [y/N] '))) {
        io.err('Not approved. Nothing was signed.');
        return 1;
      }
    }
    const now = io.now?.() ?? Math.floor(Date.now() / 1000);
    const { token, claims } = signApproval(secret, {
      previewId,
      tool,
      store,
      ttlSeconds: ttl,
      now,
      ...(by !== undefined ? { by } : {}),
    });
    io.out(`${token}\n`);
    io.err(`Approved. Token ${claims.jti} is valid once, until ${new Date(claims.exp * 1000).toISOString()} (${ttl} seconds).`);
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function parseTtl(value: string | undefined, fallback: number, max: number, name: string): number {
  const text = value?.trim();
  if (text === undefined || text === '') return fallback;
  if (!/^\d+$/.test(text)) throw new ConfigError(`${name} must be a whole number of seconds.`);
  const ttl = Number(text);
  if (ttl < 30 || ttl > max) throw new ConfigError(`${name} must be between 30 and ${max} seconds.`);
  return ttl;
}

/** Latest preview entry with this id in a JSON Lines audit log, or null. */
function findPreview(path: string, previewId: string, read: (path: string) => string = (file) => readFileSync(file, 'utf8')): AuditEntry | null {
  let text: string;
  try {
    text = read(path);
  } catch {
    return null;
  }
  let found: AuditEntry | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes(previewId)) continue;
    try {
      const entry = JSON.parse(line) as AuditEntry;
      if (entry.previewId === previewId && (entry.outcome === 'confirmation_required' || entry.outcome === 'dry_run')) found = entry;
    } catch {
      // Skip lines that are not JSON.
    }
  }
  return found;
}

function describe(previewId: string, tool: string, store: string, entry: AuditEntry | null): string {
  const lines = [`Approve ${tool} on store "${store}"`, `previewId ${previewId}`];
  if (entry === null) {
    lines.push('', 'This preview is not in the audit log. Check the change in the preview the agent showed you before approving.');
    return lines.join('\n');
  }
  lines.push(`previewed at ${entry.time}`, '', `arguments: ${JSON.stringify(entry.arguments)}`);
  if (entry.request) lines.push(`request:   ${entry.request.method} ${entry.request.path}`);
  const state = entry.preconditions;
  if (state) {
    lines.push('', `records the change was computed from (${state.recordCount}):`);
    for (const record of state.records.slice(0, MAX_LISTED)) {
      const keys = [...new Set([...Object.keys(record.before ?? {}), ...Object.keys(record.after ?? {})])];
      const changes = keys.map((key) => `${key} ${JSON.stringify(record.before?.[key] ?? null)} -> ${JSON.stringify(record.after?.[key] ?? null)}`);
      lines.push(`  ${record.resource}${changes.length > 0 ? `: ${changes.join(', ')}` : ''}`);
    }
    if (state.recordCount > MAX_LISTED) lines.push(`  and ${state.recordCount - MAX_LISTED} more`);
  }
  return lines.join('\n');
}

/** Asks on the controlling terminal. */
export async function askOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
