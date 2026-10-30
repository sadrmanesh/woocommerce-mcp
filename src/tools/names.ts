export const toolNames = {
  listStores: 'woocommerce_list_stores',
  listProducts: 'woocommerce_list_products',
  searchProducts: 'woocommerce_search_products',
  getProduct: 'woocommerce_get_product',
  createProduct: 'woocommerce_create_product',
  updateProduct: 'woocommerce_update_product',
  bulkUpdateProducts: 'woocommerce_bulk_update_products',
  bulkAdjustPrices: 'woocommerce_bulk_adjust_prices',
  listOrders: 'woocommerce_list_orders',
  getOrder: 'woocommerce_get_order',
  updateOrderStatus: 'woocommerce_update_order_status',
  listOrderNotes: 'woocommerce_list_order_notes',
  addOrderNote: 'woocommerce_add_order_note',
  deleteOrderNote: 'woocommerce_delete_order_note',
  getOrderTracking: 'woocommerce_get_order_tracking',
  fulfillOrder: 'woocommerce_fulfill_order',
  listRefunds: 'woocommerce_list_refunds',
  getRefund: 'woocommerce_get_refund',
  createRefund: 'woocommerce_create_refund',
  listCustomers: 'woocommerce_list_customers',
  getCustomer: 'woocommerce_get_customer',
  updateCustomer: 'woocommerce_update_customer',
  customerOrders: 'woocommerce_customer_orders',
  customerSegments: 'woocommerce_customer_segments',
  getStock: 'woocommerce_get_stock',
  updateStock: 'woocommerce_update_stock',
  getStoreSummary: 'woocommerce_get_store_summary',
  salesAnalytics: 'woocommerce_sales_analytics',
  lowStockReport: 'woocommerce_low_stock_report',
  listCoupons: 'woocommerce_list_coupons',
  getCoupon: 'woocommerce_get_coupon',
  createCoupon: 'woocommerce_create_coupon',
  updateCoupon: 'woocommerce_update_coupon',
  deleteCoupon: 'woocommerce_delete_coupon',
  couponPerformance: 'woocommerce_coupon_performance',
  scheduleSale: 'woocommerce_schedule_sale',
  endSale: 'woocommerce_end_sale',
  listWebhooks: 'woocommerce_list_webhooks',
  getWebhook: 'woocommerce_get_webhook',
  createWebhook: 'woocommerce_create_webhook',
  updateWebhook: 'woocommerce_update_webhook',
  deleteWebhook: 'woocommerce_delete_webhook',
  listWebhookEvents: 'woocommerce_list_webhook_events',
  listShippingZones: 'woocommerce_list_shipping_zones',
  listShippingMethods: 'woocommerce_list_shipping_methods',
  listTaxRates: 'woocommerce_list_tax_rates',
  listTaxClasses: 'woocommerce_list_tax_classes',
} as const;

export const TOOL_NAMES: readonly string[] = Object.values(toolNames);

export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  toolNames.createProduct,
  toolNames.updateProduct,
  toolNames.bulkUpdateProducts,
  toolNames.bulkAdjustPrices,
  toolNames.updateOrderStatus,
  toolNames.addOrderNote,
  toolNames.deleteOrderNote,
  toolNames.fulfillOrder,
  toolNames.createRefund,
  toolNames.updateCustomer,
  toolNames.updateStock,
  toolNames.createCoupon,
  toolNames.updateCoupon,
  toolNames.deleteCoupon,
  toolNames.scheduleSale,
  toolNames.endSale,
  toolNames.createWebhook,
  toolNames.updateWebhook,
  toolNames.deleteWebhook,
]);

/**
 * Matches a tool name against a pattern where `*` stands for any run of characters.
 * The `woocommerce_` prefix is optional in patterns, so `list_*` matches every list tool.
 */
export function matchesToolPattern(pattern: string, name: string): boolean {
  const full = pattern.startsWith('woocommerce_') || pattern === '*' ? pattern : `woocommerce_${pattern}`;
  const source = full
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(name);
}
