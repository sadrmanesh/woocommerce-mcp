import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { ApprovalVerifier, signApproval } from '../src/approval.js';
import { runApprove } from '../src/approve-cli.js';
import { type AuditLog, createAuditLog, memoryAuditLog } from '../src/audit.js';
import { type AppConfig, authWarnings, loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { bulkAdjustPrices } from '../src/tools/bulk.js';
import { createProduct } from '../src/tools/products.js';
import { CREATE, runTool, type ToolSpec, UPDATE } from '../src/tools/registry.js';
import { bulkAdjustPricesInput, createProductInput } from '../src/tools/schemas.js';
import { createFetchMock, jsonResponse, resultText, testRuntime, testStore, validEnv } from './helpers.js';

// A fixed test value, not a real secret.
const SECRET = 'test-approval-secret-0123456789abcdefghij';
const NOW = 1_800_000_000;

const adjustSpec: ToolSpec<typeof bulkAdjustPricesInput> = {
  name: 'woocommerce_bulk_adjust_prices',
  title: 'Bulk adjust prices',
  description: 'Adjust prices.',
  input: bulkAdjustPricesInput,
  annotations: UPDATE,
  write: true,
  run: bulkAdjustPrices,
};

const createSpec: ToolSpec<typeof createProductInput> = {
  name: 'woocommerce_create_product',
  title: 'Create product',
  description: 'Create a product.',
  input: createProductInput,
  annotations: CREATE,
  write: true,
  run: createProduct,
};

const raise = { productIds: [12], mode: 'percent' as const, change: 10 };

function parse(result: Parameters<typeof resultText>[0]): Record<string, unknown> {
  return JSON.parse(resultText(result)) as Record<string, unknown>;
}

function errorCode(result: Parameters<typeof resultText>[0]): unknown {
  return (parse(result).error as Record<string, unknown> | undefined)?.code;
}

/** A one-product store whose price the test can change between calls. */
function mockStore() {
  const product = { id: 12, name: 'Hat', type: 'simple', regular_price: '20.00', sale_price: '', date_modified_gmt: '2026-10-30T10:00:00' };
  const writes: unknown[] = [];
  const { fetchImpl } = createFetchMock(async (request) => {
    if (request.method === 'GET') return jsonResponse([{ ...product }]);
    const body = JSON.parse(request.body ?? '{}') as { update?: { id: number; regular_price?: string }[] };
    writes.push(body);
    for (const row of body.update ?? []) if (row.regular_price !== undefined) product.regular_price = row.regular_price;
    return jsonResponse(body.update ? { update: body.update.map((row) => ({ ...product, ...row })) } : { id: 9 });
  });
  return { product, writes, fetchImpl };
}

function signedSetup(overrides: Partial<AppConfig> = {}, audit: AuditLog = memoryAuditLog()) {
  const store = mockStore();
  const clock = { now: NOW };
  const runtime = testRuntime(
    store.fetchImpl,
    { stores: [testStore({ readOnly: false })], approvalSecret: SECRET, ...overrides },
    { audit, approvalNow: () => clock.now },
  );
  return { store, clock, runtime };
}

function approve(previewId: unknown, extra: { tool?: string; store?: string; ttlSeconds?: number; now?: number; by?: string; secret?: string } = {}): string {
  return signApproval(extra.secret ?? SECRET, {
    previewId: String(previewId),
    tool: extra.tool ?? adjustSpec.name,
    store: extra.store ?? 'default',
    now: extra.now ?? NOW,
    ...(extra.ttlSeconds !== undefined ? { ttlSeconds: extra.ttlSeconds } : {}),
    ...(extra.by !== undefined ? { by: extra.by } : {}),
  }).token;
}

describe('signed approvals disabled', () => {
  it('keeps the 0.5 behavior and ignores a stray approval field', async () => {
    const store = mockStore();
    const audit = memoryAuditLog();
    const runtime = testRuntime(store.fetchImpl, { stores: [testStore({ readOnly: false })] }, { audit });
    assert.equal(runtime.approval, null);
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    const withStray = parse(await runTool(runtime, adjustSpec, { ...raise, approval: 'anything' }));
    assert.equal(withStray.previewId, preview.previewId);
    const applied = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId) });
    assert.notEqual(applied.isError, true);
    assert.equal(store.writes.length, 1);
    // A confirm without previewId still works, as in 0.5.
    const noId = await runTool(runtime, createSpec, { name: 'Cap', confirm: true });
    assert.notEqual(noId.isError, true);
    assert.equal(audit.entries.some((entry) => 'approval' in entry || 'preconditions' in entry), false);
  });

  it('does not advertise the approval field or instructions', async () => {
    await withClient({}, async (client, instructions) => {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === adjustSpec.name);
      const properties = (tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      assert.equal('approval' in properties, false);
      assert.doesNotMatch(instructions ?? '', /signed approval/);
    });
  });
});

describe('signed approvals', () => {
  it('advertises the approval field and instructions when enabled', async () => {
    await withClient({ approvalSecret: SECRET }, async (client, instructions) => {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === adjustSpec.name);
      const properties = (tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      assert.equal('approval' in properties, true);
      assert.match(tool?.description ?? '', /signed approval/);
      assert.match(instructions ?? '', /You cannot create an approval yourself/);
      const read = tools.tools.find((entry) => entry.name === 'woocommerce_get_product');
      assert.equal('approval' in ((read?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}), false);
    });
  });

  it('applies a confirm with a valid approval and audits it', async () => {
    const audit = memoryAuditLog();
    const { store, runtime } = signedSetup({}, audit);
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    assert.equal(preview.status, 'confirmation_required');
    const token = approve(preview.previewId, { by: 'ops-lead' });
    const applied = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId), approval: token });
    assert.notEqual(applied.isError, true, resultText(applied));
    assert.deepEqual(store.writes, [{ update: [{ id: 12, regular_price: '22.00' }] }]);

    const [previewEntry, appliedEntry] = audit.entries;
    assert.equal(previewEntry?.outcome, 'confirmation_required');
    assert.deepEqual(previewEntry?.preconditions?.records[0]?.after, { regular_price: '22.00' });
    assert.equal(appliedEntry?.outcome, 'applied');
    assert.equal(appliedEntry?.stateMatch, true);
    assert.equal(appliedEntry?.approval?.mode, 'signed');
    assert.equal(appliedEntry?.approval?.result, 'verified');
    assert.equal(appliedEntry?.approval?.by, 'ops-lead');
    assert.match(String(appliedEntry?.approval?.tokenId), /^[A-Za-z0-9_-]{8,64}$/);
    assert.equal(JSON.stringify(audit.entries).includes(token), false, 'the token itself is never logged');
    assert.equal(JSON.stringify(audit.entries).includes(SECRET), false);
  });

  it('refuses a confirm without an approval or without a previewId', async () => {
    const audit = memoryAuditLog();
    const { store, runtime } = signedSetup({}, audit);
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    const missing = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId) });
    assert.equal(errorCode(missing), 'approval_required');
    assert.match(resultText(missing), /woocommerce-mcp approve pv_/);
    const noId = await runTool(runtime, adjustSpec, { ...raise, confirm: true, approval: approve(preview.previewId) });
    assert.equal(errorCode(noId), 'approval_required');
    assert.equal(store.writes.length, 0);
    const last = audit.entries.at(-1);
    assert.equal(last?.outcome, 'refused');
    assert.deepEqual(last?.approval, { mode: 'signed', result: 'missing' });
  });

  it('refuses tokens that are malformed, tampered with, or signed with another key', async () => {
    const audit = memoryAuditLog();
    const { store, runtime } = signedSetup({}, audit);
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    const good = approve(preview.previewId);
    const [prefix, payload, signature] = good.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const forgedPayload = Buffer.from(JSON.stringify({ ...claims, exp: NOW + 100_000 })).toString('base64url');
    const bad = [
      'not-a-token',
      `${prefix}.${payload}`,
      `${prefix}.${forgedPayload}.${signature}`,
      `wmcp2.${payload}.${signature}`,
      approve(preview.previewId, { secret: 'another-secret-0123456789abcdefghijklmn' }),
    ];
    for (const token of bad) {
      const refused = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId), approval: token });
      assert.equal(errorCode(refused), 'approval_invalid', token);
    }
    assert.equal(store.writes.length, 0);
    assert.equal(audit.entries.at(-1)?.approval?.result, 'invalid');
    assert.equal(audit.entries.at(-1)?.approval?.tokenId, undefined);
  });

  it('refuses an expired token and one valid for longer than the server allows', async () => {
    const { store, clock, runtime } = signedSetup({ approvalTtlSeconds: 300 });
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    const token = approve(preview.previewId, { ttlSeconds: 120 });
    clock.now = NOW + 121;
    const expired = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId), approval: token });
    assert.equal(errorCode(expired), 'approval_expired');
    clock.now = NOW;
    const tooLong = approve(preview.previewId, { ttlSeconds: 3_600 });
    const refused = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId), approval: tooLong });
    assert.equal(errorCode(refused), 'approval_invalid');
    assert.equal(store.writes.length, 0);
  });

  it('refuses a token bound to a different previewId, tool, or store', async () => {
    const audit = memoryAuditLog();
    const { store, runtime } = signedSetup({}, audit);
    const small = parse(await runTool(runtime, adjustSpec, raise));
    const big = parse(await runTool(runtime, adjustSpec, { ...raise, change: 50 }));
    assert.notEqual(small.previewId, big.previewId);
    // The user approved +10%; the agent tries to use that approval for +50%.
    const forSmall = approve(small.previewId);
    const swapped = await runTool(runtime, adjustSpec, { ...raise, change: 50, confirm: true, previewId: String(big.previewId), approval: forSmall });
    assert.equal(errorCode(swapped), 'approval_mismatch');
    assert.equal(audit.entries.at(-1)?.approval?.result, 'mismatch');
    const otherTool = await runTool(runtime, adjustSpec, {
      ...raise,
      confirm: true,
      previewId: String(small.previewId),
      approval: approve(small.previewId, { tool: 'woocommerce_delete_coupon' }),
    });
    assert.equal(errorCode(otherTool), 'approval_mismatch');
    const otherStore = await runTool(runtime, adjustSpec, {
      ...raise,
      confirm: true,
      previewId: String(small.previewId),
      approval: approve(small.previewId, { store: 'eu' }),
    });
    assert.equal(errorCode(otherStore), 'approval_mismatch');
    assert.equal(store.writes.length, 0);
  });

  it('refuses a replayed token', async () => {
    const audit = memoryAuditLog();
    const { store, runtime } = signedSetup({}, audit);
    const preview = parse(await runTool(runtime, createSpec, { name: 'Cap' }));
    const token = approve(preview.previewId, { tool: createSpec.name });
    const input = { name: 'Cap', confirm: true, previewId: String(preview.previewId), approval: token };
    const [first, second] = await Promise.all([runTool(runtime, createSpec, input), runTool(runtime, createSpec, input)]);
    const codes = [first, second].map((result) => (result.isError === true ? errorCode(result) : 'applied')).sort();
    assert.deepEqual(codes, ['applied', 'approval_replayed']);
    const third = await runTool(runtime, createSpec, input);
    assert.equal(errorCode(third), 'approval_replayed');
    assert.equal(store.writes.length, 1);
    assert.equal(audit.entries.at(-1)?.approval?.result, 'replayed');
    assert.ok(audit.entries.at(-1)?.approval?.tokenId);
  });

  it('still refuses a stale preview even with a valid approval', async () => {
    const audit = memoryAuditLog();
    const { store, runtime } = signedSetup({}, audit);
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    const token = approve(preview.previewId);
    store.product.regular_price = '25.00';
    const stale = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId), approval: token });
    assert.equal(errorCode(stale), 'stale_preview');
    assert.equal(store.writes.length, 0);
    const last = audit.entries.at(-1);
    assert.equal(last?.stateMatch, false);
    assert.equal(last?.approval?.result, 'verified');
    // The approval was spent; a fresh preview needs a fresh approval.
    const fresh = parse(await runTool(runtime, adjustSpec, raise));
    const again = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(fresh.previewId), approval: token });
    assert.equal(errorCode(again), 'approval_mismatch');
    const applied = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(fresh.previewId), approval: approve(fresh.previewId) });
    assert.notEqual(applied.isError, true);
    assert.deepEqual(store.writes, [{ update: [{ id: 12, regular_price: '27.50' }] }]);
  });

  it('refuses an approved one-part id for a change computed from store data', async () => {
    const { store, runtime } = signedSetup();
    const preview = parse(await runTool(runtime, adjustSpec, raise));
    const argumentsOnly = String(preview.previewId).slice(0, 'pv_'.length + 16);
    const refused = await runTool(runtime, adjustSpec, {
      ...raise,
      confirm: true,
      previewId: argumentsOnly,
      approval: approve(argumentsOnly),
    });
    assert.equal(errorCode(refused), 'preview_mismatch');
    assert.match(resultText(refused), /lacks the state part/);
    assert.equal(store.writes.length, 0);
  });

  it('previews instead of writing even when confirmation is turned off', async () => {
    const { store, runtime } = signedSetup({ requireConfirmation: false });
    const result = parse(await runTool(runtime, createSpec, { name: 'Cap' }));
    assert.equal(result.status, 'confirmation_required');
    assert.equal(store.writes.length, 0);
  });

  it('verifies with the exported verifier the way a webhook signer would expect', () => {
    const verifier = new ApprovalVerifier({ secret: SECRET, now: () => NOW });
    const target = { previewId: 'pv_0123456789abcdef', tool: createSpec.name, store: 'Default' };
    const { token, claims } = signApproval(SECRET, { ...target, store: 'default', now: NOW, jti: 'approval-0001' });
    assert.equal(token.split('.')[0], 'wmcp1');
    assert.deepEqual(verifier.consume(token, target), claims);
    assert.throws(() => verifier.consume(token, target), /already used/);
  });
});

describe('approval config', () => {
  it('reads the secret and TTL, and never echoes a bad secret', () => {
    const config = loadConfig({ ...validEnv, WOOCOMMERCE_APPROVAL_SECRET: SECRET, WOOCOMMERCE_APPROVAL_TTL_SECONDS: '120' });
    assert.equal(config.approvalSecret, SECRET);
    assert.equal(config.approvalTtlSeconds, 120);
    assert.equal(loadConfig(validEnv).approvalSecret, null);
    assert.equal(loadConfig(validEnv).approvalTtlSeconds, 600);
    const short = 'too-short-secret-value';
    assert.throws(
      () => loadConfig({ ...validEnv, WOOCOMMERCE_APPROVAL_SECRET: short }),
      (error: Error) => /WOOCOMMERCE_APPROVAL_SECRET: must be 32/.test(error.message) && !error.message.includes(short),
    );
    assert.throws(() => loadConfig({ ...validEnv, WOOCOMMERCE_APPROVAL_TTL_SECONDS: '5' }), /WOOCOMMERCE_APPROVAL_TTL_SECONDS/);
    const warnings = authWarnings(loadConfig({ ...validEnv, WOOCOMMERCE_APPROVAL_SECRET: SECRET, WOOCOMMERCE_REQUIRE_CONFIRMATION: 'false' }));
    assert.ok(warnings.some((warning) => /REQUIRE_CONFIRMATION=false is ignored/.test(warning)));
  });
});

describe('approve command', () => {
  function io(answer: boolean | null = null) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        out: (text: string) => out.push(text),
        err: (text: string) => err.push(text),
        ask: answer === null ? null : async () => answer,
        now: () => NOW,
      },
    };
  }

  it('reads the preview from the audit log, shows it, and prints a token the server accepts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wmcp-approve-'));
    try {
      const logPath = join(dir, 'audit.jsonl');
      const { store, runtime } = signedSetup({}, createAuditLog(logPath));
      const preview = parse(await runTool(runtime, adjustSpec, raise));
      const env = { WOOCOMMERCE_APPROVAL_SECRET: SECRET, WOOCOMMERCE_AUDIT_LOG: logPath };
      const run = io(true);
      const code = await runApprove([String(preview.previewId), '--by', 'ops-lead'], env, run.io);
      assert.equal(code, 0, run.err.join('\n'));
      const shown = run.err.join('\n');
      assert.match(shown, /woocommerce_bulk_adjust_prices on store "default"/);
      assert.match(shown, /products\/12: regular_price "20.00" -> "22.00"/);
      assert.equal(shown.includes(SECRET), false);
      const token = run.out.join('').trim();
      assert.match(token, /^wmcp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      const applied = await runTool(runtime, adjustSpec, { ...raise, confirm: true, previewId: String(preview.previewId), approval: token });
      assert.notEqual(applied.isError, true, resultText(applied));
      assert.equal(store.writes.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('signs nothing when the approver declines, there is no terminal, or the secret is missing', async () => {
    const env = { WOOCOMMERCE_APPROVAL_SECRET: SECRET };
    const args = ['pv_0123456789abcdef', '--tool', createSpec.name];
    const declined = io(false);
    assert.equal(await runApprove(args, env, declined.io), 1);
    assert.deepEqual(declined.out, []);
    const noTerminal = io(null);
    assert.equal(await runApprove(args, env, noTerminal.io), 2);
    assert.match(noTerminal.err.join('\n'), /--yes/);
    const noSecret = io(null);
    assert.equal(await runApprove([...args, '--yes'], {}, noSecret.io), 2);
    assert.match(noSecret.err.join('\n'), /WOOCOMMERCE_APPROVAL_SECRET is not set/);
    const noTool = io(null);
    assert.equal(await runApprove(['pv_0123456789abcdef', '--yes'], env, noTool.io), 2);
    assert.match(noTool.err.join('\n'), /Pass --tool/);
    const badId = io(null);
    assert.equal(await runApprove(['not-an-id', '--yes'], env, badId.io), 2);
    const yes = io(null);
    assert.equal(await runApprove([...args, '--yes'], env, yes.io), 0);
    assert.match(yes.err.join('\n'), /not in the audit log/);
    assert.equal(yes.out.length, 1);
  });
});

async function withClient(
  overrides: Partial<AppConfig>,
  run: (client: Client, instructions: string | undefined) => Promise<void>,
): Promise<void> {
  const store = mockStore();
  const runtime = testRuntime(store.fetchImpl, { stores: [testStore({ readOnly: false })], ...overrides });
  const handler = createMcpHandler(() => createServer({ runtime }));
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'woocommerce-mcp-test', version: '0.6.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  try {
    await run(client, client.getInstructions());
  } finally {
    await client.close();
    await handler.close();
  }
}
