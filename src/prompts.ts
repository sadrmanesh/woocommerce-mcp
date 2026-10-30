import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { toolNames } from './tools/names.js';

export const PROMPT_NAMES = ['sales_briefing', 'restock_plan', 'order_triage', 'price_change_review'] as const;

const storeArg = z.string().trim().max(40).optional().describe('Store id. Leave empty for the default store');

function userMessage(text: string): { messages: { role: 'user'; content: { type: 'text'; text: string } }[] } {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

function storeClause(store: string | undefined): string {
  return store ? `Use store "${store}" for every tool call.` : 'Use the default store.';
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'sales_briefing',
    {
      title: 'Sales briefing',
      description: 'A short sales briefing for a period with trends, top products, and follow-ups.',
      argsSchema: z.object({
        period: z.enum(['day', 'week', 'month', 'quarter']).optional().describe('Period to cover. Defaults to week'),
        store: storeArg,
      }),
    },
    ({ period, store }) =>
      userMessage(
        [
          `Prepare a sales briefing for the last ${period ?? 'week'}. ${storeClause(store)}`,
          `Call ${toolNames.salesAnalytics} for the period and for the period before it so you can compare.`,
          `Call ${toolNames.lowStockReport} to flag best sellers that may run out.`,
          'Report: net sales and change versus the previous period, order count, average order value, top five products, refunds, and anything unusual.',
          'Finish with at most three concrete follow-ups. Keep it under 250 words and do not change anything in the store.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'restock_plan',
    {
      title: 'Restock plan',
      description: 'A prioritised restock list from current stock and recent sales.',
      argsSchema: z.object({
        threshold: z.string().regex(/^\d{1,6}$/).optional().describe('Low stock threshold. Defaults to 5'),
        days: z.string().regex(/^\d{1,3}$/).optional().describe('Days of sales history to consider. Defaults to 30'),
        store: storeArg,
      }),
    },
    ({ threshold, days, store }) =>
      userMessage(
        [
          `Build a restock plan. ${storeClause(store)}`,
          `1. Call ${toolNames.lowStockReport} with threshold ${threshold ?? '5'}.`,
          `2. Call ${toolNames.salesAnalytics} for the last ${days ?? '30'} days and use topProducts to estimate daily sales per product.`,
          '3. For each low or out-of-stock product, estimate days of cover and a reorder quantity for 30 days of sales.',
          'Return a table sorted by urgency: product, SKU, stock, daily sales, days of cover, suggested order.',
          `Do not update stock. If the user later asks to apply changes, use ${toolNames.bulkUpdateProducts} and show the preview first.`,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'order_triage',
    {
      title: 'Order triage',
      description: 'Review open orders and propose next actions without changing them.',
      argsSchema: z.object({
        status: z.enum(['pending', 'processing', 'on-hold']).optional().describe('Status to review. Defaults to processing'),
        store: storeArg,
      }),
    },
    ({ status, store }) =>
      userMessage(
        [
          `Triage orders with status "${status ?? 'processing'}". ${storeClause(store)}`,
          `Call ${toolNames.listOrders} sorted by date ascending so the oldest come first, and open individual orders with ${toolNames.getOrder} only when needed.`,
          'Group the orders into: ready to ship, waiting on payment or stock, and needs attention (old, high value, or with customer notes).',
          'Propose one next action per order. Do not change any order; the user will confirm each change.',
          'Avoid repeating customer email addresses or street addresses in the summary.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'price_change_review',
    {
      title: 'Price change review',
      description: 'Plan a price change, preview it, and wait for approval before applying it.',
      argsSchema: z.object({
        change: z.string().trim().min(1).max(200).describe('The change in plain words, for example "raise mugs by 5%"'),
        store: storeArg,
      }),
    },
    ({ change, store }) =>
      userMessage(
        [
          `The user wants this price change: ${change}. ${storeClause(store)}`,
          `Find the affected products with ${toolNames.searchProducts} or ${toolNames.listProducts} and list them for the user.`,
          `Preview the change with ${toolNames.bulkAdjustPrices} and dryRun: true, then show every old and new price.`,
          'Apply the change only after the user approves the exact list, by calling the tool again with confirm: true.',
        ].join('\n'),
      ),
  );
}
