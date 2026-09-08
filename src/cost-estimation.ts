// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { buildTokenUsage, sumTokenUsage } from './adapters/usage.js';
import {
  getDefaultPricingCachePath,
  isObject,
  loadPricingCatalog,
  PRICING_URL,
} from './pricing-cache.js';
import type {
  DoneUsage,
  TokenUsage,
  UsageCoverage,
  UsageRecord,
} from './types.js';

export { getDefaultPricingCachePath } from './pricing-cache.js';

/** USD per million tokens; cache and reasoning rates replace the base rate. */
export interface TokenPrices {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface CostEstimationOptions {
  /** Authoritative rates for the entire reported workload; bypasses all I/O. */
  prices?: TokenPrices;
  /** Assumed model only where a usage record does not identify its model. */
  model?: string;
  /** Explicit models.dev provider, overriding native authentication families. */
  provider?: string;
  /** Override the file returned by getDefaultPricingCachePath(). */
  cachePath?: string;
  /** Catalog retrieval deadline, including the response body; default 5000. */
  timeoutMs?: number;
}

export type CostEstimationUnavailableReason =
  | 'tokens-unavailable'
  | 'invalid-usage'
  | 'invalid-prices'
  | 'missing-model'
  | 'missing-provider'
  | 'model-not-found'
  | 'missing-price'
  | 'catalog-unavailable'
  | 'invalid-options'
  | 'unsupported-pricing';

export interface CostEstimateRecord {
  amount: number;
  model?: string;
  provider?: string;
  tokens: TokenUsage;
  /** The selected prices, sufficient to repeat this record's calculation. */
  prices: TokenPrices;
}

export type CostEstimateResult =
  | {
      status: 'estimated';
      amount: number;
      currency: 'USD';
      coverage: UsageCoverage;
      estimatedAt: string;
      source:
        | { type: 'caller' }
        | {
            type: 'models.dev';
            url: typeof PRICING_URL;
            fetchedAt: string;
            stale: boolean;
          };
      records: CostEstimateRecord[];
      assumptions: string[];
    }
  | {
      status: 'unavailable';
      reason: CostEstimationUnavailableReason;
      message: string;
    };

type Unavailable = Extract<CostEstimateResult, { status: 'unavailable' }>;
type Snapshot = {
  coverage: UsageCoverage;
  totals: TokenUsage;
  records: UsageRecord[];
};

function unavailable(
  reason: CostEstimationUnavailableReason,
  message: string,
): Unavailable {
  return { status: 'unavailable', reason, message };
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function name(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readTokens(value: unknown): TokenUsage | undefined {
  if (!isObject(value) || !isObject(value.input) || !isObject(value.output)) {
    return undefined;
  }
  const input = value.input;
  const output = value.output;
  const keys = ['total', 'uncached', 'cacheRead', 'cacheWrite'] as const;
  const outputKeys = ['total', 'visible', 'reasoning'] as const;
  for (const [side, fields] of [
    [input, keys],
    [output, outputKeys],
  ] as const) {
    for (const field of fields) {
      const count = side[field];
      if (count === undefined && field !== 'total') continue;
      if (
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0
      ) {
        return undefined;
      }
    }
  }
  return buildTokenUsage(
    Object.fromEntries(
      keys
        .filter((key) => input[key] !== undefined)
        .map((key) => [key, input[key]]),
    ) as unknown as TokenUsage['input'],
    Object.fromEntries(
      outputKeys
        .filter((key) => output[key] !== undefined)
        .map((key) => [key, output[key]]),
    ) as unknown as TokenUsage['output'],
  );
}

function snapshotUsage(usage: DoneUsage): Snapshot | Unavailable {
  if (!isObject(usage) || usage.tokens === undefined) {
    return unavailable(
      'tokens-unavailable',
      'No reported token usage is available.',
    );
  }
  const report = usage.tokens;
  if (
    !isObject(report) ||
    (report.coverage !== 'complete' && report.coverage !== 'partial')
  ) {
    return unavailable(
      'invalid-usage',
      'Token coverage must be complete or partial.',
    );
  }
  const totals = readTokens(report.totals);
  if (!totals)
    return unavailable('invalid-usage', 'Token totals or details are invalid.');
  const records: UsageRecord[] = [];
  if (report.records !== undefined) {
    if (!Array.isArray(report.records) || report.records.length === 0) {
      return unavailable(
        'invalid-usage',
        'Token records must be a nonempty array.',
      );
    }
    for (const raw of report.records) {
      if (!isObject(raw))
        return unavailable('invalid-usage', 'A token record is invalid.');
      const tokens = readTokens(raw.tokens);
      if (
        !tokens ||
        (raw.model !== undefined && !name(raw.model)) ||
        (raw.provider !== undefined && !name(raw.provider)) ||
        (raw.requests !== undefined &&
          (typeof raw.requests !== 'number' ||
            !Number.isSafeInteger(raw.requests) ||
            raw.requests < 1))
      ) {
        return unavailable(
          'invalid-usage',
          'A token record has invalid counts or identity.',
        );
      }
      records.push({
        tokens,
        ...(raw.model !== undefined ? { model: raw.model as string } : {}),
        ...(raw.provider !== undefined
          ? { provider: raw.provider as string }
          : {}),
        ...(raw.requests !== undefined
          ? { requests: raw.requests as number }
          : {}),
      });
    }
    const sum = sumTokenUsage(records);
    if (!sum)
      return unavailable('invalid-usage', 'Token record sums are invalid.');
    for (const side of ['input', 'output'] as const) {
      for (const [key, value] of Object.entries(totals[side])) {
        if (sum[side][key as keyof (typeof sum)[typeof side]] !== value) {
          return unavailable(
            'invalid-usage',
            'Token records do not reconcile with reported totals.',
          );
        }
      }
    }
  }
  return { coverage: report.coverage, totals, records };
}

function readPrices(value: unknown, catalog = false): TokenPrices | undefined {
  if (!isObject(value)) return undefined;
  const aliases = {
    input: 'input',
    output: 'output',
    cacheRead: catalog ? 'cache_read' : 'cacheRead',
    cacheWrite: catalog ? 'cache_write' : 'cacheWrite',
    reasoning: 'reasoning',
  } as const;
  const prices: Partial<TokenPrices> = {};
  for (const [field, alias] of Object.entries(aliases)) {
    const rate = value[alias];
    if (rate === undefined && field !== 'input' && field !== 'output') continue;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)
      return undefined;
    prices[field as keyof TokenPrices] = rate;
  }
  return prices as TokenPrices;
}

function calculate(
  tokens: TokenUsage,
  prices: TokenPrices,
  assumptions: Set<string>,
): number | Unavailable {
  const input = tokens.input;
  const output = tokens.output;
  const cacheRead = input.cacheRead ?? 0;
  const cacheWrite = input.cacheWrite ?? 0;
  for (const [field, count] of [
    ['cacheRead', cacheRead],
    ['cacheWrite', cacheWrite],
  ] as const) {
    if (count > 0 && prices[field] === undefined) {
      return unavailable(
        'missing-price',
        `Reported ${field} tokens have no supplied price.`,
      );
    }
  }
  if (
    input.total > 0 &&
    (input.cacheRead === undefined || input.cacheWrite === undefined)
  ) {
    assumptions.add(
      'Unreported cache quantities are priced at the ordinary input rate; reported cache quantities retain their own rates.',
    );
  }
  let outputAmount = (output.total / 1_000_000) * prices.output;
  if (prices.reasoning !== undefined && prices.reasoning !== prices.output) {
    if (output.reasoning === undefined && output.total > 0) {
      return unavailable(
        'unsupported-pricing',
        'A distinct reasoning price requires the reasoning-token quantity.',
      );
    }
    const reasoning = output.reasoning ?? 0;
    outputAmount =
      ((output.total - reasoning) / 1_000_000) * prices.output +
      (reasoning / 1_000_000) * prices.reasoning;
  }
  const amount =
    ((input.total - cacheRead - cacheWrite) / 1_000_000) * prices.input +
    (cacheRead / 1_000_000) * (prices.cacheRead ?? 0) +
    (cacheWrite / 1_000_000) * (prices.cacheWrite ?? 0) +
    outputAmount;
  return Number.isFinite(amount) && amount >= 0
    ? amount
    : unavailable(
        'invalid-prices',
        'The supplied prices overflow the cost calculation.',
      );
}

function catalogPrices(
  model: Record<string, unknown>,
  record: UsageRecord,
  assumptions: Set<string>,
): TokenPrices | Unavailable {
  const cost = model.cost;
  const base = readPrices(cost, true);
  if (!isObject(cost) || !base)
    return unavailable(
      'missing-price',
      'The selected model has no valid token prices.',
    );
  const tiers: { size: number; prices: TokenPrices }[] = [];
  if (hasOwn(cost, 'tiers')) {
    if (!Array.isArray(cost.tiers))
      return unavailable(
        'unsupported-pricing',
        'The catalog pricing tiers are invalid.',
      );
    for (const row of cost.tiers) {
      const prices = readPrices(row, true);
      if (
        !isObject(row) ||
        !isObject(row.tier) ||
        row.tier.type !== 'context' ||
        typeof row.tier.size !== 'number' ||
        !Number.isSafeInteger(row.tier.size) ||
        row.tier.size < 0 ||
        !prices
      ) {
        return unavailable(
          'unsupported-pricing',
          'The catalog contains an unsupported or invalid pricing tier.',
        );
      }
      const size = row.tier.size;
      if (tiers.some((tier) => tier.size === size)) {
        return unavailable(
          'unsupported-pricing',
          'The catalog repeats a pricing tier threshold.',
        );
      }
      tiers.push({ size, prices });
    }
  } else if (hasOwn(cost, 'context_over_200k')) {
    const prices = readPrices(cost.context_over_200k, true);
    if (!prices)
      return unavailable(
        'unsupported-pricing',
        'The legacy context price is invalid.',
      );
    // Legacy spelling means strictly over 200k, unlike the modern band start.
    tiers.push({ size: 200_001, prices });
  }
  if (tiers.length > 0 && record.requests !== 1) {
    assumptions.add(
      'Standard context prices are assumed for aggregated or unknown request counts; cumulative input does not establish a per-request context tier.',
    );
    return base;
  }
  tiers.sort((a, b) => a.size - b.size);
  let selected = base;
  for (const tier of tiers) {
    if (record.tokens.input.total >= tier.size) selected = tier.prices;
  }
  return selected;
}

/** Estimate reported text-token usage without changing runtime accounting. */
export async function estimateCost(
  usage: DoneUsage,
  options: CostEstimationOptions = {},
): Promise<CostEstimateResult> {
  // Snapshot every calculation input before catalog retrieval yields control.
  const snapshot = snapshotUsage(usage);
  if ('status' in snapshot) return snapshot;
  if (
    !isObject(options) ||
    (options.model !== undefined && !name(options.model)) ||
    (options.provider !== undefined && !name(options.provider))
  ) {
    return unavailable(
      'invalid-options',
      'Model and provider options must be nonempty strings.',
    );
  }
  const assumedModel = options.model;
  const assumedProvider = options.provider;
  const assumptions = new Set<string>([
    'Text-token prices exclude subscription fees and other non-token charges; this estimate is not a bill.',
  ]);
  const records: CostEstimateRecord[] = [];
  let source: Extract<CostEstimateResult, { status: 'estimated' }>['source'];
  if (options.prices !== undefined) {
    const prices = readPrices(options.prices);
    if (!prices)
      return unavailable(
        'invalid-prices',
        'Caller prices require finite nonnegative input and output rates.',
      );
    assumptions.add(
      'Caller prices apply uniformly to all reported models and requests.',
    );
    const scopes =
      snapshot.records.length > 0
        ? snapshot.records
        : [{ tokens: snapshot.totals }];
    for (const record of scopes) {
      const amount = calculate(record.tokens, prices, assumptions);
      if (typeof amount !== 'number') return amount;
      records.push({
        amount,
        tokens: record.tokens,
        prices: { ...prices },
        ...(record.model ? { model: record.model } : {}),
        ...(record.provider ? { provider: record.provider } : {}),
      });
    }
    source = { type: 'caller' };
  } else {
    const timeoutMs = options.timeoutMs ?? 5000;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2_147_483_647 ||
      (options.cachePath !== undefined && !name(options.cachePath))
    ) {
      return unavailable(
        'invalid-options',
        'The cache path and retrieval timeout must be valid.',
      );
    }
    const scopes =
      snapshot.records.length > 0
        ? snapshot.records
        : [{ tokens: snapshot.totals }];
    const identified = scopes.map((record) => {
      const model = record.model ?? assumedModel;
      const provider = assumedProvider ?? record.provider;
      if (!record.model && assumedModel)
        assumptions.add(
          `Caller model ${assumedModel} is assumed where the runtime did not identify a model.`,
        );
      if (assumedProvider)
        assumptions.add(
          `Caller provider ${assumedProvider} selects the pricing catalog, independently of the runtime's authentication or provider identity.`,
        );
      return { ...record, model, provider };
    });
    if (identified.some((record) => !record.model))
      return unavailable(
        'missing-model',
        'Supply a model assumption when the token report does not identify a model.',
      );
    if (identified.some((record) => !record.provider))
      return unavailable(
        'missing-provider',
        'Supply a models.dev provider when the token report does not identify its pricing provider.',
      );
    const loaded = await loadPricingCatalog(
      options.cachePath ?? getDefaultPricingCachePath(),
      timeoutMs,
    );
    if (!loaded)
      return unavailable(
        'catalog-unavailable',
        'No valid models.dev catalog is available.',
      );
    source = {
      type: 'models.dev',
      url: PRICING_URL,
      fetchedAt: loaded.fetchedAt,
      stale: loaded.stale,
    };
    assumptions.add(
      'Catalog prices use the standard service mode; use caller prices for fast, priority, regional, or other rate adjustments.',
    );
    for (const record of identified) {
      const providerId = record.provider!;
      const modelId = record.model!;
      const provider = hasOwn(loaded.catalog, providerId)
        ? loaded.catalog[providerId]
        : undefined;
      const models = isObject(provider) ? provider.models : undefined;
      const model =
        isObject(models) && hasOwn(models, modelId)
          ? models[modelId]
          : undefined;
      if (!isObject(model))
        return unavailable(
          'model-not-found',
          `No models.dev entry exists for ${providerId}/${modelId}.`,
        );
      const prices = catalogPrices(model, record, assumptions);
      if ('status' in prices) return prices;
      const amount = calculate(record.tokens, prices, assumptions);
      if (typeof amount !== 'number') return amount;
      records.push({
        amount,
        model: modelId,
        provider: providerId,
        tokens: record.tokens,
        prices,
      });
    }
  }
  const amount = records.reduce((total, record) => total + record.amount, 0);
  if (!Number.isFinite(amount))
    return unavailable(
      'invalid-prices',
      'The estimated record sum is not finite.',
    );
  return {
    status: 'estimated',
    amount,
    currency: 'USD',
    coverage: snapshot.coverage,
    estimatedAt: new Date().toISOString(),
    source,
    records,
    assumptions: [...assumptions],
  };
}
