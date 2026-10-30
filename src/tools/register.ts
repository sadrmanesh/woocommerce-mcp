import type { McpServer } from '@modelcontextprotocol/server';

import type { ToolContext } from './context.js';
import { registerCouponTools } from './coupons.js';
import { registerCustomerTools } from './customers.js';
import { registerInventoryTools } from './inventory.js';
import { registerOrderTools } from './orders.js';
import { registerProductTools } from './products.js';
import { registerSummaryTools } from './summary.js';

export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerProductTools(server, ctx);
  registerOrderTools(server, ctx);
  registerCustomerTools(server, ctx);
  registerInventoryTools(server, ctx);
  registerSummaryTools(server, ctx);
  registerCouponTools(server, ctx);
}
