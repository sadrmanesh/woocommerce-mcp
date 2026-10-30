import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';

import { asBoolean, asCount, asDecimal, asString, expectArray, expectRecord, isRecord } from '../woocommerce/json.js';
import { pageQuery, type Runtime, type ToolContext } from './context.js';
import { toolNames } from './names.js';
import { defineTool, READ } from './registry.js';
import { emptyInput, listShippingZonesInput, listTaxRatesInput } from './schemas.js';

export type ListShippingZonesInput = z.infer<typeof listShippingZonesInput>;
export type ListTaxRatesInput = z.infer<typeof listTaxRatesInput>;

export function registerShippingTools(server: McpServer, runtime: Runtime): void {
  defineTool(server, runtime, {
    name: toolNames.listShippingZones,
    title: 'List shipping zones',
    description: 'List shipping zones in match order, with their locations and enabled or disabled shipping methods and costs.',
    input: listShippingZonesInput,
    annotations: READ,
    write: false,
    run: listShippingZones,
  });
  defineTool(server, runtime, {
    name: toolNames.listShippingMethods,
    title: 'List shipping methods',
    description: 'List the shipping method types available on the store, such as flat rate and free shipping.',
    input: emptyInput,
    annotations: READ,
    write: false,
    run: listShippingMethods,
  });
  defineTool(server, runtime, {
    name: toolNames.listTaxRates,
    title: 'List tax rates',
    description: 'List tax rates with country, state, postcodes, cities, rate, and class. Filter by tax class slug.',
    input: listTaxRatesInput,
    annotations: READ,
    write: false,
    run: listTaxRates,
  });
  defineTool(server, runtime, {
    name: toolNames.listTaxClasses,
    title: 'List tax classes',
    description: 'List tax classes, such as standard, reduced rate, and zero rate.',
    input: emptyInput,
    annotations: READ,
    write: false,
    run: listTaxClasses,
  });
}

/** Method settings arrive as { key: { value, label, ... } }; keep the values that matter. */
function methodSettings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const settings: Record<string, string> = {};
  for (const key of ['title', 'cost', 'min_amount', 'requires', 'tax_status', 'class_costs', 'no_class_cost']) {
    const setting = value[key];
    const raw = isRecord(setting) ? setting.value : undefined;
    if (typeof raw === 'string' && raw !== '') settings[key] = raw;
  }
  return settings;
}

export function summarizeZoneMethod(value: unknown) {
  const record = expectRecord(value, 'shipping zone method');
  return {
    instanceId: asCount(record.instance_id),
    methodId: asString(record.method_id),
    title: asString(record.title),
    enabled: asBoolean(record.enabled),
    order: asCount(record.order),
    settings: methodSettings(record.settings),
  };
}

export async function listShippingZones(ctx: ToolContext, input: ListShippingZonesInput) {
  const includeMethods = input.includeMethods ?? true;
  const includeLocations = input.includeLocations ?? true;
  const zones = expectArray((await ctx.client.get('shipping/zones')).data, 'shipping zones');
  const result = [];
  for (const zone of zones) {
    const record = expectRecord(zone, 'shipping zone');
    const id = asCount(record.id);
    const entry: Record<string, unknown> = { id, name: asString(record.name), order: asCount(record.order) };
    if (id !== null && includeLocations) {
      // Zone 0 covers every location not matched by another zone and has no location list.
      entry.locations =
        id === 0
          ? []
          : expectArray((await ctx.client.get(`shipping/zones/${id}/locations`)).data, 'zone locations')
              .filter(isRecord)
              .map((location) => ({ code: asString(location.code), type: asString(location.type) }));
    }
    if (id !== null && includeMethods) {
      entry.methods = expectArray((await ctx.client.get(`shipping/zones/${id}/methods`)).data, 'zone methods').map(
        summarizeZoneMethod,
      );
    }
    result.push(entry);
  }
  return { zones: result };
}

export async function listShippingMethods(ctx: ToolContext) {
  const methods = expectArray((await ctx.client.get('shipping_methods')).data, 'shipping methods');
  return {
    methods: methods.filter(isRecord).map((method) => ({
      id: asString(method.id),
      title: asString(method.title),
      description: asString(method.description),
    })),
  };
}

export async function listTaxRates(ctx: ToolContext, input: ListTaxRatesInput) {
  const paging = pageQuery(input, ctx.defaultPerPage);
  const response = await ctx.client.get('taxes', { ...paging, class: input.taxClass });
  return {
    items: expectArray(response.data, 'tax rates')
      .filter(isRecord)
      .map((rate) => ({
        id: asCount(rate.id),
        country: asString(rate.country),
        state: asString(rate.state),
        postcodes: Array.isArray(rate.postcodes) ? rate.postcodes.filter((code) => typeof code === 'string') : [],
        cities: Array.isArray(rate.cities) ? rate.cities.filter((city) => typeof city === 'string') : [],
        rate: asDecimal(rate.rate),
        name: asString(rate.name),
        priority: asCount(rate.priority),
        compound: asBoolean(rate.compound),
        shipping: asBoolean(rate.shipping),
        class: asString(rate.class),
      })),
    pagination: {
      page: paging.page,
      perPage: paging.per_page,
      total: response.pagination.total,
      totalPages: response.pagination.totalPages,
    },
  };
}

export async function listTaxClasses(ctx: ToolContext) {
  const classes = expectArray((await ctx.client.get('taxes/classes')).data, 'tax classes');
  return {
    classes: classes.filter(isRecord).map((item) => ({ slug: asString(item.slug), name: asString(item.name) })),
  };
}
