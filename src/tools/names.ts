export const toolNames = {
  listProducts: 'woocommerce_list_products',
  searchProducts: 'woocommerce_search_products',
  getProduct: 'woocommerce_get_product',
  createProduct: 'woocommerce_create_product',
  updateProduct: 'woocommerce_update_product',
  listOrders: 'woocommerce_list_orders',
  getOrder: 'woocommerce_get_order',
  updateOrderStatus: 'woocommerce_update_order_status',
  addOrderNote: 'woocommerce_add_order_note',
  listCustomers: 'woocommerce_list_customers',
  getCustomer: 'woocommerce_get_customer',
  getStock: 'woocommerce_get_stock',
  updateStock: 'woocommerce_update_stock',
  getStoreSummary: 'woocommerce_get_store_summary',
  listCoupons: 'woocommerce_list_coupons',
  createCoupon: 'woocommerce_create_coupon',
} as const;

export const TOOL_NAMES = Object.values(toolNames);

export const WRITE_NOTE =
  'Write tool. Refused while WOOCOMMERCE_READ_ONLY is true (the default).';
