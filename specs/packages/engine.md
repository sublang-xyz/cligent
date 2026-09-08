<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# engine: Agent Engine

## Intent

This package lets a consumer drive any registered coding-agent adapter through one role-scoped session object with a uniform event stream, per [DR-001](../decisions/001-unified-cli-agent-interface-architecture.md), [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md), and [DR-003](../decisions/003-role-scoped-session-management.md).
It owns what a caller may rely on across every adapter — event ordering and terminal cardinality, session continuity, option merging, concurrency, the portable permission and effort vocabularies, adapter-scoped fast-mode selection and observation, runtime readiness, provider model discovery, and the shape of an authentic usage report — not how any one adapter executes a prompt.
Its requirements are stated in this project's `Cligent`, `AgentAdapter`, `AgentEvent`, `AgentOptions`, `PermissionPolicy`, and `DonePayload` vocabulary, the surface it defines and every adapter implements, and in the installed `@sublang/cligent` tree from which an adapter's peer runtime is resolved.

## External Behavior

### Cligent Class

### engine-1

Per [DR-003](../decisions/003-role-scoped-session-management.md), the `Cligent` constructor shall accept this input shape:

| Input | Contract |
| --- | --- |
| `AgentAdapter` | required adapter |
| `CligentOptions` | optional instance defaults for `role`, `cwd`, `model`, `permissions`, `maxTurns`, `maxBudgetUsd`, `effort`, `fastMode`, `allowedTools`, and `disallowedTools` |
| `abortSignal` and `resume` | excluded from instance defaults and available only in `RunOptions` |

### engine-2

`Cligent.run()` shall throw when called while a previous `run()` generator on the same instance is still active (single-flight enforcement per [DR-003](../decisions/003-role-scoped-session-management.md)).

### engine-3

When `Cligent.run()` resolves instance defaults and per-call overrides, it shall select the effective `RunOptions` per [DR-003](../decisions/003-role-scoped-session-management.md) through this matrix:

| Field | Selection |
| --- | --- |
| `permissions` object | merge by member, with a provided per-call member taking precedence |
| `permissions.writablePaths` | replace the instance array with a provided per-call array rather than merging elements |
| `allowedTools` or `disallowedTools` | replace the instance array with a provided per-call array, including an empty one |
| `fastMode` or another scalar shared by both option types | use the per-call value when provided, including `false`, otherwise the instance default |
| `abortSignal` or `resume` | accept only the per-call value because neither field exists in instance defaults |

### engine-4

When `Cligent.run()` yields an event, it shall select the `role` member through this matrix:

| `CligentOptions.role` | Event `role` |
| --- | --- |
| set | the configured value |
| omitted | omitted |

### Session Continuity

### engine-5

When the adapter emits a `done` event with a `resumeToken`, `Cligent` shall store that token for session continuity.

### engine-33

When a subsequent `Cligent.run()` selects the adapter's `resume` option, it shall use this precedence matrix:

| Per-call `resume` | Stored token from [[engine-5](#engine-5)] | Adapter option |
| --- | --- | --- |
| string, including empty | any | the exact per-call string |
| `false` | any | omitted, forcing a fresh session |
| omitted | stored string, including empty | the exact stored token |
| omitted | absent | omitted |

### engine-6

When the adapter emits `done` without a `resumeToken`, `Cligent` shall leave subsequent calls without an injected `resume`, making auto-resume a no-op for adapters that do not support it.

### Event Helpers

### engine-7

The engine shall export `createEvent()`, `generateSessionId()`, and `isAgentEvent()` helpers for constructing events, generating unique session IDs, and runtime type-guarding `AgentEvent` values.

### Protocol Hardening (run)

### engine-8

When the adapter's generator throws, `run()` shall select this outcome:

| Stream state | Outcome |
| --- | --- |
| no `done` yielded | `error` with `code: 'ADAPTER_ERROR'` and `recoverable: false`, then `done` with `status: 'error'`, clearing any stored resume token before a subsequent call |
| `done` already yielded | suppress the exception |

### engine-9

When an `AbortSignal` is already aborted before `run()` invokes the adapter, `run()` shall yield `done` with `status: 'interrupted'` without calling the adapter.

### engine-34

When an `AbortSignal` fires after adapter invocation and before terminal `done`, `run()` shall call `.return()` on the adapter generator after applying [[engine-35](#engine-35)]'s bounded drain outcome.

### engine-35

When an abort interrupts a pending adapter read, `run()` shall drain for at most 500 milliseconds and select this outcome:

| Drain result | Outcome |
| --- | --- |
| non-terminal event | suppress it and continue draining within the same deadline |
| adapter-emitted `done` | yield and process that event normally, including [[engine-5](#engine-5)] resume-token capture, before generator cleanup |
| no `done` before the deadline | synthesize `done` with `status: 'interrupted'`, preserving a non-empty inbound `resume` token when present and never fabricating one from a non-terminal event `sessionId` |

### engine-73

While a built-in `AgentAdapter.run()` is active and has emitted no terminal `done`, when its caller `AbortSignal` fires, the adapter shall yield exactly one `done` with `status: 'interrupted'`.

### engine-10

When a `done` event is yielded from the adapter or synthesized, the engine shall call `.return()` on the generator and suppress every subsequent event so nothing follows that terminal.

### engine-11

Exactly one `done` event shall be yielded per `run()` call.

### engine-12

When the adapter's generator exhausts without yielding a `done` event, `run()` shall yield an `error` event (`code: 'MISSING_DONE'`, `recoverable: false`) followed by a `done` event (`status: 'error'`) and clear any stored resume token before a subsequent call.

### engine-13

When the engine synthesizes terminal `done`, it shall select this payload shape:

| Member | Value |
| --- | --- |
| `usage.toolUses` | the independently observed distinct tool-use count, or zero |
| `usage.tokens` and `usage.cost` | omitted rather than fabricated |
| `durationMs` | elapsed time measured from adapter invocation |

### engine-36

When an adapter-emitted `done` is available before terminal synthesis, the engine shall yield that event instead of a synthesized one, including when [[engine-35](#engine-35)] observes an interrupted terminal during abort drain.

### Cligent.parallel()

### engine-14

`Cligent.parallel()` shall merge multiple `Cligent` streams as they become available while selecting each yielded `CligentEvent` identity through this matrix:

| Member and source configuration | Outcome |
| --- | --- |
| `agent` | the source adapter's backend identity, always present |
| configured `CligentOptions.role` | the exact configured task identity selected by [[engine-4](#engine-4)] |
| omitted `CligentOptions.role` | no `role` member per [[engine-4](#engine-4)] |

### engine-15

When one instance's adapter throws before terminal `done`, `parallel()` shall isolate the failure by yielding `error` and `done` for that instance, removing it from the pool, and continuing every remaining instance.

### engine-16

When one or more `Cligent.parallel()` task signals fire, `parallel()` shall select this interruption scope:

| Signal ownership | Outcome |
| --- | --- |
| signal used by one active task | yield interrupted `done` for that task, remove it, and continue the others |
| one controller's signal shared by several active tasks | yield interrupted `done` for every task sharing it and remove each while unrelated tasks continue |

### Tool Filtering

### engine-17

When an adapter maps portable tool restrictions, it shall select this outcome per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md):

| Input and adapter surface | Outcome |
| --- | --- |
| both lists omitted | preserve the adapter's native tool surface |
| non-empty `allowedTools` | restrict available tools to those exact identifiers |
| empty `allowedTools` | make no tools available |
| `disallowedTools` also present | remove its exact identifiers from the allowed set |
| adapter explicitly documents pattern support | apply that documented matching behavior instead of exact matching |
| an explicit restriction has no compatible surface | reject before backend invocation rather than ignore or weaken it |

### Adapter Thread Safety

### engine-18

Where an adapter documents no environmental constraint, concurrent calls on one `AgentAdapter` instance shall keep streams and options isolated through fresh call-local state without mutable cross-run instance state per [DR-003](../decisions/003-role-scoped-session-management.md), except for [[engine-37](#engine-37)] and [[engine-38](#engine-38)].

### engine-37

Where a backend reports cumulative per-session rather than per-turn token accounting, the adapter shall manage its permitted baseline through this attribution matrix:

| Session state | Outcome |
| --- | --- |
| backend session identifier known | retain at most one newest baseline under that identifier |
| different session identifier | never observe another session's counters |
| resumed session whose baseline the adapter did not observe | omit tokens under [[engine-58](#engine-58)] rather than attribute the accumulated total to one turn |

### engine-38

Where an adapter retains [[engine-37](#engine-37)]'s cumulative baseline, it shall order concurrent calls through this matrix:

| Calls or exit | Outcome |
| --- | --- |
| same non-empty resume identifier | enter the backend serially through terminal cleanup so snapshots have one causal order |
| fresh calls or different resume identifiers | remain concurrent |
| normal, error, interrupted, or setup-failure exit after acquisition | release the queue for its successor |

### Effort

### engine-20

Per [DR-009](../decisions/009-adapter-scoped-effort-vocabularies.md), `AgentOptions<E>.effort` shall accept the selected adapter's effort vocabulary `E`, with `undefined` deferring to applicable adapter, model, account, user-configuration, and configuration-isolation defaults.

### engine-39

The public `PortableEffort` type shall define the ordered least-to-greatest ladder `'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`.

### engine-40

The public built-in effort aliases shall select their values through this matrix:

| Alias | Values |
| --- | --- |
| `ClaudeEffort` | [[engine-39](#engine-39)] plus `ultracode`, whose provider mapping is defined by [[claude-code-8](adapters/claude-code.md#claude-code-8)] |
| `CodexEffort` | [[engine-39](#engine-39)] plus `ultra`, whose provider mapping is defined by [[codex-7](adapters/codex.md#codex-7)] |
| `GeminiEffort` | [[engine-39](#engine-39)], whose provider mapping is defined by [[gemini-11](adapters/gemini.md#gemini-11)] |
| `OpenCodeEffort` | [[engine-39](#engine-39)], whose provider mapping is defined by [[opencode-12](adapters/opencode.md#opencode-12)] |
| `KimiEffort` | provider-native binary union of `'off'` and `'on'`, whose provider mapping is defined by [[kimi-9](adapters/kimi.md#kimi-9)] |
| adapter-neutral `Effort` | every value present in the five aliases |

### engine-41

The public built-in effort aliases shall derive from the literal `values` arrays in [[engine-24](#engine-24)] rather than maintain a second vocabulary definition.

### engine-42

Where a built-in provider lacks a one-to-one portable value, its adapter shall select the portable fallback through this matrix:

| Mapping state | Outcome |
| --- | --- |
| provider has neighbouring supported values | select the nearest neighbour in [[engine-39](#engine-39)]'s order |
| mapping depends on an absent or unrecognised concrete model or provider | leave the provider override unset and document that behavior in the adapter item |

### engine-43

The statically adapter-bound `AgentAdapter<E>`, `CligentOptions<E>`, `RunOptions<E>`, and `Cligent<E>` surfaces shall preserve one adapter's vocabulary through constructor defaults, run overrides, direct calls, `Cligent.parallel()`, and `runParallel()` without widening it to another adapter's values.

### engine-44

Where a custom adapter binds an arbitrary string-literal effort vocabulary, direct and heterogeneous parallel calls shall preserve its names and number of levels.

### engine-45

On the legacy name-based mutable-registry path, `runAgent()` shall accept `AgentOptions<string>` and forward the exact effort string without claiming compile-time name-to-vocabulary correlation across registrations that may be removed or rebound.

### engine-46

When an effort reaches a dynamic input path, validation responsibility shall follow this matrix:

| Adapter path | Responsibility |
| --- | --- |
| built-in adapter | perform its specified runtime validation |
| custom adapter | validate its own dynamic input |
| caller requiring compile-time correlation | use direct `AgentAdapter<E>`, `Cligent`, `Cligent.parallel()`, or `runParallel()` |

### engine-24

The exported `EFFORT_SUPPORT` object shall be deeply frozen at runtime and give each built-in adapter immutable `values`, `orchestrationValues`, `modelDependent`, and `notes` members without promising model, account, or installed-runtime availability.

### engine-47

Each `EFFORT_SUPPORT` entry shall select its machine-readable members through this matrix:

| Member | Required value |
| --- | --- |
| `values` | the adapter's [[engine-40](#engine-40)] alias in declared order |
| Claude `orchestrationValues` | `['ultracode']` |
| Codex `orchestrationValues` | `['ultra']` |
| Gemini, OpenCode, or Kimi `orchestrationValues` | `[]` |
| `modelDependent` | `true` for every built-in adapter |

### engine-48

Each `EFFORT_SUPPORT.notes` value shall disclose any lossy mapping or omitted override caused by an absent concrete model or provider, with Kimi stating that `on` selects the chosen model's native default thinking effort rather than a portable reasoning-depth tier under [[kimi-9](adapters/kimi.md#kimi-9)].

### engine-49

The public `getEffortSupport()`, `supportedEffortValues()`, `isEffortSupported()`, and `assertSupportedEffort()` helpers shall expose and validate the same `EFFORT_SUPPORT` values, resolve `claude` to `claude-code`, and narrow a known adapter's accepted values to its [[engine-40](#engine-40)] alias.

### engine-50

When an effort helper receives an unknown adapter or unsupported value, it shall select this result:

| Input and helper kind | Result |
| --- | --- |
| unknown adapter; `getEffortSupport()` or `supportedEffortValues()` | `undefined` |
| unknown adapter; `isEffortSupported()` | `false` |
| unknown adapter; `assertSupportedEffort()` | error naming the adapter and validation path |
| known adapter and unsupported value; `assertSupportedEffort()` | error naming the adapter, validation path, and allowed values |

### engine-51

Where a metadata-accepted effort is unavailable to the selected model, account, or installed runtime, when the backend rejects the run, the adapter shall expose that upstream failure through its normal error path without substituting another effort.

### Fast Mode

### engine-74

Per [DR-021](../decisions/021-agent-runtime-fast-mode.md), the public statically adapter-bound surfaces shall preserve a defaulted fast-mode capability parameter `FM extends boolean = never` through this matrix:

| Surface or adapter | Contract |
| --- | --- |
| `AgentAdapter<E, FM>`, `AgentOptions<E, FM>`, `CligentOptions<E, FM>`, `RunOptions<E, FM>`, and `Cligent<E, FM>` | expose `fastMode?: FM` and retain `FM` through constructor defaults and run overrides |
| `Cligent.parallel()` and `runParallel()` | preserve each source adapter's `FM` independently |
| Claude Code or Codex | bind `boolean` |
| Gemini, OpenCode, or Kimi | bind `never`, making an explicit boolean a compile-time error |
| custom adapter omitting `FM` | default to `never` |
| custom adapter opting in | bind `boolean` |
| existing single-parameter generic source | remain source- and assignment-compatible when it does not supply `fastMode`, including assignment of an inferred supported or unsupported adapter and `Cligent` instance to its existing `AgentAdapter<E>` or `Cligent<E>` annotation |

### engine-75

When a `fastMode` option reaches a typed or dynamic adapter path, Cligent shall select this outcome per [DR-021](../decisions/021-agent-runtime-fast-mode.md):

| Input and adapter | Outcome |
| --- | --- |
| omitted | add no Cligent fast-mode override |
| `true` on a request-supported adapter | forward the adapter's native fast request |
| `false` on a request-supported adapter | forward the adapter's native standard or off request |
| a defined non-boolean value on a request-supported built-in adapter | reject before backend invocation with an error naming the adapter, validation path, and expected boolean type |
| any defined value, including `false`, on an unsupported built-in adapter | reject before backend invocation with an error naming the adapter and validation path |
| any defined value on a dynamically registered custom adapter | let that adapter validate its declared capability and value |
| legacy name-based mutable-registry path | accept `AgentOptions<string, boolean>` without claiming compile-time name-to-capability correlation |

### engine-76

The exported `FAST_MODE_SUPPORT` object shall be deeply frozen at runtime and expose immutable descriptors, including `notes`, through this adapter-transport matrix without promising selected-model, account, provider, policy, network, or installed-runtime availability:

| Adapter | `requestSupported` | `observation` | `modelDependent` | `accountDependent` |
| --- | ---: | --- | ---: | ---: |
| `claude-code` | `true` | `'init-and-done'` | `true` | `true` |
| `codex` | `true` | `'none'` | `true` | `true` |
| `gemini` | `false` | `'none'` | `false` | `false` |
| `opencode` | `false` | `'none'` | `false` | `false` |
| `kimi` | `false` | `'none'` | `false` | `false` |

The `notes` define support as native-request delivery, disclose Claude's authentic init-and-terminal observation under [[claude-code-53](adapters/claude-code.md#claude-code-53)], disclose Codex's lack of an effective-tier SDK event under [[codex-56](adapters/codex.md#codex-56)], and state that the other three adapters expose no native request surface under [[engine-75](#engine-75)].

### engine-77

The public `getFastModeSupport()`, `isFastModeSupported()`, and `assertFastModeSupported()` helpers shall read the same [[engine-76](#engine-76)] data and select this result:

| Input and helper | Result |
| --- | --- |
| `claude` alias | resolve to `claude-code` |
| known adapter; `getFastModeSupport()` | its frozen descriptor |
| known adapter; `isFastModeSupported()` | its `requestSupported` value |
| known unsupported adapter; `assertFastModeSupported()` | error naming the adapter and validation path |
| unknown adapter; `getFastModeSupport()` | `undefined` |
| unknown adapter; `isFastModeSupported()` | `false` |
| unknown adapter; `assertFastModeSupported()` | error naming the adapter and validation path |

### engine-78

The public fast-mode observation types and payload members shall preserve only authentic upstream observations through this matrix per [DR-021](../decisions/021-agent-runtime-fast-mode.md):

| Member or source state | Contract |
| --- | --- |
| `FastModeObservation<RS extends FastModeResponseSpeed = never>` | state and disabled-reason members plus `responseSpeed?: RS`, with the default `never` forbidding response speed |
| `InitPayload.fastMode` | optional default `FastModeObservation` |
| `DonePayload.fastMode` | optional `FastModeTerminalObservation` |
| `FastModeTerminalObservation` | alias of `FastModeObservation<FastModeResponseSpeed>` |
| `state` | optional `FastModeState` value `'off' \| 'cooldown' \| 'on'` |
| `disabledReason` | optional `FastModeDisabledReason` value `'free' \| 'preference' \| 'extra_usage_disabled' \| 'network_error' \| 'unknown' \| 'not_first_party' \| 'disabled_by_env' \| 'model_not_allowed' \| 'sdk_opt_in_required' \| 'pending'` |
| `responseSpeed` | optional `FastModeResponseSpeed` value `'standard' \| 'fast'`, scoped to the response represented by the upstream terminal usage rather than every internal model request |
| terminal response-speed source is null, unrecognized, or lacks authentic evidence that any upstream response completed | omit `responseSpeed` |
| one or more observed members | emit one observation object containing exactly those members |
| no observed member | omit `fastMode` entirely |
| requested option without observation | never echo it as observation or synthesize `off`, `unknown`, or another placeholder |
| upstream `cooldown` without a disabled reason | preserve only the state and invent no reason |

### engine-79

Where [[engine-76](#engine-76)] marks an adapter request-supported but fast mode is unavailable to the selected model, account, provider, policy, network, or installed runtime, when the backend determines the outcome, the adapter shall preserve it without Cligent substitution through this matrix:

| Backend outcome | Cligent outcome |
| --- | --- |
| refusal | expose the ordinary upstream error path without substituting another fast-mode request |
| native standard-speed fallback or cooldown | preserve the ordinary backend completion and any authentic [[engine-78](#engine-78)] observation without manufacturing an error or fast-delivery claim |
| no effective-tier observation | emit no placeholder or requested-value echo |

### Permission Policy Mode

### engine-21

`PermissionPolicy.mode` shall accept the closed set `'auto' | 'bypass' | undefined` per [DR-005](../decisions/005-per-adapter-permission-configuration.md).

### engine-52

When a built-in adapter maps `PermissionPolicy.mode` at its SDK-knob selection step, it shall apply this exhaustive matrix per [DR-005](../decisions/005-per-adapter-permission-configuration.md):

| Mode and SDK surface | Outcome |
| --- | --- |
| `permissions` policy absent | preserve the adapter's native SDK posture |
| policy present with `mode: undefined`, including an empty policy | derive SDK options from `fileWrite`, `shellExecute`, and `networkAccess`, with the empty-policy result stated by the adapter |
| `auto` | select the provider's native auto posture, including its protected automatic reviewer when applicable, without expanding filesystem, network, or sandbox permissions |
| `bypass` with native unchecked bypass | select it |
| posture and local-access axes are independent | let mode govern posture while capabilities may additionally derive local access |
| posture and local-access axes are not independent | let mode take precedence over capability levels |
| architecture cannot reach the selected mode | reject at mapping time with an error naming the constraint, surfaced through the decision's failure rule |

### Workspace Writable Paths

### engine-22

`PermissionPolicy.writablePaths` shall accept an optional array of workspace-relative path strings per [DR-006](../decisions/006-workspace-writable-paths.md).

### engine-53

When an adapter normalizes a `writablePaths` entry, it shall select this result:

| Input | Result |
| --- | --- |
| accepted workspace-relative path | canonical `/` separators with leading `./`, trailing slashes, and `.` components removed |
| empty or root-equivalent path | reject |
| absolute path, `..`, empty segment, glob metacharacter, shell expansion character, or control character | reject |

### engine-23

`WritablePathsEnforcement` shall accept the closed set `'profile' | 'sandbox' | 'ambient'` per [DR-006](../decisions/006-workspace-writable-paths.md).

### engine-54

When an adapter produces `WritablePathsPermissionMapping`, it shall select this output:

| `writablePaths` policy | Output |
| --- | --- |
| accepted non-empty array | [[engine-53](#engine-53)] canonical `paths` and the field-local [[engine-23](#engine-23)] enforcement class |
| absent or empty | no mapping payload |

### Runtime Compatibility

### engine-25

When an adapter evaluates runtime compatibility, it shall select the load outcome through this matrix against [[package-16](package.md#package-16)]:

| Runtime source and observed version | Outcome |
| --- | --- |
| package in the installed `@sublang/cligent` tree | read its declared version through the same resolution used to load it |
| configured executable command found through native `PATH` lookup | read the version reported by that command through the same native lookup used to execute it, retaining the configured command as its portable identity rather than inventing a host-selected absolute path |
| readable peer version below the supported floor | refuse with an error naming the package, installed and required versions, resolved `node_modules` tree, and repair command |
| readable CLI version below the supported floor | refuse with an error naming the configured command, installed and required versions, and repair command |
| readable version at or above the supported floor | load unchanged, including when the version is above the tested ceiling |
| unreadable version | load unchanged because vendored, bundled, or archived layouts remain supported and unreadability is not evidence of incompatibility |

### engine-26

The public engine API shall expose a runtime-readiness classification carrying the installed version when read, the supported range and tested version from [[package-16](package.md#package-16)], a peer's resolved `node_modules` tree as `resolvedFrom` or a CLI's configured command as `target.command`, and repair commands through this matrix:

| Runtime state | Verdict | `adapter.isAvailable()` compatibility |
| --- | --- | --- |
| available within the supported floor and tested ceiling | `satisfied` | `true` |
| absent | `missing` | `false` |
| below the supported floor | `unsupported` | `false` |
| above the tested version | `untested` | `true` |
| available but version unreadable | `unknown`, never a failure in this package's caller-facing behavior | `true` |

### Authentic Usage Accounting

### engine-31

Per [DR-014](../decisions/014-unified-token-usage-breakdown.md), `DonePayload.usage` shall expose this public shape:

| Member | Contract |
| --- | --- |
| `toolUses` | required finite non-negative safe integer under [[engine-56](#engine-56)] |
| `tokens` | optional authentic token report |
| `cost` | optional provenance-bearing cost report |
| `tokenAvailability`, `inputTokens`, `outputTokens`, `totalCostUsd`, or `breakdown` | absent from `DoneUsage` |

### engine-55

Where `usage.tokens` is present, its totals shall include cache and reasoning quantities through this matrix:

| Total | Inclusive quantities |
| --- | --- |
| `totals.input.total` | uncached input, cache reads, and cache writes |
| `totals.output.total` | visible output and reasoning or thinking |

### engine-56

Every numeric member of an authentic usage report shall satisfy this validity matrix:

| Member kind | Required form |
| --- | --- |
| total, detail, priced-unit quantity, or cost amount | finite and non-negative |
| token, request, tool-use, or other count | finite, non-negative safe integer |

### engine-57

When a producer publishes token details, it shall preserve their measurement and reconciliation semantics through this matrix:

| Detail state | Meaning or constraint |
| --- | --- |
| absent | unreported |
| present zero | measured zero |
| input `uncached`, `cacheRead`, or `cacheWrite` | exact subset of [[engine-55](#engine-55)]'s inclusive input total |
| output `visible` or `reasoning` | exact subset of [[engine-55](#engine-55)]'s inclusive output total |
| every detail on one side present | details sum exactly to that side's total |
| unexplained residual or invalid subtraction | never clamp, estimate, or allocate it |

### engine-58

When a producer selects token-report coverage, it shall use this authenticity matrix:

| Established scope | Outcome |
| --- | --- |
| every model request causally owned by the current invocation, including descendant work and excluding resumed history | `coverage: 'complete'` |
| every published number authentic but the runtime surface may omit invocation work | `coverage: 'partial'` |
| no exact owned scope, including a synthesized terminal or runtime with no authentic token source | omit `tokens` rather than publish a placeholder |

### engine-59

When `tokens.records` is present, the producer shall select each record and the aggregate through this matrix:

| Record concern | Required outcome |
| --- | --- |
| scope | one authentic rate-card group with inclusive input and output totals |
| reconciliation | records sum exactly to `tokens.totals` and every aggregate detail published |
| model or provider unknown | omit that identity rather than substitute a placeholder |

### engine-60

When a producer constructs a usage record, it shall select the optional `requests` member through this context-tier matrix:

| Value | Meaning |
| --- | --- |
| absent | request count unreported |
| `1` | the record describes one model request |
| greater positive safe integer | counts aggregate several requests whose per-request context tiers cannot be recovered |
| any other value | invalid under [[engine-56](#engine-56)] |

### engine-61

Where a runtime reports cost, the producer shall preserve `{ amount, currency: 'USD', source }` without applying a Cligent price table, with `source` distinguishing `agent-estimate`, `provider-reported`, and `account-estimate` and never claiming billed cost without that authority.

### engine-62

When token and cost accounting are independently available, the producer shall preserve either valid report when the other is absent.

### engine-63

When a runtime reports a separately priced non-token quantity, the producer shall emit it as a named `pricedUnits` member rather than fold it into token totals.

### engine-64

Where an adapter reads a run-owned supplementary accounting source, it shall publish that source only after cross-validating it against ordinary terminal counters, omitting it on absence, read or parse failure, duplication, or mismatch and remaining inside every applicable protocol boundary.

### engine-65

When the engine or a built-in adapter emits any terminal status, it shall preserve the independently known `toolUses` count whether `tokens` and `cost` are present or absent.

### engine-84

When an adapter identifies a rejected provider session token, it shall report `SESSION_RESUME_REJECTED` only with proof that the selected nonempty token was rejected before prompt execution ([DR-022](../decisions/022-definite-session-rejection.md)):

- emit `error` with `code:'SESSION_RESUME_REJECTED'` and `recoverable:true`, followed by the ordinary error terminal event without a resume token;
- authoritative session-lookup or provider rejection evidence must prove that no prompt execution or model/tool output occurred for the call; absence of observed events is insufficient;
- authentication, permissions/settings rejection, timeouts, transport failures, unknown errors and any possible execution retain ordinary error codes;
- diagnostic text and user content never establish the classification;
- the engine preserves the classification and clears the rejected automatic resume token; neither engine nor adapter retries, and a fresh call remains the caller's decision.

### engine-86

When a caller requests `discoverAgentModels(adapter, options?)`, Cligent shall return the selected runtime's model catalog without sending a prompt, creating or resuming a durable provider conversation, or changing configuration ([DR-023](../decisions/023-provider-model-discovery.md)):

- `options` accepts `cwd`, an environment overlay, an abort signal, and a positive `timeoutMs` (default `10000`); discovery ends on cancellation or deadline and closes its owned SDK query or child process; child cleanup allows at most 500 ms for termination before closing inherited pipes and reporting failure.
- Success is `{status:'available',models}` in provider order, retaining only the first row for each exact `id`; unsupported discovery, unavailable runtime, malformed responses and operational failures return `{status:'unavailable',reason}`, never an invented catalog.
- Each model has `id` and `name`, with `resolvedModel`, `effortValues`, `defaultEffort` and `fastModeSupported` only when reported or derived through an existing adapter mapping [[engine-42](#engine-42)]; absent effort/fast support means unknown, while `[]` and `false` mean known unsupported.
- Model effort choices include only levels this adapter transports [[engine-24](#engine-24)]; they remain distinct from adapter-wide acceptance, orchestration capabilities and installed-runtime readiness [[engine-26](#engine-26)] [[engine-76](#engine-76)].
- Claude uses its resolved Agent SDK's initialization model catalog with empty input and persistence/hooks/tools disabled; Codex uses its SDK-owned executable's `initialize` and paginated `model/list`, without a thread or turn request, deriving fast support only from a reported `additionalSpeedTiers` list containing `fast` (an empty list means false).
- JavaScript entry points run in Node mode under Node or Electron, with overrides confined to the discovery child’s environment.
- OpenCode uses `opencode models`; Kimi uses `kimi provider list --json` and returns only model aliases, never provider credentials; Gemini reports discovery unavailable until a non-session listing is supported.
- The catalog is advisory: absence never rejects a custom model string, establishes account entitlement, substitutes settings, or triggers discovery during ordinary validation or execution.

## Verification

### engine-101

Given a mock adapter, when `Cligent.run()` is exercised with configured and omitted roles, the check shall assert [[engine-4](#engine-4)]'s exact event-member matrix.

### engine-102

When `run()` is called while a previous `run()` generator is still active on the same `Cligent` instance, the second call shall throw [[engine-2](#engine-2)].

### engine-103

Where instance defaults and per-call overrides are supplied, when `run()` invokes the adapter, the check shall assert every [[engine-3](#engine-3)] field-selection row, including per-call replacement of `permissions.writablePaths`, `allowedTools`, and `disallowedTools` arrays plus both `fastMode` boolean override directions.

### engine-104

Given an adapter terminal carrying a resume token, when later calls omit, explicitly replace, or set `resume: false`, the check shall assert token capture under [[engine-5](#engine-5)] and every [[engine-33](#engine-33)] selection outcome.

### engine-105

When the adapter emits `done` without `resumeToken`, the next `run()` call shall not pass `resume` to the adapter [[engine-6](#engine-6)].

### engine-106

Given a mock [[engine-1](#engine-1)] `AgentAdapter` that yields canned events, when the consumer constructs `Cligent` and calls `run()`, the check shall assert those `CligentEvent` values remain in order and exactly one is terminal under [[engine-11](#engine-11)].

### engine-107

When `AbortSignal` fires during `run()`, the check shall assert [[engine-34](#engine-34)] `.return()` invocation, [[engine-35](#engine-35)] interrupted terminal output, and post-terminal suppression under [[engine-10](#engine-10)].

### engine-66

Given an adapter that yields post-abort non-terminal events then interrupted `done` with a resume token within 500 milliseconds, when abort interrupts a pending read, the check shall assert [[engine-35](#engine-35)] suppression of those non-terminals, native-terminal precedence under [[engine-36](#engine-36)], [[engine-5](#engine-5)] token capture, and injection on the next call through [[engine-33](#engine-33)].

### engine-67

Given an adapter that reaches no terminal within 500 milliseconds and a `Cligent` holding a prior resume token, when abort interrupts a pending read, the check shall assert [[engine-35](#engine-35)]'s synthesized interrupted terminal without clearing the stored token selected by [[engine-33](#engine-33)] on the next call.

### engine-108

When the adapter generator throws before and after terminal output, the check shall assert both rows of [[engine-8](#engine-8)]'s timing matrix, including stored-resume clearing after a pre-terminal throw.

### engine-109

When the adapter's generator exhausts without yielding `done`, the check shall assert [[engine-12](#engine-12)]'s exact error-then-`done` sequence and stored-resume clearing before the next omitted-resume call.

### engine-110

When `AbortSignal` fires concurrently with the adapter emitting its own `done`, the engine shall yield exactly one `done` event per session under [[engine-36](#engine-36)] and [[engine-11](#engine-11)].

### engine-111

Given multiple `Cligent` instances with mock adapters, when calling `Cligent.parallel()`, the check shall assert [[engine-14](#engine-14)] interleaving and identity selection plus exactly one [[engine-11](#engine-11)] terminal per instance through this matrix:

| Source role | Every yielded event |
| --- | --- |
| configured | exact backend `agent` and configured `role` |
| omitted | exact backend `agent` and no `role` member |

### engine-112

Given one failing and one healthy parallel instance, when the first adapter throws, the check shall assert [[engine-15](#engine-15)]'s failing-stream terminal sequence and continued healthy stream.

### engine-113

Given one exhausting and one healthy parallel instance, when the first generator ends without `done`, the check shall assert [[engine-12](#engine-12)]'s missing-terminal sequence and [[engine-15](#engine-15)]'s continued healthy stream.

### engine-114

When task-local and shared abort signals fire during parallel runs, the check shall assert every interruption-scope row of [[engine-16](#engine-16)].

### engine-115

Where a TypeScript consumer uses the public effort API, the type-level check shall assert [[engine-39](#engine-39)] and [[engine-40](#engine-40)] alias imports derived under [[engine-41](#engine-41)], [[engine-43](#engine-43)] built-in and heterogeneous correlation, [[engine-44](#engine-44)] custom vocabularies, and compile-time rejection of cross-adapter and out-of-vocabulary values.

### engine-116

Where a consumer imports effort metadata and helpers from the public entry point, the check shall assert [[engine-24](#engine-24)] immutability, [[engine-47](#engine-47)] entry values, [[engine-48](#engine-48)] notes, [[engine-49](#engine-49)] helper consistency and narrowing, and every [[engine-50](#engine-50)] invalid-input outcome.

### engine-117

Where a custom adapter is registered through the legacy mutable registry, when `runAgent()` receives a custom effort, the runtime check shall assert exact forwarding under [[engine-45](#engine-45)].

### engine-80

Where a TypeScript consumer uses the public fast-mode API, the type-level check shall assert [[engine-1](#engine-1)] constructor-option placement; [[engine-74](#engine-74)] built-in, custom, direct, and heterogeneous-parallel capability correlation; source and assignment compatibility for existing single-parameter `AgentAdapter<E>`, `AgentOptions<E>`, `CligentOptions<E>`, `RunOptions<E>`, and `Cligent<E>` uses that omit `fastMode`; and [[engine-78](#engine-78)] observation member unions and phase availability, including rejection of a named terminal-observation value on `InitPayload`.

### engine-81

Where a consumer imports fast-mode metadata and helpers from the public entry point, the check shall assert [[engine-76](#engine-76)] deep immutability, every descriptor row, and required notes content plus [[engine-77](#engine-77)] alias, known-adapter, unsupported-adapter, and unknown-adapter outcomes.

### engine-82

Where supported built-in adapters, unsupported built-in adapters, and custom adapters are exercised at the engine integration boundary through direct, instance-default, per-run, parallel, and legacy-registry paths, the check shall assert [[engine-75](#engine-75)] omitted, boolean, malformed-value, and custom-validation outcomes, [[engine-3](#engine-3)] explicit-false precedence, [[engine-74](#engine-74)] custom opt-in, and pre-backend rejection for Gemini, OpenCode, and Kimi.

### engine-83

Where request-supported adapter integrations produce refusal, standard-speed fallback, cooldown, authentic partial observation, null or unrecognized speed, speed without completed-response evidence, and no-observation outcomes, when their unified streams are consumed, the check shall assert every [[engine-79](#engine-79)] outcome and [[engine-78](#engine-78)] omission, verbatim-value, completed-response-evidence, response-scope, and no-placeholder rule.

### engine-68

Where a TypeScript consumer uses the legacy mutable-registry declarations, the type-level check shall assert [[engine-45](#engine-45)]'s `AgentOptions<string>` acceptance without name-to-vocabulary narrowing.

### engine-118

Where installed peer and executable runtimes exercise every supported, missing, below-floor, above-tested, and unreadable-version state, the check shall assert [[engine-25](#engine-25)]'s load outcomes and the exact [[engine-26](#engine-26)] verdict, peer-tree or CLI-command identity, repair, and boolean compatibility rows.

### engine-122

Where a TypeScript consumer constructs `DoneUsage`, the type-level check shall assert [[engine-31](#engine-31)]'s required, optional, and removed members.

### engine-69

When the engine synthesizes terminal `done` across its terminal paths, the check shall assert [[engine-13](#engine-13)]'s unique observed tool count with no token or cost placeholder.

### engine-70

Where a producer publishes token totals, details, requests, records, and priced units, the check shall assert [[engine-55](#engine-55)], [[engine-56](#engine-56)], [[engine-57](#engine-57)], [[engine-59](#engine-59)], [[engine-60](#engine-60)], and [[engine-63](#engine-63)] across valid, invalid, zero, and omitted members.

### engine-71

Where exact token counters cover complete, partial, or unestablished invocation scope, the check shall assert every [[engine-58](#engine-58)] classification and omission outcome.

### engine-72

Where cost and token reports are present together or independently, the check shall assert [[engine-61](#engine-61)] provenance and currency plus [[engine-62](#engine-62)]'s valid independent shapes.

### engine-201

Given an application configuration that supplies a permission policy for an agent role, when the configuration loader returns, the loaded value shall be a typed [[engine-21](#engine-21)] `PermissionPolicy` whose [[engine-22](#engine-22)] `writablePaths` entries satisfy [[engine-53](#engine-53)].

### engine-202

Given a `PermissionPolicy` accepted by a caller, when the runtime constructs the corresponding `Cligent` and calls `run()`, the check shall assert the exact value reaches `AgentOptions.permissions` unchanged under [[engine-3](#engine-3)], including its [[engine-21](#engine-21)] mode and any [[engine-53](#engine-53)] canonical `writablePaths`.

### engine-203

Given each built-in adapter with an active `run()` and no terminal `done`, when its caller `AbortSignal` fires, the check shall assert exactly one interrupted terminal under [[engine-73](#engine-73)].

### engine-204

Where a caller selects representative effort values covering each distinct adapter transport class, when the runtime constructs and invokes the corresponding `Cligent`, each value shall reach that adapter's own effort surface without cross-aliasing under [[engine-43](#engine-43)].

### engine-209

Given `allowedTools` and `disallowedTools` options, each adapter shall enforce whitelist and precedence semantics or reject before backend invocation when it has no compatible restriction surface, per [[engine-17](#engine-17)].

### engine-214

Where an adapter documents no environmental constraint, when concurrent calls use one adapter instance, the check shall assert [[engine-18](#engine-18)] stream and option isolation with no cross-run state beyond [[engine-37](#engine-37)]'s baseline and [[engine-38](#engine-38)]'s ordering queue.

### engine-218

Where built-in adapters receive every accepted, omitted, other-adapter, and arbitrary effort input, when each maps a run, the check shall assert this matrix:

| Input | Assertion |
| --- | --- |
| each [[engine-40](#engine-40)] value | observable control for that value, including [[engine-42](#engine-42)]'s lossy mappings, and none belonging to another adapter's vocabulary |
| omitted | no effort, orchestration, settings-alias, or variant override |
| other adapter's provider-specific value or arbitrary unknown string | rejection before backend invocation with [[engine-50](#engine-50)]'s adapter and allowed-values error |

### engine-219

Where each built-in adapter receives `CligentOptions.permissions = { mode: 'auto' }`, when `run()` first creates and then updates a temporary file in a throwaway working directory, the acceptance check shall exercise [[engine-52](#engine-52)] and assert one complete fresh probe with these conditions:

- expected filesystem contents after each phase as the ground truth;
- no `permission_request`, denied tool result, or error in either stream;
- successful terminal `done` in each stream;
- retry only after explicit upstream overload, rate limit, or service unavailability, with at most two retries and every other failure or third consecutive named transient fatal;
- per-adapter self-skip preceded by one stderr diagnostic naming the affected adapter leg and every missing prerequisite when its spawned external `gemini`, `opencode`, or `kimi` CLI is absent from `PATH` or its credential is absent from the environment, hard failure instead under `CI`, and no skip of another adapter's leg;
- no SDK-absence skip because a checkout capable of the suite has installed the loaded packages;
- per-adapter self-skip with a logged reason, including under `CI`, where the host cannot initialize that adapter's OS-level sandbox.

### engine-221

Given each built-in adapter's permission mapping, when `writablePaths` is exercised over accepted, invalid, absent, and empty inputs, the check shall assert every canonicalization and rejection row in [[engine-53](#engine-53)] plus the [[engine-23](#engine-23)] enforcement set and every output row in [[engine-54](#engine-54)].

### engine-226

Where an effort value is valid for a built-in adapter but unavailable to the selected model, account, or installed runtime, when the backend rejects the run, the check shall assert [[engine-51](#engine-51)]'s ordinary upstream error path without substitution.

### engine-229

Where `allowedTools` is an explicit empty list, when the built-in adapters run, the adapters shall enforce the closed empty set where supported [[engine-17](#engine-17)].

### engine-240

Given authentic zero, authentic nonzero, malformed, and absent accounting from every built-in adapter, when terminal usage is emitted, the check shall assert [[engine-31](#engine-31)]'s public shape, [[engine-55](#engine-55)] inclusive totals, [[engine-56](#engine-56)] numeric validity, [[engine-57](#engine-57)] detail reconciliation, [[engine-58](#engine-58)] coverage, [[engine-59](#engine-59)] records, and [[engine-65](#engine-65)] independent tool count.

### engine-32

Given an adapter retains [[engine-38](#engine-38)]'s cumulative-accounting queue, when concurrent equal-resume, different-resume, and fresh runs exit normally or through error, interruption, and setup failure after acquisition, the check shall assert every serialization, concurrency, and queue-release outcome.

### engine-85

When the adapter/engine integration matrix supplies proven rejection before execution, ordinary authentication/settings/transport failures, misleading error text, and failure after possible execution, it shall verify the rejection rules [[engine-84](#engine-84)]:

- the exact rejection code only in the proven case;
- one error terminal event without a token;
- no automatic retry;
- unchanged handling of ordinary failures.

### engine-87

When a discovery integration suite supplies provider initialization responses and real fixture child processes, it shall verify model discovery [[engine-86](#engine-86)]:

- exact IDs, aliases, defaults, mapped model effort levels and true/false/unknown fast support;
- native CLI command arguments and peer-runtime checks through the public entry point, plus complete paginated Codex results with only initialization and model-list requests;
- JavaScript child execution under Electron despite a missing or conflicting caller mode flag, with other environment values preserved;
- no prompt, durable session, tool, hook or credential disclosure;
- success, empty catalog, malformed response, unavailable interface, timeout and cancellation, with bounded cleanup even when a descendant retains inherited pipes.
