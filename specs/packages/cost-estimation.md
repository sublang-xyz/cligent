<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# cost-estimation: Optional Token Cost Estimation

## Intent

This package lets callers estimate reported text-token costs using supplied rates or a cached external catalog, per [DR-024](../decisions/024-optional-cost-estimation.md).
It owns the estimator's input, arithmetic, price resolution, provenance, and cache lifecycle, without changing the runtime accounting contract in [DR-014](../decisions/014-unified-token-usage-breakdown.md).

## External Behavior

### cost-estimation-1

The root module shall export asynchronous `estimateCost(usage: DoneUsage, options?: CostEstimationOptions): Promise<CostEstimateResult>`, `getDefaultPricingCachePath(): string`, and the public types describing their contract:

| Type | Shape |
| --- | --- |
| `TokenPrices` | required `input` and `output`, optional `cacheRead`, `cacheWrite`, and `reasoning`, all USD per million tokens |
| `CostEstimationOptions` | optional `prices`, `model`, `provider`, `cachePath`, and `timeoutMs` |
| `CostEstimateRecord` | `amount`, copied `tokens`, applied `prices`, and selected `model` and `provider` where available |
| `CostEstimateResult` estimated branch | `status: 'estimated'`, `amount`, `currency: 'USD'`, preserved `coverage`, ISO `estimatedAt`, `source`, `records`, and `assumptions` |
| `CostEstimateResult` unavailable branch | `status: 'unavailable'`, a `CostEstimationUnavailableReason`, and explanatory `message` |

### cost-estimation-2

When the estimator receives usage, it shall classify and snapshot its token report before asynchronous work using this matrix under [[engine-55](engine.md#engine-55)], [[engine-57](engine.md#engine-57)], and [[engine-58](engine.md#engine-58)]:

| Input | Outcome |
| --- | --- |
| absent token report | `tokens-unavailable` |
| invalid coverage, totals, optional details, or record identity/count | `invalid-usage` |
| present empty or non-array records, or record sums that do not reconcile with every reported aggregate quantity | `invalid-usage` |
| valid report | copy its counts, identities, request counts, and coverage for the calculation |

Valid counters are nonnegative safe integers, present details obey the inclusive subset identities, and present model/provider identities are nonempty strings; a present request count is a positive safe integer.

### cost-estimation-3

When an estimator call supplies `prices`, it shall use that rate card uniformly for each reported record, falling back to one group of report totals only when records are absent, bypass all cache and network access, disclose the uniform-rate assumption, and return `invalid-prices` for a missing required rate or any present rate that is not finite and nonnegative, admitting explicit zero.

### cost-estimation-4

When a catalog-based estimate selects pricing identities, it shall use each reported record, or one group containing report totals when records are absent, according to this matrix:

| Identity | Selection |
| --- | --- |
| model | native record model, falling back only to the caller's `model` option |
| provider | caller's `provider` option, otherwise native record provider |
| absent selected identity | `missing-model` or `missing-provider`, before retrieval |
| empty or invalid identity option | `invalid-options` |
| caller identity used | disclose it as a pricing assumption without modifying runtime-reported identity |
| lookup | exact provider/model keys in the catalog; no internal provider mappings or model-alias table |
| absent selected catalog entry | `model-not-found` |

### cost-estimation-5

When the estimator selects a catalog model's rates from models.dev [[1]][[2]][[3]], it shall apply this ordered pricing matrix:

| Catalog state | Outcome |
| --- | --- |
| missing or invalid required base `cost.input` or `cost.output`, or invalid optional rates | `missing-price` |
| base rates | map `input`, `output`, `cache_read`, `cache_write`, and `reasoning` to `TokenPrices` |
| present `cost.tiers` | require context tiers with unique nonnegative safe-integer `tier.size` and valid complete rate cards; unsupported shapes yield `unsupported-pricing` |
| absent modern tiers and present `context_over_200k` | admit its valid complete rate card for input strictly greater than 200,000; invalid shape yields `unsupported-pricing` |
| tiers and exactly one reported request | choose the highest threshold no greater than this record's inclusive input, otherwise base rates |
| tiers and aggregated or unreported request count | use base rates and disclose the standard-context assumption |

### cost-estimation-6

When the estimator calculates one rate-card group's amount, it shall price inclusive token quantities without counting any subset twice:

- subtract reported cache-read and cache-write quantities from inclusive input before applying the ordinary input rate;
- price each reported cache quantity at its corresponding rate, returning `missing-price` when a positive quantity lacks that rate;
- price unreported cache quantities as ordinary input and disclose that assumption when input is positive;
- price inclusive output at the output rate, replacing that rate for reported reasoning tokens when a separate reasoning rate differs;
- return `unsupported-pricing` when output is positive and a differing reasoning rate lacks a reported reasoning quantity; and
- divide token counts by one million before multiplication and return `invalid-prices` when a group amount or aggregate amount is nonfinite.

### cost-estimation-7

When the estimator returns a successful calculation, it shall preserve its reproducibility and accounting limits through this result matrix:

| Result member or boundary | Outcome |
| --- | --- |
| amount | sum of calculated record amounts |
| coverage | unchanged complete or partial report coverage |
| records | copied quantities, exact applied rates, selected identities, and individual amounts |
| caller source | `{ type: 'caller' }` |
| catalog source | `{ type: 'models.dev', url: 'https://models.dev/api.json', fetchedAt, stale }`, with the original ISO retrieval date |
| `estimatedAt` | calculation time, without claiming a price effective date |
| assumptions | disclose text-token-only scope, excluded subscription/non-token charges, and every applied identity, cache, request-tier, or uniform-rate assumption |
| catalog mode | standard service-mode pricing, disclosed as an assumption; caller prices can supply other rates |
| input accounting | leave the caller's usage, `DoneUsage.cost`, and all supplied objects unchanged |

### cost-estimation-8

When a catalog-based call needs prices, it shall resolve its disk cache according to this lifecycle matrix:

| Cache and refresh state | Outcome |
| --- | --- |
| valid snapshot younger than 24 hours | use it without retrieval |
| absent, invalid, or expired snapshot | retrieve `https://models.dev/api.json` on demand |
| successful valid retrieval | use the new catalog and attempt to replace the cache atomically |
| cache write failure | retain the successful calculation |
| failed refresh with a valid older snapshot | use that snapshot with `stale: true` and its original retrieval date |
| failed refresh without a valid snapshot | `catalog-unavailable` |
| deleted cache before a later call | retrieve again, without a retained in-memory catalog satisfying that call |

### cost-estimation-9

When catalog retrieval starts, the estimator shall bound the complete response, including body consumption, to `timeoutMs` (default 5,000 milliseconds) and 16 MiB, treating timeout, HTTP failure, malformed JSON, and invalid catalog structure as failed refreshes under [[cost-estimation-8](#cost-estimation-8)]:

- a supplied timeout must be a positive safe integer no greater than 2,147,483,647, otherwise the call returns `invalid-options`;
- the catalog is a nonempty object of provider objects, each with a models object, with selected-model pricing validated separately under [[cost-estimation-5](#cost-estimation-5)]; and
- concurrent retrievals may share work only for the same resolved cache path and timeout, without imposing one caller's longer deadline on another.

### cost-estimation-10

When the estimator resolves cache storage, it shall use the caller's nonempty `cachePath` when supplied, otherwise the file returned by `getDefaultPricingCachePath()` according to this platform matrix:

| Platform | Default file |
| --- | --- |
| macOS | `~/Library/Caches/cligent/models-dev-v1.json` |
| Windows | `%LOCALAPPDATA%/cligent/models-dev-v1.json` when the variable is absolute, otherwise `~/AppData/Local/cligent/models-dev-v1.json` |
| other | `$XDG_CACHE_HOME/cligent/models-dev-v1.json` when the variable is absolute, otherwise `~/.cache/cligent/models-dev-v1.json` |

### cost-estimation-11

When the estimator reads an existing cache file, it shall accept only a regular file of at most 16 MiB containing `{ version: 1, fetchedAt, catalog }`, where `fetchedAt` is a nonnegative safe-integer Unix time in milliseconds no later than the current time and `catalog` meets [[cost-estimation-9](#cost-estimation-9)], treating any read, parsing, or validation failure as an invalid cache under [[cost-estimation-8](#cost-estimation-8)].

## Verification

### cost-estimation-12

Where the public estimator is called with complete, partial, zero, missing, invalid, and multi-record usage and supplied prices, verification shall assert the input and arithmetic case matrix in [[cost-estimation-1](#cost-estimation-1)], [[cost-estimation-2](#cost-estimation-2)], [[cost-estimation-3](#cost-estimation-3)], [[cost-estimation-6](#cost-estimation-6)], and [[cost-estimation-7](#cost-estimation-7)], including absence of network/cache access, preserved input objects, subset replacement without double counting, missing rates, explicit zero, record reconciliation, and overflow.

### cost-estimation-13

Where the public estimator resolves fixture catalogs through an HTTP boundary and temporary cache files, verification shall assert the identity, modern/legacy context-tier, missing/invalid price, assumption, and provenance matrix in [[cost-estimation-4](#cost-estimation-4)], [[cost-estimation-5](#cost-estimation-5)], and [[cost-estimation-7](#cost-estimation-7)], including aggregated requests whose cumulative input must not select a per-request tier.

### cost-estimation-14

Where the public estimator runs with temporary cache files and controlled HTTP responses, verification shall assert fresh reuse, expiration, deletion, malformed and future-dated cache, stale fallback, failed writes, concurrency, body-size limits, and response timeouts under [[cost-estimation-8](#cost-estimation-8)], [[cost-estimation-9](#cost-estimation-9)], [[cost-estimation-10](#cost-estimation-10)], and [[cost-estimation-11](#cost-estimation-11)].

### cost-estimation-15

Where the packed package is installed in [[package-102](package.md#package-102)]'s floor consumers, when the public estimator is imported and exercised with caller prices, verification shall assert its exported declarations, asynchronous discriminated result, and correct amount under [[cost-estimation-1](#cost-estimation-1)], [[cost-estimation-3](#cost-estimation-3)], and [[cost-estimation-6](#cost-estimation-6)].

## References

[1]: https://models.dev/#api 'Models.dev provider-specific model data'
[2]: https://github.com/anomalyco/models.dev/blob/a63e41371cc203eb1b9fe8065e4d190df71d2cfe/packages/core/src/schema.ts#L72-L110 'Models.dev cost and context-tier schema'
[3]: https://github.com/anomalyco/models.dev/blob/a63e41371cc203eb1b9fe8065e4d190df71d2cfe/AGENTS.md#L156-L175 'Models.dev context-tier semantics'
