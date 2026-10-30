import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { InputError } from '../woocommerce/errors.js';
import { compact, expectArray, expectRecord, stripLinks } from '../woocommerce/json.js';
import { summarizeProduct } from '../woocommerce/present.js';
import { pageQuery, type Page, type Runtime, type ToolContext } from './context.js';
import { toolNames } from './names.js';
import { CREATE, defineTool, READ, UPDATE } from './registry.js';
import {
  createProductInput,
  getProductInput,
  listProductsInput,
  moneyToString,
  searchProductsInput,
  updateProductInput,
} from './schemas.js';

export type ListProductsInput = z.infer<typeof listProductsInput>;
export type SearchProductsInput = z.infer<typeof searchProductsInput>;
export type GetProductInput = z.infer<typeof getProductInput>;
export type CreateProductInput = z.infer<typeof createProductInput>;
export type UpdateProductInput = z.infer<typeof updateProductInput>;

export function registerProductTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.listProducts,
    title: 'List products',
    description: 'List products in the WooCommerce catalog. Returns a short summary per product plus pagination.',
    input: listProductsInput,
    annotations: READ,
    write: false,
    run: listProducts,
  });
  defineTool(server, runtime, {
    name: toolNames.searchProducts,
    title: 'Search products',
    description: 'Search products by name, SKU, or description. Returns the same summary shape as the product list.',
    input: searchProductsInput,
    annotations: READ,
    write: false,
    run: searchProducts,
  });
  defineTool(server, runtime, {
    name: toolNames.getProduct,
    title: 'Get product',
    description: 'Get one product by ID, without the REST _links payload.',
    input: getProductInput,
    annotations: READ,
    write: false,
    run: getProduct,
  });
  defineTool(server, runtime, {
    name: toolNames.createProduct,
    title: 'Create product',
    description: 'Create a product. Prefer status "draft" unless the user asked to publish.',
    input: createProductInput,
    annotations: CREATE,
    write: true,
    run: createProduct,
  });
  defineTool(server, runtime, {
    name: toolNames.updateProduct,
    title: 'Update product',
    description: 'Update fields on an existing product. Only fields you send are changed.',
    input: updateProductInput,
    annotations: UPDATE,
    write: true,
    run: updateProduct,
  });
}

export async function listProducts(ctx: ToolContext, input: ListProductsInput): Promise<Page<ReturnType<typeof summarizeProduct>>> {
  const paging = pageQuery(input, ctx.defaultPerPage);
  const response = await ctx.client.get('products', {
    ...paging,
    search: input.search,
    status: input.status,
    type: input.type,
    sku: input.sku,
    category: input.category,
    tag: input.tag,
    stock_status: input.stockStatus,
    featured: input.featured,
    on_sale: input.onSale,
    min_price: input.minPrice,
    max_price: input.maxPrice,
    after: input.after,
    before: input.before,
    orderby: input.orderBy,
    order: input.order,
  });
  return {
    items: expectArray(response.data, 'product list').map((item) => summarizeProduct(item)),
    pagination: {
      page: paging.page,
      perPage: paging.per_page,
      total: response.pagination.total,
      totalPages: response.pagination.totalPages,
    },
  };
}

export async function searchProducts(
  ctx: ToolContext,
  input: SearchProductsInput,
): Promise<Page<ReturnType<typeof summarizeProduct>>> {
  return listProducts(ctx, {
    page: input.page,
    perPage: input.perPage,
    search: input.query,
    status: input.status,
    type: input.type,
    sku: input.sku,
    category: input.category,
    tag: input.tag,
    stockStatus: input.stockStatus,
    featured: input.featured,
    onSale: input.onSale,
    minPrice: input.minPrice,
    maxPrice: input.maxPrice,
    after: input.after,
    before: input.before,
    orderBy: input.orderBy,
    order: input.order,
  });
}

export async function getProduct(ctx: ToolContext, input: GetProductInput): Promise<unknown> {
  const response = await ctx.client.get(`products/${input.id}`);
  return stripLinks(expectRecord(response.data, 'product'));
}

export async function createProduct(ctx: ToolContext, input: CreateProductInput): Promise<unknown> {
  const response = await ctx.client.post('products', toProductPayload(input));
  return stripLinks(expectRecord(response.data, 'product'));
}

export async function updateProduct(ctx: ToolContext, input: UpdateProductInput): Promise<unknown> {
  const payload = toProductPayload(input);
  if (Object.keys(payload).length === 0) {
    throw new InputError('Provide at least one product field to update.');
  }
  const response = await ctx.client.put(`products/${input.id}`, payload);
  return stripLinks(expectRecord(response.data, 'product'));
}

export function toProductPayload(input: Omit<UpdateProductInput, 'id'>): Record<string, unknown> {
  const dimensions = input.dimensions ? compact(input.dimensions) : undefined;
  return compact({
    name: input.name,
    type: input.type,
    status: input.status,
    regular_price: input.regularPrice === undefined ? undefined : moneyToString(input.regularPrice),
    sale_price: input.salePrice === undefined ? undefined : moneyToString(input.salePrice),
    description: input.description,
    short_description: input.shortDescription,
    sku: input.sku,
    manage_stock: input.manageStock ?? (input.stockQuantity === undefined ? undefined : true),
    stock_quantity: input.stockQuantity,
    stock_status: input.stockStatus,
    catalog_visibility: input.catalogVisibility,
    featured: input.featured,
    virtual: input.virtual,
    downloadable: input.downloadable,
    weight: input.weight,
    dimensions: dimensions && Object.keys(dimensions).length > 0 ? dimensions : undefined,
    categories: input.categories,
    tags: input.tags,
    images: input.images,
    external_url: input.externalUrl,
  });
}
