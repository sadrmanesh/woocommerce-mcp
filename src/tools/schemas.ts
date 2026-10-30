import * as z from 'zod/v4';

export const resourceId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const pageSchema = z.number().int().min(1).max(10_000).optional().describe('1-based page index');

export const perPageSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('Page size, from 1 to 100');

export const sortDirectionSchema = z.enum(['asc', 'desc']).optional().describe('Sort direction');

export const moneySchema = z
  .union([
    z.string().trim().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/, 'Use a non-negative decimal'),
    z.number().finite().nonnegative(),
  ])
  .describe('Decimal amount, as a number or a string such as "19.99"');

export const httpUrlSchema = z
  .url()
  .refine((value) => value.startsWith('https://') || value.startsWith('http://'), 'Use an http or https URL');

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isRealUtcDate, 'Not a valid calendar date')
  .describe('Calendar date in YYYY-MM-DD');

export const isoDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
    'Use an ISO-8601 date-time such as 2026-10-01T00:00:00Z',
  )
  .describe('ISO-8601 date-time');

export const dateOrDateTimeSchema = z.union([isoDateSchema, isoDateTimeSchema]);

export const productTypeSchema = z.enum(['simple', 'grouped', 'external', 'variable']);
export const productStatusSchema = z.enum(['draft', 'pending', 'private', 'publish']);
export const stockStatusSchema = z.enum(['instock', 'outofstock', 'onbackorder']);
export const orderStatusSchema = z.enum([
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
]);

const categoryRef = z.object({ id: resourceId }).strict();

const imageRef = z
  .object({
    src: httpUrlSchema.describe('Image URL'),
    alt: z.string().trim().max(200).optional(),
    name: z.string().trim().max(200).optional(),
  })
  .strict();

const dimensionsSchema = z
  .object({
    length: z.string().trim().max(20).optional(),
    width: z.string().trim().max(20).optional(),
    height: z.string().trim().max(20).optional(),
  })
  .strict();

export const productFields = {
  name: z.string().trim().min(1).max(200).optional().describe('Product name'),
  type: productTypeSchema.optional().describe('Product type'),
  status: productStatusSchema.optional().describe('Publish status. Prefer draft until the product is ready'),
  regularPrice: moneySchema.optional().describe('Regular price'),
  salePrice: z
    .union([moneySchema, z.literal('')])
    .optional()
    .describe('Sale price. Send an empty string to clear it'),
  description: z.string().max(50_000).optional(),
  shortDescription: z.string().max(5_000).optional(),
  sku: z.string().trim().max(200).optional(),
  manageStock: z.boolean().optional().describe('Track stock quantity in WooCommerce'),
  stockQuantity: z.number().int().min(0).max(1_000_000_000).optional(),
  stockStatus: stockStatusSchema.optional(),
  catalogVisibility: z.enum(['visible', 'catalog', 'search', 'hidden']).optional(),
  featured: z.boolean().optional(),
  virtual: z.boolean().optional(),
  downloadable: z.boolean().optional(),
  weight: z.string().trim().max(20).optional(),
  dimensions: dimensionsSchema.optional(),
  categories: z.array(categoryRef).max(50).optional().describe('Existing category IDs'),
  tags: z.array(categoryRef).max(50).optional().describe('Existing tag IDs'),
  images: z.array(imageRef).max(20).optional(),
  externalUrl: httpUrlSchema.optional().describe('External product URL'),
};

export const listProductsInput = z
  .object({
    page: pageSchema,
    perPage: perPageSchema,
    search: z.string().trim().min(1).max(200).optional().describe('Free-text search'),
    status: z.enum(['any', 'draft', 'pending', 'private', 'publish']).optional(),
    type: productTypeSchema.optional(),
    sku: z.string().trim().min(1).max(200).optional(),
    category: resourceId.optional().describe('Category ID'),
    tag: resourceId.optional().describe('Tag ID'),
    stockStatus: stockStatusSchema.optional(),
    featured: z.boolean().optional(),
    onSale: z.boolean().optional(),
    minPrice: z.number().finite().nonnegative().optional(),
    maxPrice: z.number().finite().nonnegative().optional(),
    after: isoDateTimeSchema.optional().describe('Created after this date-time'),
    before: isoDateTimeSchema.optional().describe('Created before this date-time'),
    orderBy: z
      .enum(['date', 'id', 'include', 'title', 'slug', 'modified', 'popularity', 'rating', 'menu_order', 'price'])
      .optional(),
    order: sortDirectionSchema,
  })
  .strict();

export const searchProductsInput = listProductsInput.omit({ search: true }).extend({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Search phrase matched against product name, SKU, and description'),
});

export const getProductInput = z
  .object({
    id: resourceId.describe('Product ID'),
  })
  .strict();

export const createProductInput = z
  .object({
    ...productFields,
    name: z.string().trim().min(1).max(200).describe('Product name'),
  })
  .strict();

export const updateProductInput = z
  .object({
    id: resourceId.describe('Product ID'),
    ...productFields,
  })
  .strict();

export const listOrdersInput = z
  .object({
    page: pageSchema,
    perPage: perPageSchema,
    search: z.string().trim().min(1).max(200).optional(),
    status: orderStatusSchema.optional(),
    customer: resourceId.optional().describe('Customer ID'),
    product: resourceId.optional().describe('Product ID contained in the order'),
    after: isoDateTimeSchema.optional().describe('Created after this date-time'),
    before: isoDateTimeSchema.optional().describe('Created before this date-time'),
    orderBy: z.enum(['date', 'id', 'include', 'title', 'slug', 'modified']).optional(),
    order: sortDirectionSchema,
  })
  .strict();

export const getOrderInput = z
  .object({
    id: resourceId.describe('Order ID'),
  })
  .strict();

export const updateOrderStatusInput = z
  .object({
    id: resourceId.describe('Order ID'),
    status: orderStatusSchema.describe('New order status'),
  })
  .strict();

export const addOrderNoteInput = z
  .object({
    orderId: resourceId.describe('Order ID'),
    note: z.string().trim().min(1).max(5_000).describe('Note text'),
    customerNote: z.boolean().optional().describe('When true, the note is shared with the customer'),
  })
  .strict();

export const listCustomersInput = z
  .object({
    page: pageSchema,
    perPage: perPageSchema,
    search: z.string().trim().min(1).max(200).optional(),
    email: z.email().optional(),
    role: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,50}$/)
      .optional()
      .describe('WordPress role, for example customer'),
    orderBy: z.enum(['id', 'include', 'name', 'registered_date']).optional(),
    order: sortDirectionSchema,
  })
  .strict();

export const getCustomerInput = z
  .object({
    id: resourceId.describe('Customer ID'),
  })
  .strict();

export const getStockInput = z
  .object({
    productId: resourceId.describe('Product ID'),
    variationId: resourceId.optional().describe('Variation ID when the stock record belongs to a variation'),
  })
  .strict();

export const updateStockInput = z
  .object({
    productId: resourceId.describe('Product ID'),
    variationId: resourceId.optional().describe('Variation ID when updating a variation'),
    stockQuantity: z.number().int().min(0).max(1_000_000_000).optional().describe('Quantity on hand'),
    manageStock: z.boolean().optional().describe('Whether WooCommerce tracks stock for this product'),
    stockStatus: stockStatusSchema.optional(),
  })
  .strict();

export const listCouponsInput = z
  .object({
    page: pageSchema,
    perPage: perPageSchema,
    search: z.string().trim().min(1).max(200).optional(),
    code: z.string().trim().min(1).max(100).optional().describe('Exact coupon code'),
    after: isoDateTimeSchema.optional(),
    before: isoDateTimeSchema.optional(),
    orderBy: z.enum(['date', 'id', 'include', 'title', 'slug', 'modified']).optional(),
    order: sortDirectionSchema,
  })
  .strict();

export const createCouponInput = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\s]+$/, 'must not contain whitespace')
      .describe('Coupon code customers enter'),
    amount: moneySchema.describe('Discount amount, without a currency symbol'),
    discountType: z
      .enum(['percent', 'fixed_cart', 'fixed_product'])
      .optional()
      .describe('Defaults to the store default, which is fixed_cart, when omitted'),
    description: z.string().max(5_000).optional(),
    dateExpires: dateOrDateTimeSchema.optional().describe('Expiry as YYYY-MM-DD or an ISO-8601 date-time'),
    individualUse: z.boolean().optional(),
    usageLimit: z.number().int().positive().max(1_000_000).optional(),
    usageLimitPerUser: z.number().int().positive().max(1_000_000).optional(),
    freeShipping: z.boolean().optional(),
    minimumAmount: moneySchema.optional(),
    maximumAmount: moneySchema.optional(),
    productIds: z.array(resourceId).max(100).optional(),
    excludedProductIds: z.array(resourceId).max(100).optional(),
    emailRestrictions: z.array(z.email()).max(50).optional(),
  })
  .strict();

export const storeSummaryInput = z
  .object({
    period: z
      .enum(['week', 'month', 'last_month', 'year'])
      .optional()
      .describe('Report period used when dates are omitted. Defaults to month'),
    dateMin: isoDateSchema.optional().describe('Inclusive start date, YYYY-MM-DD'),
    dateMax: isoDateSchema.optional().describe('Inclusive end date, YYYY-MM-DD'),
  })
  .strict();

export function moneyToString(value: string | number): string {
  return typeof value === 'number' ? String(value) : value;
}

export function isRealUtcDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1] ?? '');
  const month = Number(match[2] ?? '');
  const day = Number(match[3] ?? '');
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const emptyInput = z.object({}).strict();

export const listRefundsInput = z
  .object({
    orderId: resourceId.describe('Order ID'),
    page: pageSchema,
    perPage: perPageSchema,
  })
  .strict();

export const getRefundInput = z
  .object({
    orderId: resourceId.describe('Order ID'),
    refundId: resourceId.describe('Refund ID'),
  })
  .strict();

const refundLineSchema = z
  .object({
    id: resourceId.describe('Order line item ID (not the product ID)'),
    quantity: z.number().int().min(1).max(100_000).optional().describe('Quantity to refund'),
    refundTotal: moneySchema.describe('Amount to refund for this line, excluding tax'),
    refundTax: z
      .array(
        z
          .object({
            id: resourceId.describe('Tax rate ID from the line item taxes'),
            refundTotal: moneySchema,
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();

export const createRefundInput = z
  .object({
    orderId: resourceId.describe('Order ID'),
    amount: moneySchema.optional().describe('Total refund amount. Required unless lineItems is given'),
    reason: z.string().trim().max(1_000).optional().describe('Reason shown on the order'),
    lineItems: z.array(refundLineSchema).min(1).max(100).optional(),
    apiRefund: z
      .boolean()
      .optional()
      .describe('Ask the payment gateway to return the money. Defaults to false, which records a manual refund only'),
    restockItems: z.boolean().optional().describe('Return refunded line item quantities to stock'),
  })
  .strict();

const bulkProductUpdate = z
  .object({
    id: resourceId.describe('Product ID'),
    regularPrice: moneySchema.optional(),
    salePrice: z.union([moneySchema, z.literal('')]).optional().describe('Send an empty string to clear the sale price'),
    stockQuantity: z.number().int().min(0).max(1_000_000_000).optional(),
    stockStatus: stockStatusSchema.optional(),
    manageStock: z.boolean().optional(),
    status: productStatusSchema.optional(),
  })
  .strict();

export const bulkUpdateProductsInput = z
  .object({
    updates: z.array(bulkProductUpdate).min(1).max(100).describe('Up to 100 product updates sent as one batch'),
  })
  .strict();

export const bulkAdjustPricesInput = z
  .object({
    productIds: z.array(resourceId).min(1).max(100).describe('Simple or external products to reprice'),
    mode: z.enum(['percent', 'fixed']).describe('percent changes by a percentage, fixed by an amount'),
    change: z
      .number()
      .finite()
      .min(-1_000_000)
      .max(1_000_000)
      .describe('Signed change. -10 with mode percent lowers prices by 10%'),
    target: z
      .enum(['regular', 'sale'])
      .optional()
      .describe('regular adjusts the regular price (default). sale sets the sale price from the regular price'),
    decimals: z.number().int().min(0).max(4).optional().describe('Decimal places to round to. Defaults to 2'),
  })
  .strict();

export const salesAnalyticsInput = z
  .object({
    after: isoDateTimeSchema.describe('Include orders created at or after this date-time'),
    before: isoDateTimeSchema.optional().describe('Include orders created before this date-time. Defaults to now'),
    statuses: z
      .array(orderStatusSchema)
      .min(1)
      .max(7)
      .optional()
      .describe('Order statuses that count as sales. Defaults to processing and completed'),
    groupBy: z.enum(['day', 'week', 'month']).optional().describe('Time bucket for the series. Defaults to day'),
    top: z.number().int().min(1).max(50).optional().describe('How many top products to return. Defaults to 10'),
    maxOrders: z
      .number()
      .int()
      .min(1)
      .max(5_000)
      .optional()
      .describe('Stop after this many orders. Defaults to 1000. The result says when it was truncated'),
  })
  .strict();

export const lowStockReportInput = z
  .object({
    threshold: z.number().int().min(0).max(1_000_000).optional().describe('Report managed stock at or below this. Defaults to 5'),
    includeOutOfStock: z.boolean().optional().describe('Include out-of-stock products. Defaults to true'),
    maxProducts: z.number().int().min(1).max(5_000).optional().describe('Products to scan. Defaults to 500'),
    includeVariations: z
      .boolean()
      .optional()
      .describe('Check each variation of variable products. Defaults to true'),
    maxVariations: z.number().int().min(1).max(20_000).optional().describe('Variations to scan. Defaults to 2000'),
  })
  .strict();

const redactPiiField = z
  .boolean()
  .optional()
  .describe('Mask names, emails, phones, and street addresses in the result. Stores can force this on');

export const getCouponInput = z
  .object({
    id: resourceId.describe('Coupon ID'),
  })
  .strict();

export const updateCouponInput = z
  .object({
    id: resourceId.describe('Coupon ID'),
    amount: moneySchema.optional(),
    discountType: z.enum(['percent', 'fixed_cart', 'fixed_product']).optional(),
    description: z.string().max(5_000).optional(),
    dateExpires: z
      .union([dateOrDateTimeSchema, z.null()])
      .optional()
      .describe('New expiry as YYYY-MM-DD or an ISO-8601 date-time, or null to remove it'),
    individualUse: z.boolean().optional(),
    usageLimit: z.union([z.number().int().positive().max(1_000_000), z.null()]).optional(),
    usageLimitPerUser: z.union([z.number().int().positive().max(1_000_000), z.null()]).optional(),
    freeShipping: z.boolean().optional(),
    minimumAmount: moneySchema.optional(),
    maximumAmount: moneySchema.optional(),
    productIds: z.array(resourceId).max(100).optional(),
    excludedProductIds: z.array(resourceId).max(100).optional(),
    emailRestrictions: z.array(z.email()).max(50).optional(),
  })
  .strict();

export const deleteCouponInput = z
  .object({
    id: resourceId.describe('Coupon ID'),
    force: z
      .boolean()
      .optional()
      .describe('Delete permanently instead of moving to the trash. Defaults to false'),
  })
  .strict();

export const couponPerformanceInput = z
  .object({
    after: isoDateTimeSchema.describe('Include orders created at or after this date-time'),
    before: isoDateTimeSchema.optional().describe('Include orders created before this date-time. Defaults to now'),
    statuses: z.array(orderStatusSchema).min(1).max(7).optional().describe('Defaults to processing and completed'),
    code: z.string().trim().min(1).max(100).optional().describe('Only report this coupon code'),
    maxOrders: z.number().int().min(1).max(5_000).optional().describe('Defaults to 1000'),
  })
  .strict();

export const scheduleSaleInput = z
  .object({
    productIds: z.array(resourceId).min(1).max(100).describe('Simple or external products to put on sale'),
    discountPercent: z.number().gt(0).lt(100).describe('Discount from the regular price, for example 20 for 20% off'),
    startsAt: dateOrDateTimeSchema.optional().describe('Sale start. Omit to start now'),
    endsAt: dateOrDateTimeSchema.optional().describe('Sale end. Omit for no end date'),
    decimals: z.number().int().min(0).max(4).optional().describe('Decimal places to round to. Defaults to 2'),
  })
  .strict();

export const endSaleInput = z
  .object({
    productIds: z.array(resourceId).min(1).max(100).describe('Products whose sale price and sale dates are cleared'),
  })
  .strict();

const addressSchema = z
  .object({
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    company: z.string().trim().max(200).optional(),
    address1: z.string().trim().max(200).optional(),
    address2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(100).optional(),
    state: z.string().trim().max(100).optional(),
    postcode: z.string().trim().max(20).optional(),
    country: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/, 'Use a two-letter ISO country code')
      .optional(),
    phone: z.string().trim().max(40).optional(),
  })
  .strict();

export const updateCustomerInput = z
  .object({
    id: resourceId.describe('Customer ID'),
    email: z.email().optional(),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    billing: addressSchema.extend({ email: z.email().optional() }).optional(),
    shipping: addressSchema.optional(),
  })
  .strict();

export const listCustomersRedactableInput = listCustomersInput.extend({ redactPii: redactPiiField });
export const getCustomerRedactableInput = getCustomerInput.extend({ redactPii: redactPiiField });

export const customerOrdersInput = z
  .object({
    customerId: resourceId.describe('Customer ID'),
    maxOrders: z.number().int().min(1).max(1_000).optional().describe('Orders to read. Defaults to 200'),
    recent: z.number().int().min(0).max(50).optional().describe('How many recent orders to list. Defaults to 10'),
    redactPii: redactPiiField,
  })
  .strict();

export const customerSegmentsInput = z
  .object({
    after: isoDateTimeSchema.describe('Include orders created at or after this date-time'),
    before: isoDateTimeSchema.optional().describe('Include orders created before this date-time. Defaults to now'),
    statuses: z.array(orderStatusSchema).min(1).max(7).optional().describe('Defaults to processing and completed'),
    vipShare: z
      .number()
      .gt(0)
      .max(50)
      .optional()
      .describe('Percentage of customers by spend counted as VIP. Defaults to 10'),
    atRiskDays: z
      .number()
      .int()
      .min(1)
      .max(3_650)
      .optional()
      .describe('Repeat customers with no order in this many days are at risk. Defaults to 60'),
    membersPerSegment: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Customers to list per segment. Defaults to 10'),
    maxOrders: z.number().int().min(1).max(10_000).optional().describe('Defaults to 2000'),
    redactPii: redactPiiField,
  })
  .strict();

export const listOrderNotesInput = z
  .object({
    orderId: resourceId.describe('Order ID'),
    type: z.enum(['any', 'customer', 'internal']).optional().describe('Defaults to any'),
  })
  .strict();

export const deleteOrderNoteInput = z
  .object({
    orderId: resourceId.describe('Order ID'),
    noteId: resourceId.describe('Note ID'),
  })
  .strict();

export const getOrderTrackingInput = z
  .object({
    orderId: resourceId.describe('Order ID'),
  })
  .strict();

export const fulfillOrderInput = z
  .object({
    orderId: resourceId.describe('Order ID'),
    carrier: z.string().trim().min(1).max(100).describe('Carrier name, such as DHL or Post'),
    trackingNumber: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9 ._/-]+$/, 'Use letters, digits, spaces, dots, dashes, or slashes')
      .describe('Tracking number'),
    trackingUrl: httpUrlSchema.optional().describe('Tracking page URL'),
    shippedAt: isoDateSchema.optional().describe('Ship date, YYYY-MM-DD. Defaults to today (UTC)'),
    markCompleted: z.boolean().optional().describe('Set the order status to completed. Defaults to true'),
    notifyCustomer: z.boolean().optional().describe('Add a customer-visible note with the tracking details. Defaults to true'),
  })
  .strict();

export const WEBHOOK_TOPICS = [
  'coupon.created',
  'coupon.updated',
  'coupon.deleted',
  'coupon.restored',
  'customer.created',
  'customer.updated',
  'customer.deleted',
  'order.created',
  'order.updated',
  'order.deleted',
  'order.restored',
  'product.created',
  'product.updated',
  'product.deleted',
  'product.restored',
] as const;

export const listWebhooksInput = z
  .object({
    page: pageSchema,
    perPage: perPageSchema,
    status: z.enum(['all', 'active', 'paused', 'disabled']).optional(),
  })
  .strict();

export const getWebhookInput = z
  .object({
    id: resourceId.describe('Webhook ID'),
  })
  .strict();

export const createWebhookInput = z
  .object({
    name: z.string().trim().min(1).max(200).describe('Name shown in WooCommerce'),
    topic: z.enum(WEBHOOK_TOPICS).describe('Event that triggers the webhook'),
    deliveryUrl: z
      .url()
      .refine((value) => value.startsWith('https://'), 'Use an https URL')
      .describe('Public https URL that receives deliveries, such as this server\'s webhook receiver'),
    status: z.enum(['active', 'paused', 'disabled']).optional().describe('Defaults to active'),
  })
  .strict();

export const updateWebhookInput = z
  .object({
    id: resourceId.describe('Webhook ID'),
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['active', 'paused', 'disabled']).optional(),
    deliveryUrl: z
      .url()
      .refine((value) => value.startsWith('https://'), 'Use an https URL')
      .optional(),
    rotateSecret: z
      .boolean()
      .optional()
      .describe("Set the webhook's secret to this store's configured webhook secret"),
  })
  .strict();

export const deleteWebhookInput = z
  .object({
    id: resourceId.describe('Webhook ID'),
  })
  .strict();

export const listWebhookEventsInput = z
  .object({
    topic: z
      .string()
      .trim()
      .regex(/^[a-z_]+\.(?:\*|[a-z_]+)$/, 'Use a topic such as order.created or order.*')
      .optional()
      .describe('Filter by topic. order.* matches every order topic'),
    sinceId: z.number().int().min(0).optional().describe('Only events with a larger id, for polling'),
    limit: z.number().int().min(1).max(200).optional().describe('Defaults to 20'),
    includePayload: z.boolean().optional().describe('Include each delivery payload. Defaults to false'),
  })
  .strict();

export const listShippingZonesInput = z
  .object({
    includeMethods: z.boolean().optional().describe('Include each zone\'s shipping methods. Defaults to true'),
    includeLocations: z.boolean().optional().describe('Include each zone\'s locations. Defaults to true'),
  })
  .strict();

export const listTaxRatesInput = z
  .object({
    page: pageSchema,
    perPage: perPageSchema,
    taxClass: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{1,100}$/, 'Use a tax class slug such as standard or reduced-rate')
      .optional()
      .describe('Tax class slug'),
  })
  .strict();
