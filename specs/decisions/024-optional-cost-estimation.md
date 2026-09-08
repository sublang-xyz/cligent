<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-024: Optional Cost Estimation

## Status

Accepted.

## Context

Some runtimes report tokens without a monetary cost.
Consumers need approximate, reproducible comparisons, while prices change independently of Cligent releases.
The absence of runtime-reported cost remains meaningful under [DR-014](014-unified-token-usage-breakdown.md).

## Decision

Provide an optional estimator separate from adapter execution and runtime-reported cost.
Caller-supplied rates are authoritative and bypass both network and cache.
Otherwise resolve provider-specific model prices from models.dev [[1]], retaining a validated disk cache for 24 hours.
Refresh an absent or expired cache on demand; allow a failed refresh to use a valid older snapshot with its original date and an explicit stale indication.
Deleting the cache forces the next catalog-based estimate to fetch again.
Cligent maintains the resolver and calculation contract, not a shipped price catalog.

Preserve the input report's coverage and publish the rates, identities, source and assumptions applied.
Unreported pricing dimensions may be approximated only through disclosed assumptions; unavailable tokens, invalid measurements and unknown model prices remain unavailable.
Caller identity assumptions never become observed adapter facts.
The estimator neither replaces nor changes the meaning of `DoneUsage.cost`.

## Consequences

Applications can obtain useful token-price estimates without maintaining a catalog or requiring pricing access during agent execution.
An estimate can cover only the reported work and is neither an invoice nor a measurement of subscription spending.
Model routing, request tiers and missing details can make an approximate estimate differ from actual charges.
The exact returned rates permit reproducing a calculation after the remote catalog changes.
This decision narrows [DR-014](014-unified-token-usage-breakdown.md)'s prohibition on applying price tables to the runtime accounting contract.

## References

[1]: https://models.dev/#api 'Models.dev provider-specific model data'

