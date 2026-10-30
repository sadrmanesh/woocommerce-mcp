import {
  asBoolean,
  asCount,
  asDecimal,
  asString,
  expectArray,
  expectRecord,
  isRecord,
} from './json.js';

export interface ProductSummary {
  id: number | null;
  name: string | null;
  sku: string | null;
  type: string | null;
  status: string | null;
  price: string | null;
  regularPrice: string | null;
  salePrice: string | null;
  stockStatus: string | null;
  stockQuantity: number | null;
  manageStock: boolean | null;
  permalink: string | null;
}

export interface OrderLinePreview {
  name: string | null;
  quantity: number | null;
  total: string | null;
}

export interface OrderSummary {
  id: number | null;
  number: string | null;
  status: string | null;
  currency: string | null;
  total: string | null;
  dateCreated: string | null;
  dateModified: string | null;
  customerId: number | null;
  billing: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  } | null;
  lineItemCount: number;
  lineItems: OrderLinePreview[];
}

export interface CustomerSummary {
  id: number | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  role: string | null;
  dateCreated: string | null;
}

export interface CouponSummary {
  id: number | null;
  code: string | null;
  discountType: string | null;
  amount: string | null;
  description: string | null;
  dateExpires: string | null;
  usageCount: number | null;
  usageLimit: number | null;
  individualUse: boolean | null;
  freeShipping: boolean | null;
}

export interface StockView {
  id: number | null;
  productId: number;
  variationId: number | null;
  parentId: number | null;
  sku: string | null;
  name: string | null;
  manageStock: boolean | null;
  stockQuantity: number | null;
  stockStatus: string | null;
  backorders: string | null;
}

export interface SalesBucket {
  date: string;
  sales: string | null;
  orders: number | null;
  items: number | null;
  tax: string | null;
  shipping: string | null;
  discount: string | null;
  customers: number | null;
}

export interface SalesHeadline {
  totalSales: string | null;
  netSales: string | null;
  averageSales: string | null;
  totalOrders: number | null;
  totalItems: number | null;
  totalTax: string | null;
  totalShipping: string | null;
  totalRefunds: number | null;
  totalDiscount: string | null;
  totalCustomers: number | null;
  groupedBy: string | null;
  buckets: SalesBucket[];
}

export interface TotalRow {
  slug: string | null;
  name: string | null;
  total: string | number | null;
}

export interface TopSeller {
  title: string | null;
  productId: number | null;
  quantity: number | null;
}

export interface OrderNoteView {
  id: number | null;
  orderId: number;
  note: string | null;
  customerNote: boolean | null;
  author: string | null;
  dateCreated: string | null;
}

export function summarizeProduct(value: unknown): ProductSummary {
  const record = expectRecord(value, 'product');
  return {
    id: asCount(record.id),
    name: asString(record.name),
    sku: asString(record.sku),
    type: asString(record.type),
    status: asString(record.status),
    price: asDecimal(record.price),
    regularPrice: asDecimal(record.regular_price),
    salePrice: asDecimal(record.sale_price),
    stockStatus: asString(record.stock_status),
    stockQuantity: asCount(record.stock_quantity),
    manageStock: asBoolean(record.manage_stock),
    permalink: asString(record.permalink),
  };
}

export function summarizeOrder(value: unknown): OrderSummary {
  const record = expectRecord(value, 'order');
  const billing = isRecord(record.billing) ? record.billing : null;
  const lineItems = Array.isArray(record.line_items) ? record.line_items : [];
  return {
    id: asCount(record.id),
    number: asString(record.number),
    status: asString(record.status),
    currency: asString(record.currency),
    total: asDecimal(record.total),
    dateCreated: asString(record.date_created),
    dateModified: asString(record.date_modified),
    customerId: asCount(record.customer_id),
    billing: billing
      ? {
          firstName: asString(billing.first_name),
          lastName: asString(billing.last_name),
          email: asString(billing.email),
        }
      : null,
    lineItemCount: lineItems.length,
    lineItems: lineItems.slice(0, 3).map(summarizeLine),
  };
}

export function summarizeCustomer(value: unknown): CustomerSummary {
  const record = expectRecord(value, 'customer');
  return {
    id: asCount(record.id),
    email: asString(record.email),
    firstName: asString(record.first_name),
    lastName: asString(record.last_name),
    username: asString(record.username),
    role: asString(record.role),
    dateCreated: asString(record.date_created),
  };
}

export function summarizeCoupon(value: unknown): CouponSummary {
  const record = expectRecord(value, 'coupon');
  return {
    id: asCount(record.id),
    code: asString(record.code),
    discountType: asString(record.discount_type),
    amount: asDecimal(record.amount),
    description: asString(record.description),
    dateExpires: asString(record.date_expires),
    usageCount: asCount(record.usage_count),
    usageLimit: asCount(record.usage_limit),
    individualUse: asBoolean(record.individual_use),
    freeShipping: asBoolean(record.free_shipping),
  };
}

export function summarizeStock(value: unknown, productId: number, variationId?: number): StockView {
  const record = expectRecord(value, 'stock record');
  return {
    id: asCount(record.id),
    productId,
    variationId: variationId ?? null,
    parentId: asCount(record.parent_id),
    sku: asString(record.sku),
    name: asString(record.name),
    manageStock: asBoolean(record.manage_stock),
    stockQuantity: asCount(record.stock_quantity),
    stockStatus: asString(record.stock_status),
    backorders: asString(record.backorders),
  };
}

export function summarizeNote(value: unknown, orderId: number): OrderNoteView {
  const record = expectRecord(value, 'order note');
  return {
    id: asCount(record.id),
    orderId,
    note: asString(record.note),
    customerNote: asBoolean(record.customer_note),
    author: asString(record.author),
    dateCreated: asString(record.date_created),
  };
}

export function summarizeTotals(value: unknown, label: string): TotalRow[] {
  return expectArray(value, label).map((item) => {
    const record = expectRecord(item, label);
    const total = record.total;
    return {
      slug: asString(record.slug),
      name: asString(record.name),
      total: typeof total === 'string' || typeof total === 'number' ? total : null,
    };
  });
}

export function summarizeTopSellers(value: unknown): TopSeller[] {
  return expectArray(value, 'top sellers report').map((item) => {
    const record = expectRecord(item, 'top seller');
    return {
      title: asString(record.title),
      productId: asCount(record.product_id),
      quantity: asCount(record.quantity),
    };
  });
}

export function summarizeSales(value: unknown): SalesHeadline | null {
  const record = firstRecord(value);
  if (!record) return null;
  return {
    totalSales: asDecimal(record.total_sales),
    netSales: asDecimal(record.net_sales),
    averageSales: asDecimal(record.average_sales),
    totalOrders: asCount(record.total_orders),
    totalItems: asCount(record.total_items),
    totalTax: asDecimal(record.total_tax),
    totalShipping: asDecimal(record.total_shipping),
    totalRefunds: asCount(record.total_refunds),
    totalDiscount: asDecimal(record.total_discount),
    totalCustomers: asCount(record.total_customers),
    groupedBy: asString(record.totals_grouped_by),
    buckets: salesBuckets(record.totals),
  };
}

function summarizeLine(value: unknown): OrderLinePreview {
  if (!isRecord(value)) return { name: null, quantity: null, total: null };
  return {
    name: asString(value.name),
    quantity: asCount(value.quantity),
    total: asDecimal(value.total),
  };
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return isRecord(first) ? first : null;
  }
  return isRecord(value) ? value : null;
}

function salesBuckets(totals: unknown): SalesBucket[] {
  if (Array.isArray(totals)) {
    return totals.filter(isRecord).map((entry) => toBucket(asString(entry.date) ?? '', entry));
  }
  if (!isRecord(totals)) return [];
  return Object.keys(totals)
    .sort()
    .map((date) => {
      const entry = totals[date];
      return toBucket(date, isRecord(entry) ? entry : {});
    });
}

function toBucket(date: string, entry: Record<string, unknown>): SalesBucket {
  return {
    date,
    sales: asDecimal(entry.sales),
    orders: asCount(entry.orders),
    items: asCount(entry.items),
    tax: asDecimal(entry.tax),
    shipping: asDecimal(entry.shipping),
    discount: asDecimal(entry.discount),
    customers: asCount(entry.customers),
  };
}
