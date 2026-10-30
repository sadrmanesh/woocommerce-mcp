import type { McpServer } from '@modelcontextprotocol/server';

import { registerAnalyticsTools } from './analytics.js';
import { registerBulkTools } from './bulk.js';
import type { Runtime } from './context.js';
import { registerCouponTools, registerPromotionTools } from './coupons.js';
import { registerCustomerTools } from './customers.js';
import { registerFulfillmentTools } from './fulfillment.js';
import { registerInventoryTools } from './inventory.js';
import { registerOrderTools } from './orders.js';
import { registerProductTools } from './products.js';
import { registerRefundTools } from './refunds.js';
import { registerShippingTools } from './shipping.js';
import { registerStoreTools } from './stores.js';
import { registerSummaryTools } from './summary.js';
import { registerWebhookTools } from './webhooks.js';

export function registerTools(server: McpServer, runtime: Runtime): void {
  registerStoreTools(server, runtime);
  registerProductTools(server, runtime);
  registerBulkTools(server, runtime);
  registerOrderTools(server, runtime);
  registerFulfillmentTools(server, runtime);
  registerRefundTools(server, runtime);
  registerCustomerTools(server, runtime);
  registerInventoryTools(server, runtime);
  registerSummaryTools(server, runtime);
  registerAnalyticsTools(server, runtime);
  registerCouponTools(server, runtime);
  registerPromotionTools(server, runtime);
  registerWebhookTools(server, runtime);
  registerShippingTools(server, runtime);
}
