<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-014: Unified Usage Accounting

## Status

Accepted
Amended by [DR-024](024-optional-cost-estimation.md): optional caller-requested estimates remain separate from runtime-reported accounting.

## Context

[DR-002](002-unified-event-stream-and-adapter-interface.md) originally required
`inputTokens` and `outputTokens` on every terminal event.
The later flat-accounting generation added `tokenAvailability` because a required numeric zero could not
distinguish measured zero from missing accounting; [DR-019](019-superseded-item-retirements.md) records that
generation's retirement.
The first form of this decision added a disjoint `breakdown` and billable `records` beside those fields.

That compatibility shape is not a sound cost ledger.
It retains numeric placeholders, gives one availability state to several independently reported dimensions,
and loses an authentic inclusive output total where a runtime reports output but not its reasoning subset.
It also does not say whether a total includes subagents, resumed history, or only a root conversation.

The supported runtimes expose materially different accounting surfaces.

| Runtime     | Authentic source              | Important boundary                                 |
| ----------- | ----------------------------- | -------------------------------------------------- |
| Claude Code | terminal per-model accounting | complete agent tree; client-estimated cost         |
| Codex       | cumulative thread usage       | root thread only; resumed calls require a baseline |
| Gemini CLI  | run-owned local telemetry     | per response, including thinking and subagents     |
| OpenCode    | causal step-finish parts      | per request across the invocation's task tree      |
| Kimi Code   | ACP session usage update      | current context occupancy, not invocation totals   |

The normalized shape must preserve authentic totals, expose exact pricing subsets without double counting,
state its coverage, and omit unavailable data instead of manufacturing zero.

## Decision

### Public shape

`DoneUsage` carries the independently observed `toolUses` count plus two optional reports:

- `tokens`, an authentic token report for the invocation; and
- `cost`, a cost value the runtime itself supplied.

The released flat fields `tokenAvailability`, `inputTokens`, `outputTokens`, and `totalCostUsd`, together
with the unreleased `breakdown` field, are removed.
Their absence is the availability model: an absent `tokens` report means no authentic token accounting is
available, while a present zero inside that report is a measurement.

The token report has the following shape.

```typescript
interface TokenUsageReport {
  coverage: 'complete' | 'partial';
  totals: TokenUsage;
  records?: UsageRecord[];
}

interface TokenUsage {
  input: {
    total: number;
    uncached?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  output: {
    total: number;
    visible?: number;
    reasoning?: number;
  };
}
```

`input.total` includes cache reads and cache writes.
`output.total` includes reasoning or thinking.
The remaining fields are exact subsets of those inclusive totals, following the inclusive aggregate
convention used by OpenTelemetry's generative-AI semantic conventions [[1]].
When every detail of one side is present, the details shall sum exactly to its total.
An absent detail is unreported and shall not be interpreted as zero.

`coverage: 'complete'` means the report covers every model request causally owned by this
`AgentAdapter.run()` invocation, including descendant-agent work and excluding resumed history.
`'partial'` means every published number is authentic but some invocation work may be outside the runtime
surface or causal boundary.
Coverage describes request inclusion, not field availability.

### Billable records

`records` decomposes the report into rate-card groups.
Every record uses the same inclusive token shape and may carry the model, provider, request count, a
runtime-reported cost, and separately priced non-token units.
Here `provider` means the runtime's rate-card family: it may be a serving provider identifier or, where the
runtime distinguishes billing through authentication, an authentication or billing route.

- Records shall sum to `totals` for both inclusive totals and every aggregate detail the report publishes.
- A missing model or provider shall remain absent rather than becoming a placeholder.
- `requests: 1` means a per-request context tier can be selected from the record; a greater count means the
  record aggregates requests and cannot establish each request's tier.
- A record whose source cannot be authenticated, scoped, or reconciled is omitted rather than estimated.

### Costs and priced units

Adapter accounting shall not apply a price table or populate runtime cost from a Cligent calculation.
Prices, context tiers, service modes, cache time-to-live, modalities, regions, subscriptions, and separately
priced tools change independently of the package.
An optional caller-invoked estimator is defined separately by [DR-024](024-optional-cost-estimation.md), retaining external rates and explicit estimate provenance.

A runtime-supplied cost is represented as `{ amount, currency: 'USD', source }`, where `source` is one of
`agent-estimate`, `provider-reported`, or `account-estimate`.
Claude Code and OpenCode values are `agent-estimate`; neither is asserted to be an invoice total.
A valid cost may be published even when token accounting is absent, because the two have independent
failure domains.
Non-token quantities such as an agent-reported web-search request count use `pricedUnits`; they are never
folded into token totals.

### Fidelity sources

An adapter may use a runtime-owned source outside its normal event stream only when all of the following
hold.

- The source is scoped uniquely to the current child process or invocation.
- Its totals are cross-validated against the runtime's ordinary terminal accounting.
- Missing, unreadable, malformed, unidentifiable duplicate, conflicting duplicate, or mismatched data makes
  the supplementary report absent; exact duplicate exporter records are deduplicated and never added twice.
- The source stays within an applicable protocol decision.
  In particular, [DR-011](011-kimi-code-acp-integration.md) confines Kimi to ACP.
- The source is covered by the runtime pin in
  [DR-013](013-cligent-owned-runtime-compatibility.md) and is reverified when that pin changes.

Gemini's supported local telemetry exporter meets this rule and exposes per-response model and complete token
details [[4]].
OpenCode's SDK event and session schema supplies causal, identified step-finish parts [[5]].
Claude Code's terminal per-model result is already part of its supported protocol [[2]].
Codex's exec surface remains thread-cumulative; its app-server offers richer per-thread and per-response
events, but those are not silently substituted for the pinned adapter transport [[3]].

### Adapter mapping

- **Claude Code:** sum terminal `modelUsage` entries for complete coverage; publish one record per model,
  inclusive output even when reasoning detail is absent, per-model and whole-run agent-estimated cost, and
  separately reported priced units.
  A main-loop-only fallback is not a whole-run token report.
- **Codex:** difference the current root thread's cumulative snapshot from a retained baseline and label the
  exact result partial, because descendant threads are outside the exec event surface.
  An unseen resumed baseline yields no token report.
- **Gemini CLI:** collect one record per `gemini_cli.api_response` from a prompt-free, run-owned local
  telemetry file after process close. Preserve the response's authentication type as the rate-card family,
  fold separately reported tool-use-prompt tokens into inclusive input, retain thinking in inclusive output,
  and cross-validate the raw prompt, candidate, cache, and overall sums against terminal stream statistics
  [[6]]. A run with a causal API-error event or an unmatched zero-token routed model keeps its exact
  successful-response records but uses partial coverage because the failed request exposes no token counters.
- **OpenCode:** collect canonical step-finish parts causally descended from the submitted prompt, keyed by
  session and part identifier, and replace repeated snapshots instead of adding them.
  Child conversation remains filtered even though its accounting is included.
  Prove the live server is healthy at the exact conformance version before allowing complete coverage;
  missing, failed, malformed, or different-version proof preserves the exact observed subset as partial.
  Suppress and verify the otherwise unledgered title request, extend causality only through pinned task and
  compaction boundaries, and downgrade exact subsets after causal or uncorrelatable retries, overflow replay,
  reused task sessions, missing child identity, unsettled background work, or any unproved post-activation
  request [[7]][[8]][[9]].
- **Kimi Code:** publish no token report for the pinned runtime because its ACP `usage_update` supplies current session context occupancy rather than invocation-scoped input/output and omits cost [[10]].
  Independently observed tool calls remain reported.

## Consequences

- Callers never need an availability discriminator or compatibility zero.
- Inclusive totals remain usable where a runtime cannot expose a cache or reasoning split.
- A cost calculator can reject partial coverage, missing model/request dimensions, or absent cache details
  instead of presenting a precise-looking underestimate.
- Claude Code and OpenCode direct costs are exposed with their estimate provenance.
- Gemini becomes priceable for ordinary pay-as-you-go text requests through model- and
  authentication-specific per-response records, while subscription tier, cache storage duration, grounding
  charges, modality tiers, and other unreported dimensions stay absent.
- Codex remains only root-thread priceable on the pinned exec transport; exact agent-tree pricing requires a
  separately decided app-server migration.
- Kimi is not token-priceable through Cligent until its supported ACP runtime exposes invocation-scoped input/output semantics.
- Removing the released flat fields is a breaking public API change.

## References

[1]: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md 'OpenTelemetry generative AI token attributes'
[2]: https://code.claude.com/docs/en/agent-sdk/cost-tracking 'Claude Code cost and usage tracking'
[3]: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md 'Codex app-server protocol'
[4]: https://geminicli.com/docs/cli/telemetry/ 'Gemini CLI telemetry'
[5]: https://opencode.ai/docs/sdk/ 'OpenCode SDK'
[6]: https://github.com/googleapis/js-genai/blob/38cac5bbf4941ec5fa760238bd423c0ecc2c6f04/src/types.ts#L2607-L2628 'Google Gen AI SDK 1.30.0 UsageMetadata'
[7]: https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/prompt.ts#L193-L449 'OpenCode 1.18.25 title and foreground-task flow'
[8]: https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/compaction.ts#L319-L556 'OpenCode 1.18.25 compaction flow'
[9]: https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/processor.ts#L630-L681 'OpenCode 1.18.25 retry boundary'
[10]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/acp-server/src/session.ts#L907-L937 'Kimi Code 0.39.1 prompt response and context-usage update'
