// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  estimateCost,
  getDefaultPricingCachePath,
  type CostEstimationOptions,
  type CostEstimateResult,
  type DoneUsage,
  type TokenPrices,
  type TokenUsage,
} from '../index.js';

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, homedir: vi.fn(original.homedir) };
});
vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});

const originalFetch = globalThis.fetch;
const catalogLimit = 16 * 1024 * 1024;
const ordinaryTokens: TokenUsage = {
  input: {
    total: 1_000_000,
    uncached: 700_000,
    cacheRead: 200_000,
    cacheWrite: 100_000,
  },
  output: { total: 200_000, visible: 150_000, reasoning: 50_000 },
};
const prices: TokenPrices = {
  input: 2,
  output: 10,
  cacheRead: 0.2,
  cacheWrite: 2.5,
};

function usage(tokens = ordinaryTokens): DoneUsage {
  return {
    toolUses: 3,
    tokens: { coverage: 'partial', totals: structuredClone(tokens) },
  };
}

function simpleUsage(total = 100): DoneUsage {
  return usage({
    input: { total, cacheRead: 0, cacheWrite: 0 },
    output: { total: 10 },
  });
}

function estimated(result: CostEstimateResult) {
  expect(result.status).toBe('estimated');
  if (result.status !== 'estimated') throw new Error(result.message);
  return result;
}

function catalog(
  cost: unknown = { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
) {
  return { openai: { id: 'openai', models: { luna: { id: 'luna', cost } } } };
}

function paddedJson(value: unknown, bytes: number): string {
  const json = JSON.stringify(value);
  return json + ' '.repeat(bytes - Buffer.byteLength(json));
}

async function withCatalog(
  run: (context: {
    cachePath: string;
    options: CostEstimationOptions;
    calls: () => number;
    respond: (handler: (response: ServerResponse) => void) => void;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'cligent-pricing-'));
  let calls = 0;
  let handler = (response: ServerResponse) =>
    response.end(JSON.stringify(catalog()));
  const server = createServer((_request, response) => {
    calls++;
    handler(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture server unavailable');
  const endpoint = `http://127.0.0.1:${address.port}/api.json`;
  const fetchSpy = vi.fn<typeof fetch>((url, init) => {
    expect(url).toBe('https://models.dev/api.json');
    return originalFetch(endpoint, init);
  });
  vi.stubGlobal('fetch', fetchSpy);
  const cachePath = join(directory, 'cache.json');
  try {
    await run({
      cachePath,
      options: {
        model: 'luna',
        provider: 'openai',
        cachePath,
        timeoutMs: 1000,
      },
      calls: () => calls,
      respond: (next) => {
        handler = next as typeof handler;
      },
    });
  } finally {
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

describe('optional public cost estimation', () => {
  it('prices caller usage without catalog I/O, preserves accounting, and avoids double charging', async () => {
    await withCatalog(async ({ options, calls, cachePath }) => {
      const input = usage();
      input.cost = { amount: 9, currency: 'USD', source: 'agent-estimate' };
      const original = structuredClone(input);
      const supplied = { ...prices, reasoning: 15 };
      const result = estimated(
        await estimateCost(input, { ...options, prices: supplied }),
      );
      expect(result.amount).toBeCloseTo(3.94, 12);
      expect(result.source).toEqual({ type: 'caller' });
      expect(result.coverage).toBe('partial');
      expect(result.records[0].prices).toEqual(supplied);
      expect(result.assumptions.join(' ')).toContain('uniformly');
      expect(
        estimated(
          await estimateCost(input, {
            prices: supplied,
            model: '',
            provider: ' ',
            cachePath: '',
            timeoutMs: NaN,
          }),
        ).amount,
      ).toBe(result.amount);
      expect(input).toEqual(original);
      supplied.input = 99;
      input.tokens!.totals.input.total = 99;
      expect(result.records[0].prices.input).toBe(2);
      expect(result.records[0].tokens.input.total).toBe(1_000_000);
      expect(calls()).toBe(0);
      await expect(readFile(cachePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('distinguishes explicit free prices and measured zero from missing accounting or rates', async () => {
    const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(
      estimated(await estimateCost(usage(), { prices: free })).amount,
    ).toBe(0);
    expect(
      estimated(
        await estimateCost(
          usage({ input: { total: 0 }, output: { total: 0 } }),
          { prices },
        ),
      ).amount,
    ).toBe(0);
    expect(await estimateCost({ toolUses: 0 }, { prices: free })).toMatchObject(
      { status: 'unavailable', reason: 'tokens-unavailable' },
    );
    expect(
      await estimateCost(usage(), { prices: { input: 2, output: 10 } }),
    ).toMatchObject({ reason: 'missing-price' });
    for (const value of [-1, Infinity, NaN, undefined]) {
      expect(
        await estimateCost(usage(), {
          prices: { ...prices, input: value } as TokenPrices,
        }),
      ).toMatchObject({ reason: 'invalid-prices' });
    }
  });

  it('discloses missing input detail assumptions and requires distinct reasoning quantities', async () => {
    const input = usage({
      input: { total: 100, cacheRead: 20 },
      output: { total: 10 },
    });
    const result = estimated(await estimateCost(input, { prices }));
    expect(result.amount).toBeCloseTo(
      (80 * 2 + 20 * 0.2 + 10 * 10) / 1_000_000,
      12,
    );
    expect(result.assumptions.join(' ')).toContain(
      'Unreported cache quantities',
    );
    expect(result.records[0].tokens.input.cacheWrite).toBeUndefined();
    expect(
      await estimateCost(input, { prices: { ...prices, reasoning: 20 } }),
    ).toMatchObject({ reason: 'unsupported-pricing' });
    expect(
      estimated(
        await estimateCost(input, { prices: { ...prices, reasoning: 10 } }),
      ).amount,
    ).toBe(result.amount);
  });

  it('rejects invalid counts and mismatched decompositions instead of manufacturing estimates', async () => {
    for (const tokens of [
      { input: { total: -1 }, output: { total: 1 } },
      { input: { total: 10, cacheRead: 11 }, output: { total: 1 } },
      {
        input: { total: 10, uncached: 5, cacheRead: 2, cacheWrite: 2 },
        output: { total: 1 },
      },
      { input: { total: 1 }, output: { total: 10, visible: 10, reasoning: 1 } },
    ]) {
      expect(await estimateCost(usage(tokens), { prices })).toMatchObject({
        reason: 'invalid-usage',
      });
    }
    const input = simpleUsage();
    input.tokens!.records = [
      { model: 'luna', tokens: simpleUsage(99).tokens!.totals },
    ];
    expect(await estimateCost(input, { prices })).toMatchObject({
      reason: 'invalid-usage',
    });
    expect(
      await estimateCost(simpleUsage(2_000_000), {
        prices: { ...prices, input: Number.MAX_VALUE },
      }),
    ).toMatchObject({ reason: 'invalid-prices' });
  });

  it('applies a caller price table uniformly even when records identify different models', async () => {
    const input = simpleUsage(200);
    input.tokens!.totals.output.total = 20;
    input.tokens!.records = ['model-one', 'model-two'].map((model) => ({
      model,
      provider: 'provider',
      tokens: simpleUsage().tokens!.totals,
    }));
    const result = estimated(await estimateCost(input, { prices }));
    expect(result.records).toHaveLength(2);
    expect(result.amount).toBeCloseTo((200 * 2 + 20 * 10) / 1_000_000, 12);
    expect(result.assumptions.join(' ')).toContain(
      'uniformly to all reported models',
    );
  });

  it('retains known record cache and reasoning quantities when aggregate details are absent', async () => {
    const input = usage({ input: { total: 100 }, output: { total: 10 } });
    input.tokens!.records = [
      {
        model: 'a',
        tokens: {
          input: { total: 50, cacheRead: 50, cacheWrite: 0 },
          output: { total: 10, reasoning: 5 },
        },
      },
      {
        model: 'b',
        tokens: { input: { total: 50 }, output: { total: 0 } },
      },
    ];
    const result = estimated(
      await estimateCost(input, { prices: { ...prices, reasoning: 20 } }),
    );
    expect(result.amount).toBeCloseTo(
      (50 * 0.2 + 50 * 2 + 5 * 10 + 5 * 20) / 1_000_000,
      12,
    );
    expect(result.records[0]).toMatchObject({
      model: 'a',
      tokens: { input: { cacheRead: 50 }, output: { reasoning: 5 } },
    });
    expect(input.tokens!.totals.input.cacheRead).toBeUndefined();
    expect(input.tokens!.totals.output.reasoning).toBeUndefined();
  });

  it('supports Codex totals with explicit identities and refreshes expired or deleted caches', async () => {
    await withCatalog(async ({ options, cachePath, calls, respond }) => {
      const first = estimated(await estimateCost(usage(), options));
      expect(first.source).toMatchObject({ type: 'models.dev', stale: false });
      expect(first.records[0]).toMatchObject({
        model: 'luna',
        provider: 'openai',
        prices,
      });
      expect(first.assumptions.join(' ')).toContain('Caller model');
      respond((response) =>
        response.end(
          JSON.stringify(
            catalog({
              input: 4,
              output: 10,
              cache_read: 0.2,
              cache_write: 2.5,
            }),
          ),
        ),
      );
      expect(estimated(await estimateCost(usage(), options)).amount).toBe(
        first.amount,
      );
      expect(calls()).toBe(1);
      await rm(cachePath);
      expect(
        estimated(await estimateCost(usage(), options)).records[0].prices.input,
      ).toBe(4);
      expect(calls()).toBe(2);
      const cache = JSON.parse(await readFile(cachePath, 'utf8'));
      cache.fetchedAt = Date.now() - 24 * 60 * 60 * 1000;
      await writeFile(cachePath, JSON.stringify(cache));
      await estimateCost(usage(), options);
      expect(calls()).toBe(3);
    });
  });

  it('uses explicit provider selection for authentication records and snapshots inputs before retrieval', async () => {
    await withCatalog(async ({ options, respond }) => {
      let release!: () => void;
      respond((response) => {
        release = () => response.end(JSON.stringify(catalog()));
      });
      const input = simpleUsage();
      input.tokens!.records = [
        {
          provider: 'gemini-api-key',
          model: 'luna',
          requests: 1,
          tokens: structuredClone(input.tokens!.totals),
        },
      ];
      const promise = estimateCost(input, {
        ...options,
        model: 'unused-fallback',
      });
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      input.tokens!.totals.input.total = 9000;
      input.tokens!.records[0].tokens.input.total = 9000;
      input.tokens!.records[0].model = 'mutated';
      release();
      const result = estimated(await promise);
      expect(result.records[0]).toMatchObject({
        provider: 'openai',
        model: 'luna',
        tokens: { input: { total: 100 } },
      });
      expect(result.assumptions.join(' ')).toContain('Caller provider');
      expect(result.assumptions.join(' ')).not.toContain('unused-fallback');
    });
  });

  it('prices separate records at their context bands without tiering aggregate input', async () => {
    await withCatalog(async ({ options, respond }) => {
      respond((response) =>
        response.end(
          JSON.stringify(
            catalog({
              input: 2,
              output: 10,
              tiers: [
                {
                  tier: { type: 'context', size: 272_000 },
                  input: 4,
                  output: 15,
                },
              ],
            }),
          ),
        ),
      );
      const tokens = (total: number): TokenUsage => ({
        input: { total, cacheRead: 0, cacheWrite: 0 },
        output: { total: 10 },
      });
      const input = usage(tokens(543_999));
      input.tokens!.totals.output.total = 20;
      input.tokens!.coverage = 'complete';
      input.tokens!.records = [
        {
          provider: 'openai',
          model: 'luna',
          requests: 1,
          tokens: tokens(271_999),
        },
        {
          provider: 'openai',
          model: 'luna',
          requests: 1,
          tokens: tokens(272_000),
        },
      ];
      const result = estimated(await estimateCost(input, options));
      expect(result.coverage).toBe('complete');
      expect(result.records.map((record) => record.prices.input)).toEqual([
        2, 4,
      ]);
      expect(result.amount).toBeCloseTo(
        (271_999 * 2 + 272_000 * 4 + 10 * 10 + 10 * 15) / 1_000_000,
        12,
      );
      input.tokens!.records = [
        {
          provider: 'openai',
          model: 'luna',
          requests: 2,
          tokens: structuredClone(input.tokens!.totals),
        },
      ];
      const aggregate = estimated(await estimateCost(input, options));
      expect(aggregate.records[0].prices.input).toBe(2);
      expect(aggregate.assumptions.join(' ')).toContain(
        'Standard context prices',
      );
    });
  });

  it('returns unavailable for missing provider/model/rates and preserves explicit catalog zero', async () => {
    await withCatalog(async ({ options, calls, respond, cachePath }) => {
      expect(await estimateCost(simpleUsage(), { cachePath })).toMatchObject({
        reason: 'missing-model',
      });
      expect(
        await estimateCost(simpleUsage(), { cachePath, model: 'luna' }),
      ).toMatchObject({ reason: 'missing-provider' });
      expect(calls()).toBe(0);
      expect(
        await estimateCost(simpleUsage(), {
          ...options,
          provider: 'constructor',
        }),
      ).toMatchObject({ reason: 'model-not-found' });
      expect(
        await estimateCost(simpleUsage(), { ...options, model: 'other' }),
      ).toMatchObject({ reason: 'model-not-found' });
      await rm(cachePath);
      respond((response) =>
        response.end(JSON.stringify(catalog({ input: 0, output: 0 }))),
      );
      expect(estimated(await estimateCost(simpleUsage(), options)).amount).toBe(
        0,
      );
      await rm(cachePath);
      respond((response) => response.end(JSON.stringify(catalog(null))));
      expect(await estimateCost(simpleUsage(), options)).toMatchObject({
        reason: 'missing-price',
      });
    });
  });

  it('rejects malformed and duplicate context tier thresholds', async () => {
    await withCatalog(async ({ options, cachePath, respond }) => {
      for (const sizes of [[-1], [272_000, 272_000]]) {
        respond((response) =>
          response.end(
            JSON.stringify(
              catalog({
                input: 2,
                output: 10,
                tiers: sizes.map((size) => ({
                  tier: { type: 'context', size },
                  input: 4,
                  output: 20,
                })),
              }),
            ),
          ),
        );
        expect(await estimateCost(simpleUsage(), options)).toMatchObject({
          reason: 'unsupported-pricing',
        });
        await rm(cachePath);
      }
    });
  });

  it('does not inherit optional base prices into a selected context tier', async () => {
    await withCatalog(async ({ options, respond }) => {
      respond((response) =>
        response.end(
          JSON.stringify(
            catalog({
              input: 2,
              output: 10,
              cache_read: 0.2,
              tiers: [
                {
                  tier: { type: 'context', size: 272_000 },
                  input: 4,
                  output: 20,
                },
              ],
            }),
          ),
        ),
      );
      for (const cacheRead of [100, 0]) {
        const input = simpleUsage(272_000);
        input.tokens!.totals.input.cacheRead = cacheRead;
        input.tokens!.records = [
          {
            model: 'luna',
            provider: 'openai',
            requests: 1,
            tokens: structuredClone(input.tokens!.totals),
          },
        ];
        const result = await estimateCost(input, options);
        if (cacheRead > 0) {
          expect(result).toMatchObject({ reason: 'missing-price' });
        } else {
          expect(estimated(result).records[0].prices).toEqual({
            input: 4,
            output: 20,
          });
        }
      }
    });
  });

  it('honors distinct catalog reasoning prices without double charging output', async () => {
    await withCatalog(async ({ options, respond }) => {
      respond((response) =>
        response.end(
          JSON.stringify(
            catalog({
              input: 2,
              output: 10,
              cache_read: 0.2,
              cache_write: 2.5,
              reasoning: 15,
            }),
          ),
        ),
      );
      const result = estimated(await estimateCost(usage(), options));
      expect(result.amount).toBeCloseTo(3.94, 12);
      expect(result.records[0].prices.reasoning).toBe(15);
      expect(await estimateCost(simpleUsage(), options)).toMatchObject({
        reason: 'unsupported-pricing',
      });
    });
  });

  it('rejects invalid catalog identities, storage options, and deadlines before retrieval', async () => {
    await withCatalog(async ({ options, calls }) => {
      for (const field of ['model', 'provider', 'cachePath']) {
        for (const value of ['', ' ', null, 1]) {
          expect(
            await estimateCost(simpleUsage(), { ...options, [field]: value }),
          ).toMatchObject({ reason: 'invalid-options' });
        }
      }
      for (const timeoutMs of [
        -1,
        0,
        0.5,
        NaN,
        Infinity,
        2_147_483_648,
        null,
        '1000',
      ]) {
        expect(
          await estimateCost(simpleUsage(), {
            ...options,
            timeoutMs,
          } as CostEstimationOptions),
        ).toMatchObject({ reason: 'invalid-options' });
      }
      for (const invalid of [null, [], 1]) {
        expect(
          await estimateCost(
            simpleUsage(),
            invalid as unknown as CostEstimationOptions,
          ),
        ).toMatchObject({ reason: 'invalid-options' });
      }
      expect(calls()).toBe(0);
    });
  });

  it('uses stale prices on failed refresh without changing their date and fails honestly without them', async () => {
    await withCatalog(async ({ options, cachePath, respond }) => {
      await estimateCost(usage(), options);
      const cache = JSON.parse(await readFile(cachePath, 'utf8'));
      cache.fetchedAt = Date.now() - 25 * 60 * 60 * 1000;
      await writeFile(cachePath, JSON.stringify(cache));
      respond((response) => {
        response.writeHead(503);
        response.end('unavailable');
      });
      const stale = estimated(await estimateCost(usage(), options));
      expect(stale.source).toMatchObject({
        stale: true,
        fetchedAt: new Date(cache.fetchedAt).toISOString(),
      });
      expect(JSON.parse(await readFile(cachePath, 'utf8')).fetchedAt).toBe(
        cache.fetchedAt,
      );
      await rm(cachePath);
      expect(await estimateCost(usage(), options)).toMatchObject({
        reason: 'catalog-unavailable',
      });
    });
  });

  it('rejects malformed, wrong-version, and future-dated caches and malformed remote catalogs', async () => {
    await withCatalog(async ({ options, cachePath, respond }) => {
      respond((response) => response.end('not json'));
      for (const content of [
        'not json',
        JSON.stringify({
          version: 2,
          fetchedAt: Date.now(),
          catalog: catalog(),
        }),
        JSON.stringify({
          version: 1,
          fetchedAt: Date.now() + 86_400_000,
          catalog: catalog(),
        }),
      ]) {
        await writeFile(cachePath, content);
        expect(await estimateCost(usage(), options)).toMatchObject({
          reason: 'catalog-unavailable',
        });
      }
      await rm(cachePath);
      respond((response) => response.end('{}'));
      expect(await estimateCost(usage(), options)).toMatchObject({
        reason: 'catalog-unavailable',
      });
    });
  });

  it('bounds slow response bodies and shares concurrent refreshes', async () => {
    await withCatalog(async ({ options, cachePath, calls, respond }) => {
      respond((response) => {
        response.writeHead(200);
        response.write('{');
      });
      const started = Date.now();
      expect(
        await estimateCost(simpleUsage(), { ...options, timeoutMs: 40 }),
      ).toMatchObject({ reason: 'catalog-unavailable' });
      expect(Date.now() - started).toBeLessThan(1000);
      respond((response) => {
        setTimeout(() => response.end(JSON.stringify(catalog())), 30);
      });
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          estimateCost(usage(), {
            ...options,
            cachePath:
              index % 2 === 0
                ? cachePath
                : cachePath.replace(/cache\.json$/, './cache.json'),
          }),
        ),
      );
      for (const result of results) estimated(result);
      expect(calls()).toBe(2);
      expect(JSON.parse(await readFile(cachePath, 'utf8')).version).toBe(1);
    });
  });

  it('keeps concurrent refreshes for different cache paths independent', async () => {
    await withCatalog(async ({ options, cachePath, calls, respond }) => {
      const responses: ServerResponse[] = [];
      respond((response) => {
        responses.push(response);
      });
      const otherPath = `${cachePath}.other`;
      const pending = [
        estimateCost(simpleUsage(), options),
        estimateCost(simpleUsage(), { ...options, cachePath: otherPath }),
      ];
      await vi.waitFor(() => expect(responses).toHaveLength(2));
      for (const response of responses) {
        response.end(JSON.stringify(catalog()));
      }
      for (const result of await Promise.all(pending)) estimated(result);
      expect(calls()).toBe(2);
      for (const path of [cachePath, otherPath]) {
        expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);
      }
    });
  });

  it('does not impose an outstanding longer deadline on another caller', async () => {
    await withCatalog(async ({ options, calls, respond }) => {
      const responses: ServerResponse[] = [];
      respond((response) => {
        responses.push(response);
      });
      let longerSettled = false;
      const longer = estimateCost(simpleUsage(), {
        ...options,
        timeoutMs: 2000,
      }).then((result) => {
        longerSettled = true;
        return result;
      });
      await vi.waitFor(() => expect(responses).toHaveLength(1));
      expect(
        await estimateCost(simpleUsage(), { ...options, timeoutMs: 100 }),
      ).toMatchObject({ reason: 'catalog-unavailable' });
      expect(calls()).toBe(2);
      expect(longerSettled).toBe(false);
      responses[0].end(JSON.stringify(catalog()));
      estimated(await longer);
    });
  });

  it('accepts a valid response at the byte limit and rejects one byte more', async () => {
    await withCatalog(async ({ options, respond, cachePath }) => {
      respond((response) =>
        response.end(paddedJson(catalog(), catalogLimit + 1)),
      );
      const bounded = { ...options, timeoutMs: 5000 };
      expect(await estimateCost(simpleUsage(), bounded)).toMatchObject({
        reason: 'catalog-unavailable',
      });
      await expect(readFile(cachePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      respond((response) => response.end(paddedJson(catalog(), catalogLimit)));
      estimated(await estimateCost(simpleUsage(), bounded));
    });
  });

  it('accepts a valid cache at the byte limit and rejects one byte more', async () => {
    await withCatalog(async ({ options, respond, cachePath, calls }) => {
      respond((response) => {
        response.writeHead(503);
        response.end();
      });
      const entry = { version: 1, fetchedAt: Date.now(), catalog: catalog() };
      await writeFile(cachePath, paddedJson(entry, catalogLimit));
      estimated(await estimateCost(simpleUsage(), options));
      expect(calls()).toBe(0);
      await writeFile(cachePath, paddedJson(entry, catalogLimit + 1));
      expect(await estimateCost(simpleUsage(), options)).toMatchObject({
        reason: 'catalog-unavailable',
      });
      expect(calls()).toBe(1);
    });
  });

  it('keeps retrieved prices usable when the cache cannot be written and exposes its default path', async () => {
    await withCatalog(async ({ options, cachePath }) => {
      await writeFile(cachePath, 'a file cannot be a parent directory');
      estimated(
        await estimateCost(usage(), {
          ...options,
          cachePath: join(cachePath, 'nested.json'),
        }),
      );
      expect(await readFile(cachePath, 'utf8')).toBe(
        'a file cannot be a parent directory',
      );
    });
    expect(isAbsolute(getDefaultPricingCachePath())).toBe(true);
    expect(getDefaultPricingCachePath()).toMatch(/models-dev-v1\.json$/);
  });

  it('returns unavailable for home-directory lookup failures while explicit inputs remain usable', async () => {
    await withCatalog(async ({ options, calls }) => {
      vi.stubEnv('LOCALAPPDATA', '');
      vi.stubEnv('XDG_CACHE_HOME', '');
      const home = vi.mocked(homedir).mockImplementation(() => {
        throw new Error('Home directory unavailable');
      });
      try {
        expect(
          await estimateCost(simpleUsage(), {
            ...options,
            cachePath: undefined,
          }),
        ).toMatchObject({ reason: 'catalog-unavailable' });
        expect(calls()).toBe(0);
        estimated(await estimateCost(simpleUsage(), { prices }));
        estimated(await estimateCost(simpleUsage(), options));
      } finally {
        home.mockReset();
        vi.unstubAllEnvs();
      }
    });
  });

  it('returns unavailable when resolving a relative cache path cannot read the working directory', async () => {
    await withCatalog(async ({ options, calls }) => {
      const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
        throw new Error('Working directory unavailable');
      });
      let result: CostEstimateResult;
      try {
        result = await estimateCost(simpleUsage(), {
          ...options,
          cachePath: 'pricing-cache.json',
        });
      } finally {
        cwd.mockRestore();
      }
      expect(result).toMatchObject({ reason: 'catalog-unavailable' });
      expect(calls()).toBe(0);
    });
  });

  it('uses absolute platform cache locations without looking up a home directory', () => {
    const originalProcess = process;
    const configured = join(tmpdir(), 'cligent-configured-cache');
    const home = vi.mocked(homedir).mockImplementation(() => {
      throw new Error('Home directory unavailable');
    });
    try {
      for (const [platform, variable] of [
        ['win32', 'LOCALAPPDATA'],
        ['linux', 'XDG_CACHE_HOME'],
      ]) {
        vi.stubGlobal('process', {
          ...originalProcess,
          platform,
          env: { ...originalProcess.env, [variable]: configured },
        });
        expect(getDefaultPricingCachePath()).toBe(
          join(configured, 'cligent', 'models-dev-v1.json'),
        );
      }
    } finally {
      vi.unstubAllGlobals();
      home.mockReset();
    }
  });

  it('retains fetched prices when preparing an atomic cache write fails', async () => {
    await withCatalog(async ({ options, cachePath }) => {
      const uuid = vi.mocked(randomUUID).mockImplementation(() => {
        throw new Error('Randomness unavailable');
      });
      try {
        const result = estimated(await estimateCost(simpleUsage(), options));
        expect(result.source).toMatchObject({
          type: 'models.dev',
          stale: false,
        });
        await expect(readFile(cachePath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        uuid.mockReset();
      }
    });
  });
});
