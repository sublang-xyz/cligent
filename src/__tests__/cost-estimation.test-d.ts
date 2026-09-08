// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { expectTypeOf, it } from 'vitest';
import {
  estimateCost,
  type CostEstimateResult,
  type CostEstimationOptions,
  type DoneUsage,
  type TokenPrices,
} from '../index.js';

it('exports a standalone estimate with distinct provenance and discriminated availability', () => {
  expectTypeOf(estimateCost).parameters.toEqualTypeOf<
    [DoneUsage, CostEstimationOptions?]
  >();
  expectTypeOf(estimateCost).returns.toEqualTypeOf<
    Promise<CostEstimateResult>
  >();
  expectTypeOf<TokenPrices>().toMatchTypeOf<{
    input: number;
    output: number;
  }>();
  expectTypeOf<
    Extract<CostEstimateResult, { status: 'unavailable' }>
  >().not.toHaveProperty('amount');
  expectTypeOf<
    Extract<CostEstimateResult, { status: 'estimated' }>['source']
  >().not.toEqualTypeOf<DoneUsage['cost']>();
});
