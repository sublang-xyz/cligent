<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# cligent guide

## Install

```bash
npm install @sublang/cligent
```

Each adapter that uses an SDK has an optional peer dependency. Install only the ones you need:

```bash
npm install "@anthropic-ai/claude-agent-sdk@>=0.3.219"   # Claude Code
npm install "@openai/codex-sdk@>=0.144.0"                 # Codex CLI
npm install "@opencode-ai/sdk@>=1.18.12"                  # OpenCode
# Gemini CLI uses a child process — no SDK required
# Kimi Code uses an external CLI — no Kimi-specific SDK required
```

A peer SDK has to land in the tree the running cligent resolves packages
from, so add `-g` to these commands when cligent itself was installed with
`npm install -g` — as the [`tmux-play`](tmux-play.md) app is. The CLIs an
adapter spawns (`gemini`, `kimi`, `opencode`) are always global, since they
are found on `PATH` rather than in `node_modules`:

```bash
npm install -g @google/gemini-cli            # Gemini CLI
npm install -g opencode-ai                    # OpenCode server
```

For Kimi, install the maintained Kimi Code CLI at Cligent's exact conformance
target. The external Kimi CLI itself requires Node.js 22.19 or newer to install
and run, even though Cligent and its other adapter surfaces support Node.js
18.3:

```bash
npm install -g @moonshot-ai/kimi-code@0.39.1
kimi --version
kimi login
```

`kimi login` performs the one-time Kimi Code OAuth flow, which is the
simplest way to satisfy the exact 0.39.1 ACP target's session gate. That gate
accepts stored OAuth material resolved from the default model or reported by
any logged-in provider, including after `kimi login`; a [model/provider
configuration](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html)
whose default-model alias resolves to non-OAuth credentials; or the
`KIMI_MODEL_NAME` plus `KIMI_MODEL_API_KEY` environment overlay, which
synthesizes that default model for the running process only. A bare
`MOONSHOT_API_KEY` satisfies none of them, because it names no default model.
The adapter inherits the CLI's configuration and credentials; Cligent neither
stores credentials nor launches login for you.

## Quick start

```ts
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';

// Cligent — the primary API surface. Wraps an adapter with role identity,
// session continuity, option merging, and protocol hardening.
const agent = new Cligent(new ClaudeCodeAdapter(), {
  role: 'coder',
  model: 'claude-opus-4-8',
});

// agent.run(prompt, overrides?) → AsyncGenerator<CligentEvent>
// CligentEvent extends AgentEvent with an optional `role` field.
// Each event has a discriminated `type` field and a typed `payload`.
for await (const event of agent.run('Fix the login bug')) {
  switch (event.type) {
    case 'text_delta':
      // Streaming token — concatenate deltas to build the full response.
      process.stdout.write(event.payload.delta);
      break;
    case 'tool_use':
      // The agent is invoking a tool (e.g. Bash, Read, Edit).
      console.log(`Tool: ${event.payload.toolName}`);
      break;
    case 'done':
      // Terminal event — always the last event in the stream.
      // status: 'success' | 'error' | 'interrupted' | 'max_turns' | 'max_budget'
      console.log(`\nFinished: ${event.payload.status}`);
      break;
  }
}
```

## Cligent class

`Cligent` is the recommended way to interact with adapters. It provides:

- **Role identity** — when configured, tag every event with a task-level role (e.g. `'coder'`, `'reviewer'`)
- **Session continuity** — automatically resume previous sessions via `resumeToken`
- **Option merging** — set defaults in the constructor, override per-call
- **Single-flight guard** — prevents concurrent `run()` calls on the same instance
- **Protocol hardening** — guarantees exactly one `done` event per call, synthesizes error/done on adapter failures, handles abort racing

```ts
import { Cligent } from '@sublang/cligent';
import type { CligentOptions, RunOptions } from '@sublang/cligent';

// Constructor: Cligent(adapter, options?)
// CligentOptions — instance-level defaults (no abortSignal, no resume).
const agent = new Cligent(adapter, {
  role: 'coder', // injected into every event as event.role
  model: 'claude-opus-4-8',
  permissions: { fileWrite: 'allow', shellExecute: 'ask' },
  maxTurns: 10,
});

// run(prompt, overrides?) → AsyncGenerator<CligentEvent>
// RunOptions extends CligentOptions with abortSignal and resume.
// Per-call overrides win for scalars; permissions are merged by field;
// allowedTools/disallowedTools arrays are replaced entirely.
for await (const event of agent.run('Fix the bug', {
  model: 'claude-sonnet-4-6', // overrides the default
  abortSignal: controller.signal,
})) {
  // event.role === 'coder' (always from constructor defaults)
}
```

## Adapters

Pass an adapter to the `Cligent` constructor (or to the lower-level
`runAgent` helper).

**Claude Code**

```ts
// SDK adapter — wraps @anthropic-ai/claude-agent-sdk.
// Normalises SDKMessage objects into the Unified Event Stream.
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
const agent = new Cligent(new ClaudeCodeAdapter());
```

**Codex CLI**

```ts
// SDK adapter — wraps @openai/codex-sdk.
import { CodexAdapter } from '@sublang/cligent/adapters/codex';
const agent = new Cligent(new CodexAdapter());
```

**Gemini CLI**

```ts
// Child-process adapter — spawns the gemini CLI and parses its NDJSON stream.
// No SDK peer dependency required.
import { GeminiAdapter } from '@sublang/cligent/adapters/gemini';
const agent = new Cligent(new GeminiAdapter());
```

**OpenCode**

```ts
// SDK adapter — wraps @opencode-ai/sdk.
import { OpenCodeAdapter } from '@sublang/cligent/adapters/opencode';
const agent = new Cligent(new OpenCodeAdapter());
```

**Kimi Code**

```ts
// ACP adapter — spawns one short-lived `kimi acp` child for each run.
import { KimiAdapter } from '@sublang/cligent/adapters/kimi';
const agent = new Cligent(new KimiAdapter(), {
  effort: 'on',
  permissions: { mode: 'auto' },
});
```

Cligent uses Kimi Code's structured ACP mode rather than print mode, a
persistent server, or a Kimi-specific SDK. The maintained product exposes ACP
as a public integration surface, while the published Kimi agent SDK targets
the retired Python CLI and the successor's Node SDK is not public. ACP preserves
structured text, tool lifecycle, permission requests, cancellation, and the
backend session ID without keeping a resident service.

A fresh run creates an ACP session with `session/new`. A non-empty `resume`
token uses `session/resume`; Cligent does not replay Kimi history as new output.
The backend session ID becomes `DonePayload.resumeToken`, so the next run on the
same `Cligent` instance resumes automatically. Raw Kimi thought chunks are not
included in the Unified Event Stream.

## Effort

Set `effort` in constructor defaults or in a `run()` override. The portable
ladder, from least to greatest reasoning depth, is `minimal`, `low`, `medium`,
`high`, `xhigh`, and `max`. Provider-native values remain adapter-scoped:
Claude Code additionally accepts `ultracode`, while Codex additionally accepts
`ultra`. Gemini and OpenCode accept only the portable ladder. Kimi instead
accepts its provider-native binary values `off` and `on`; those values are not
aliases for portable depth tiers. The TypeScript API preserves this
correlation, including heterogeneous parallel calls, so an adapter-specific
value is not accepted for a different adapter.

```ts
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';

const claude = new Cligent(new ClaudeCodeAdapter(), {
  effort: 'ultracode',
});
const codex = new Cligent(new CodexAdapter(), {
  effort: 'ultra',
});

// The same adapter-specific vocabulary is available per call.
for await (const event of claude.run('Review this change', {
  effort: 'high',
})) {
  // ...
}
```

The mappings have a few important qualifications:

- **Claude Code:** `ultracode` maps to SDK `effort: 'xhigh'` plus
  `settings.ultracode: true`. Every explicit portable value sets
  `settings.ultracode: false`, so a run can downgrade inherited ultracode
  configuration. `minimal` maps to Claude's lowest native tier, `low`.
  Ultracode requires compatible workflow support and an xhigh-capable model,
  account, and installed runtime. Its delegated workflow can increase token
  use, latency, cost, concurrency, and tool activity.
- **Codex:** `minimal` through `xhigh` use the SDK thread effort field. `max`
  and `ultra` pass through unchanged as `model_reasoning_effort` constructor
  configuration; `ultra` enables automatic delegation. Availability still
  depends on the selected model, account, and installed runtime, and delegation
  can increase token use, latency, cost, concurrency, and tool activity.
- **Gemini:** Effort is applied only for concrete `gemini-3*` or `gemini-2.5*`
  model IDs. Gemini 3 collapses `high`, `xhigh`, and `max` to `HIGH`; Gemini
  2.5 Flash and Flash Lite collapse `xhigh` and `max` to the same maximum
  budget. If the model is omitted, is a CLI alias such as `auto` or `flash`,
  or does not match those model families, the adapter preserves ordinary model
  forwarding and applies no effort override.
- **OpenCode:** Variant mappings depend on the `provider/model` prefix and can
  be lossy. Anthropic collapses `minimal` through `high` to `high` and
  `xhigh`/`max` to `max`; OpenAI collapses `max` to `xhigh`; Google collapses
  `minimal` through `medium` to `low` and `high` through `max` to `high`. An
  unknown provider or malformed or omitted model receives no variant override.
- **Kimi:** `off` and `on` pass directly to ACP's `thinking` configuration
  option. `on` enables the selected model's native default thinking behavior;
  it does not select a portable Cligent effort tier. When both `model` and
  `effort` are provided, the model is selected before thinking is toggled.

Omitting `effort` sets no effort, orchestration, generated alias, or variant
override and leaves applicable adapter, model, account, and user-configuration
defaults in control.

Use the deeply frozen `EFFORT_SUPPORT` metadata to build selectors or inspect
each built-in adapter's accepted `values`, provider-native
`orchestrationValues`, `modelDependent` flag, and explanatory `notes`.
`getEffortSupport`, `supportedEffortValues`, `isEffortSupported`, and
`assertSupportedEffort` provide matching lookup and validation helpers (`claude`
is accepted as an alias for `claude-code`):

```ts
import { EFFORT_SUPPORT, assertSupportedEffort } from '@sublang/cligent';

console.log(EFFORT_SUPPORT.codex.values);
const requestedEffort: unknown = process.env.CLIGENT_EFFORT;
assertSupportedEffort('codex', requestedEffort, 'effort');
```

This metadata describes values that Cligent can route; it does not guarantee
that a selected model, account, or installed provider runtime supports a value.
If the backend rejects a metadata-accepted value, Cligent surfaces that upstream
failure without substituting a different effort.

The former public option name `reasoningEffort` has been replaced by `effort`.
Programmatic callers must update the property name. Valid legacy tmux-play YAML
is accepted in memory only after the complete document validates. The loader
then makes a bounded best-effort update of direct legacy key tokens when the
source still matches. If the source changes or the write fails, the run keeps
the validated in-memory value and the launcher warns you to rename
`reasoningEffort` to `effort` manually. Conflicting keys, invalid legacy values,
or any other config error reject without writing.

## Fast mode

`fastMode` requests a provider's lower-latency serving mode independently of
reasoning `effort`. Claude Code and Codex accept the option. Gemini, OpenCode,
and Kimi expose no native fast-mode request surface, so their adapter-bound
TypeScript options admit no value and dynamic calls reject a defined value
before provider work starts.

- `true` requests the provider's native fast mode.
- `false` explicitly requests its native standard or off mode and overrides a
  constructor default of `true`.
- Omission adds no Cligent override and leaves provider configuration in
  control.

```ts
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';

const claude = new Cligent(new ClaudeCodeAdapter(), { fastMode: true });

// Explicit false is retained as a per-run scalar override.
for await (const event of claude.run('Use standard serving for this turn', {
  fastMode: false,
})) {
  // ...
}
```

Fast-mode support means Cligent can deliver the request, not that the selected
model, account, provider, organization policy, billing state, network, or
installed runtime will honor it. A supported backend refusal follows the
ordinary error path; Cligent does not retry at another speed or claim that
fast serving occurred.

Use `FAST_MODE_SUPPORT` and its helpers to build an adapter selector. The
metadata is deeply frozen and separates request support from authentic
observation support. `claude` is accepted as an alias for `claude-code`.

```ts
import {
  FAST_MODE_SUPPORT,
  assertFastModeSupported,
  getFastModeSupport,
  isFastModeSupported,
} from '@sublang/cligent';

console.log(FAST_MODE_SUPPORT['claude-code'].observation); // 'init-and-done'
console.log(getFastModeSupport('codex')?.requestSupported); // true
console.log(isFastModeSupported('gemini')); // false
assertFastModeSupported('codex');
```

Claude may attach authentic `fastMode` observations to `init` and `done`
payloads. Those observations can report `state` (`off`, `cooldown`, or `on`)
and a `disabledReason`; a `done` observation may additionally report the
completed response's `responseSpeed` (`standard` or `fast`). Missing or
unrecognized upstream data stays absent. Codex accepts requests but exposes no
effective-tier event through its public SDK, so its events carry no fast-mode
observation and never echo the requested boolean as one.

## Session continuity

When an adapter's `done` event includes a `resumeToken`, `Cligent` stores it
and automatically injects it as the `resume` option on the next `run()` call.

```ts
// First run — adapter returns a resumeToken in the done payload.
for await (const event of agent.run('Refactor the auth module')) {
  // ...
}
console.log(agent.resumeToken); // e.g. 'session-abc-123'

// Second run — Cligent auto-injects resume: 'session-abc-123'.
// The agent picks up where it left off.
for await (const event of agent.run('Now add tests for it')) {
  // ...
}

// Override resume behavior per-call via RunOptions:
agent.run('Start fresh', { resume: false }); // force a new session
agent.run('Use this', { resume: 'other-token' }); // explicit token
```

## Token usage

Every `done` event carries `usage.toolUses`, the number of normalized tool calls
Cligent observed. Authentic token accounting is optional at `usage.tokens`.
Absence means the agent exposed no trustworthy report; a present zero is a
measurement, never a placeholder.

```ts
for await (const event of agent.run('Summarize the README')) {
  if (event.type !== 'done') continue;

  const { usage } = event.payload as DonePayload;
  if (!usage.tokens) {
    console.log('token usage unavailable for this turn');
    continue;
  }

  const { input, output } = usage.tokens.totals;
  console.log(input.total, output.total, usage.tokens.coverage);
}
```

`input.total` includes every cache tier, and `output.total` includes reasoning
or thinking. The details are exact subsets:

| Field              | Meaning                                        |
| ------------------ | ---------------------------------------------- |
| `input.uncached`   | input neither read from nor written to cache   |
| `input.cacheRead`  | input served from the prompt cache             |
| `input.cacheWrite` | input written into the prompt cache            |
| `output.visible`   | generated output excluding reasoning           |
| `output.reasoning` | reasoning or thinking included in output total |

```ts
const report = usage.tokens;
if (report?.totals.input.cacheRead !== undefined) {
  console.log(`${report.totals.input.cacheRead} tokens were cache hits`);
}
```

An absent detail is unreported, not zero. When every detail on one side is
present, those details add up exactly to its total. `coverage: 'complete'`
means all model requests caused by this invocation, including subagents, are
represented. `'partial'` means the numbers are exact but the runtime surface
may omit work. A calculation on a partial report covers only reported work
and cannot establish the full run's cost.

### Which rate card applies

A component split still cannot be priced without knowing _what_ was billed at
_which_ rate. `usage.tokens.records` answers that: each entry is one billable
group of the report.

```ts
for (const record of usage.tokens?.records ?? []) {
  console.log(record.model, record.tokens, record.requests, record.cost);
}
```

| Field         | Meaning                                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`       | the identifier the agent prices against — **absent when the agent never names it**                                                                                                             |
| `provider`    | the reported rate-card family, including a billing/authentication route where the runtime distinguishes one                                                                                    |
| `tokens`      | this group's inclusive totals and exact subsets                                                                                                                                                |
| `requests`    | how many API requests the group covers; `1` means a context-length tier follows from this record's own token counts, more than `1` means it does not, and absent means the count is unreported |
| `cost`        | upstream amount, USD currency, and provenance; never a Cligent calculation                                                                                                                     |
| `pricedUnits` | separately priced non-token quantities such as reported search requests                                                                                                                        |

Records add up to the report totals and every aggregate detail it publishes.
If that identity cannot hold, records are omitted rather than guessed.

`usage.cost` is independent of tokens. Claude Code and OpenCode can report
client-side cost estimates, which Cligent labels `agent-estimate`; that is not
an invoice. Adapter accounting never fills this field from a Cligent calculation.

### What each agent reports

| Agent         | Coverage                                                                                                                                                      | Records                                            | Direct cost    | Important limitation                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` | complete                                                                                                                                                      | per model                                          | agent estimate | request count and cache-write TTL are not exposed                                                                                                                                                                                                     |
| `codex`       | partial                                                                                                                                                       | per turn only when the effective model is observed | none           | exec omits descendant threads and often the effective model                                                                                                                                                                                           |
| `gemini`      | complete after telemetry reconciliation; partial after failed-request evidence                                                                                | per response with authentication route             | none           | failed-request tokens, subscription tier, storage duration, grounding, modality, and service-tier dimensions may be absent                                                                                                                            |
| `opencode`    | complete only when the live server matches the tested version and the title and pinned causal boundaries prove the settled task tree; exact partial where an attributable observed subset remains; omitted where no run-owned prompt boundary can be proved | per request                                        | agent estimate | missing or mismatched server proof, reused task sessions, causal/unattributed retries, overflow replay, unproved internal prompts, or unsettled background work prevent complete coverage; the estimate follows OpenCode's price catalog, not billing |
| `kimi`        | unavailable                                                                                                                                                   | none                                               | none           | Kimi 0.39.1 exposes session context occupancy over ACP, not invocation token or cost accounting                                                                                                                                                       |

Token records are enough to calculate ordinary text-token list price only when
the model, request tier, cache details, and service-specific modifiers are all
known. Tool fees, cache storage time, subscriptions, account credits, regions,
modalities, and rate changes can still prevent an exact invoice calculation.

### Codex resume accounting diagnostics

Codex's exec stream reports cumulative root-thread counters. Cligent retains
the previous snapshot on the adapter and subtracts it to report one invocation.
A new adapter resuming an existing thread has no such baseline: its first
valid native usage snapshot omits tokens and establishes a baseline for the next turn.

If a run ends without native terminal usage (for example, after an interrupt),
Cligent discards the old baseline. The next valid resumed snapshot also omits tokens
and establishes a new baseline. This prevents unobserved work from the interrupted
run being charged to a later invocation. Tool counts remain independently available.

Each native completion or failure emits `codex:usage` before `done`. Its payload
contains `status`, an exact `reason`, `resumed`, the known `threadId`, and available
numerically valid `snapshot`, `baseline`, and `delta` counters. Reasons include missing or
invalid usage, missing baseline, changed counter shape, decreased counters, and
invalid token subsets. These diagnostics preserve absent optional counters and
exclude raw provider payloads. A diagnostic delta can fail subset validation;
only `status: 'reported'` confirms a valid token report. Capture diagnostics alongside `done` when investigating
missing tokens; a successful turn alone does not prove attributable usage.

The [resume accounting investigation](codex-resume-accounting.md) documents the
reproduction and the limits of the original dogfooding evidence.

### Optional cost estimates

Use `estimateCost` after a run when an approximate text-token cost is useful.
It returns a separate result and leaves runtime-reported `usage.cost` unchanged.
No pricing request happens during adapter execution.

```ts
import { estimateCost, getDefaultPricingCachePath } from '@sublang/cligent';

// Supply authoritative USD rates per million tokens; this bypasses all I/O.
const custom = await estimateCost(usage, {
  prices: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
});

// Otherwise use models.dev. Codex often omits the effective model/provider,
// so explicitly supply the assumptions you want to use for the estimate.
const estimate = await estimateCost(usage, {
  provider: 'openai',
  model: 'gpt-5.6-luna',
});

if (estimate.status === 'estimated') {
  console.log(estimate.amount, estimate.currency, estimate.coverage);
  console.log(estimate.source, estimate.records, estimate.assumptions);
} else {
  console.log(estimate.reason, estimate.message);
}

console.log(getDefaultPricingCachePath()); // Delete this file to refresh next time.
```

Without caller prices, native model/provider records select exact entries from
[models.dev](https://models.dev). The `model` option fills only missing model
identity; `provider` explicitly selects the catalog provider for every record,
including when a native authentication-family name differs. Both choices are
reported as assumptions. No built-in provider alias or price table is maintained.
One supplied `prices` card applies uniformly across models while preserving known
per-record token details.

Catalog prices are cached on disk for 24 hours. A missing or expired cache
triggers retrieval; deleting it forces retrieval on the next catalog-based call.
If refresh fails, a valid older snapshot can still be used with `source.stale`
and its original `fetchedAt`. Without usable prices, the result is `unavailable`.
You can override `cachePath` and the retrieval `timeoutMs` (default 5,000).
`getDefaultPricingCachePath()` identifies the platform's Cligent cache file.

Estimates preserve complete or partial token coverage and return the exact rates
used for reproducibility. Cache and reasoning subsets replace ordinary rates
without being counted twice. Positive reported cache quantities require their
own rates; missing cache quantities are priced at ordinary input rates with a
disclosed assumption. A distinct reasoning price needs a reported reasoning count.
Context tiers use each record's input only when it represents exactly one request;
aggregated or unknown request counts use standard prices with an assumption.

These are text-token estimates at the selected rates, not actual charges.
Catalog calculations assume standard service mode. Subscriptions, tool fees,
regional rates, fast/priority modes, and other adjustments require caller choices
or are outside this calculation. Missing tokens or unknown model prices remain
unavailable; a partial report remains partial.

## Permissions

> Assumes imports from [Quick start](#quick-start).

Control what the agent is allowed to do with `PermissionPolicy`:

```ts
import { Cligent } from '@sublang/cligent';
import type { PermissionPolicy } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';

// PermissionPolicy controls approval posture, broad capabilities, and
// additional workspace-relative writable paths.
//
// mode accepts 'auto' | 'bypass'.
// fileWrite / shellExecute / networkAccess each accept
// 'allow' | 'ask' | 'deny' (default: 'ask' when a policy is provided).
// writablePaths grants extra writable workspace subpaths where the adapter
// has a filesystem sandbox, or is satisfied by ambient workspace access
// otherwise. It is not a command allowlist or network grant.
//
// Adapters translate these to vendor-specific controls:
//   Claude Code  → SDK permissionMode, plus a canUseTool callback
//                  for mixed allow/deny policies
//   Codex        → default_permissions + approval_policy
//                  (+ SDK config.approvals_reviewer for mode: 'auto')
//                  (+ generated profile rules for writablePaths)
//                  (lossy: networkAccess 'allow' grants network only when
//                   the policy selects :danger-full-access)
//   Gemini       → Policy Engine rules via --policy + --approval-mode
//   Kimi         → ACP mode configuration (native default or auto only)
//   OpenCode     → permission map
const permissions: PermissionPolicy = {
  fileWrite: 'ask', // prompt the user before creating or modifying files
  shellExecute: 'deny', // block all shell command execution
  networkAccess: 'allow', // allow HTTP requests without prompting
};

// For a Codex-backed agent that should keep protected auto-mode but still
// run git commands that write metadata, grant the .git subtree explicitly.
const codexGitPermissions: PermissionPolicy = {
  mode: 'auto',
  writablePaths: ['.git'],
};

const codexAgent = new Cligent(new CodexAdapter(), {
  model: 'gpt-5.3-codex',
  permissions: codexGitPermissions,
});

// Set permissions as defaults, or override per-call.
const agent = new Cligent(new ClaudeCodeAdapter(), {
  model: 'claude-opus-4-8',
  permissions,
});

for await (const event of agent.run('Refactor auth module')) {
  // ...
}

// Per-call permissions are merged by field with constructor defaults, except
// writablePaths arrays replace the default array rather than merging items.
// This keeps mode: 'auto' but replaces ['.git'] with ['dist'] for this run.
for await (const event of codexAgent.run('Build release artifacts', {
  permissions: { writablePaths: ['dist'] },
})) {
  // ...
}
```

OpenCode `mode: 'auto'` preserves configured permission rules and answers only
the asks that survive them. After a successful automated `once` reply, the
event stream includes an `opencode:permission_decision` audit event with the
native request, permission scope, and tool correlation. It remains distinct
from `permission_request`, which means a human decision is needed.

OpenCode does not support explicit `allowedTools` or `disallowedTools`,
including empty arrays. In OpenCode 1.18.25 the prompt `tools` field is merged
into persistent session permission rules rather than applied as an independent
per-call tool registry; an enabled tool can therefore override a native or
explicit deny and affect later resumed calls. Cligent rejects either option
before loading the OpenCode SDK. Omit both options or choose an adapter with
exact tool filtering.

OpenCode also rejects an explicit `maxTurns`, including zero, before loading
the SDK. OpenCode 1.18.25 exposes turn ceilings only through persistent agent
configuration, not an exact per-run control, so Cligent neither leaves a
requested limit silently unenforced nor mutates shared agent state. Omit
`maxTurns` or choose an adapter with an exact per-run turn limit.

Kimi has a deliberately narrower headless permission surface:

- Omit `permissions` to preserve the Kimi CLI's native configured rules.
- Use `permissions: { mode: 'auto' }` to select Kimi's native `auto` mode.
  Valid `writablePaths` may accompany `auto`, but the adapter reports them as
  ambient access; it does not enforce them with a filesystem sandbox or turn
  them into additional grants.
- Kimi rejects `mode: 'bypass'` because the CLI's `yolo` mode is not equivalent
  to Cligent's unchecked bypass contract. It also rejects any supplied policy
  without `mode`, including an empty policy or per-capability fields, because
  ACP cannot deterministically replace Kimi's earlier native rule decisions.
- Explicit `allowedTools` or `disallowedTools` values are unsupported and fail
  before spawn, including empty arrays. `maxTurns` and `maxBudgetUsd` likewise
  fail before spawn because Kimi ACP has no matching per-run controls.

If Kimi still sends an ACP permission request, the headless adapter emits a
`permission_request` event for observability and rejects the operation.

## Parallel execution

Run multiple `Cligent` instances side-by-side with `Cligent.parallel`:

```ts
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';

const coder = new Cligent(new ClaudeCodeAdapter(), {
  role: 'coder',
  model: 'claude-opus-4-8',
});
const reviewer = new Cligent(new CodexAdapter(), {
  role: 'reviewer',
  model: 'gpt-5.3-codex',
});

// Cligent.parallel(tasks) → AsyncGenerator<CligentEvent>
// Each task's run() is fully hardened (error isolation, abort, exactly-one-done).
// Events are interleaved as they arrive. Use event.agent to identify the
// backend and event.role to identify the task.
for await (const event of Cligent.parallel([
  { agent: coder, prompt: 'Write unit tests' },
  { agent: reviewer, prompt: 'Review the auth module' },
])) {
  console.log(`[${event.role}/${event.agent}] ${event.type}`);
}
```

Each task can have its own `abortSignal` via `overrides`. A shared signal
aborts all tasks; per-task signals abort only that task.

### Low-level parallel (runParallel)

For adapter-level parallel execution without `Cligent` wrapping, use `runParallel`:

```ts
import { runParallel } from '@sublang/cligent';

for await (const event of runParallel([
  {
    adapter: new ClaudeCodeAdapter(),
    prompt: 'Write unit tests',
    options: { model: 'claude-opus-4-8', effort: 'ultracode' },
  },
  {
    adapter: new CodexAdapter(),
    prompt: 'Write integration tests',
    options: { model: 'gpt-5.3-codex', effort: 'ultra' },
  },
])) {
  console.log(`[${event.agent}] ${event.type}`);
}
```

## Abort

> Assumes imports from [Quick start](#quick-start).

Cancel a running agent with a standard `AbortController`:

```ts
// Pass an AbortSignal via RunOptions for cooperative cancellation.
const ac = new AbortController();
setTimeout(() => ac.abort(), 30_000); // cancel after 30 s

for await (const event of agent.run('Fix the login bug', {
  abortSignal: ac.signal,
})) {
  // On abort the generator emits a final 'done' event with
  // status 'interrupted', then ends.
}
```

## Event types

`Cligent.run()` yields `CligentEvent` values, which extend `AgentEvent` with an optional `role` field. Every event carries a typed `payload`:

- `type` — discriminant tag (see table below, or a namespaced string like `'codex:file_change'`)
- `agent` — which adapter emitted the event (`'claude-code'`, `'codex'`, `'gemini'`, `'kimi'`, `'opencode'`, …)
- `role` — task-level identity from `CligentOptions.role` (undefined when not set)
- `timestamp` — Unix epoch milliseconds
- `sessionId` — groups all events within one `run()` call

| Type                           | Payload                                                                              | Description                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `init`                         | `model`, `cwd`, `tools`, `fastMode?`                                                 | Session started; Claude may report authentic fast-mode state             |
| `text`                         | `content`                                                                            | Complete text response                                                   |
| `text_delta`                   | `delta`                                                                              | Streaming text chunk                                                     |
| `thinking`                     | `summary`                                                                            | Agent reasoning                                                          |
| `tool_use`                     | `toolName`, `toolUseId`, `input`                                                     | Tool invocation                                                          |
| `tool_result`                  | `toolUseId`, `status`, `output`                                                      | Tool outcome                                                             |
| `permission_request`           | `toolName`, `toolUseId`, `input`                                                     | Agent asks for permission                                                |
| `opencode:permission_decision` | `requestId`, `permission`, `patterns`, `toolUseId`, `decision`, `automated`, `input` | Successful OpenCode auto approval audit                                  |
| `codex:usage`                  | `status`, `reason`, `resumed`, `threadId?`, `snapshot?`, `baseline?`, `delta?` | Native terminal token-accounting decision |
| `error`                        | `code`, `message`, `recoverable`                                                     | Error                                                                    |
| `done`                         | `status`, `resumeToken?`, `usage`, `durationMs`, `fastMode?`                         | Terminal event — always last; Claude may report state and response speed |
