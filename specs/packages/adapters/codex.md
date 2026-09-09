<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# codex: Codex Adapter

## Intent

This package lets a consumer of the agent-adapter contract run Codex through the `@openai/codex-sdk`, per [DR-002](../../decisions/002-unified-event-stream-and-adapter-interface.md).
It owns how a portable request becomes a Codex thread, including native fast-tier selection, how a portable permission policy becomes a Codex permission profile, and how that thread's stream becomes unified events, thread continuity, and token accounting, together with the per-run configuration delivery, observation limits, and executable resolution those mappings require, not what a caller does with them and not the SDK's own behavior.
Its requirements are stated in this project's `AgentAdapter`, `AgentEvent`, `AgentOptions`, `PermissionPolicy`, `DonePayload`, and `Cligent` vocabulary, which the engine defines and without which this adapter's behavior cannot be stated.
Further project-specific references are essential to that intent and appear nowhere else: the distributable whose installed tree anchors executable resolution, the generated extra-writes profile this adapter names and delivers, and the programmatic working directory that motivates bypassing the interactive git-repository gate.

## External Behavior

### Adapter Identity

### codex-1

The adapter shall implement `AgentAdapter` with `agent: 'codex'`.

### SDK Loading

### codex-2

Where the Codex SDK is not installed, the adapter module shall remain importable so consumers can register it unconditionally.

### codex-8

Where the Codex SDK is missing under [[engine-26](../engine.md#engine-26)] runtime readiness, when `isAvailable()` is called, the adapter shall return `false`.

### codex-18

Where the Codex SDK is not installed and both tool-list fields are omitted, when `run()` is called, the adapter shall throw `CodexAdapter requires @openai/codex-sdk. Install it to use this adapter.`.

### Event Normalization

### codex-3

When the adapter normalizes a Codex stream, it shall dispatch native events according to this matrix:

| Native event | Unified outcome |
| --- | --- |
| first event observed, or a stream ending or failing before any event | one `init` selected by [[codex-22](#codex-22)] before any other emitted event |
| `item.started`, `item.updated`, or `item.completed` carrying `command_execution` or `mcp_tool_call` | the lifecycle selected by [[codex-19](#codex-19)] with identity from [[codex-54](#codex-54)] and payloads from [[codex-20](#codex-20)] |
| other `item.completed` | each non-empty text block and compatibility event selected below, in source order |
| `file_change`, `file.changed`, or `item.file_change` | `codex:file_change` carrying the first available `file`, `change`, `item`, or whole event |
| `error` | `error` carrying the payload selected by [[codex-28](#codex-28)] |
| `turn.completed` | `codex:usage` selected by [[codex-59](#codex-59)], then terminal `done` selected by [[codex-23](#codex-23)] |
| `turn.failed` | the terminal sequence selected by [[codex-24](#codex-24)] |
| absent or any other event type | no event beyond the first-event `init` |
| non-aborted stream exhaustion or failure | the terminal sequence selected by [[codex-25](#codex-25)] or [[codex-26](#codex-26)] |
| aborted stream exhaustion or failure | the terminal outcome selected by [[codex-27](#codex-27)] |

- An `item.completed` content array contributes non-empty `text`, `output_text`, and `message_text` blocks as `text` events in block order, together with the compatibility tool events in [[codex-21](#codex-21)] and `file_change` or `file.changed` blocks as `codex:file_change` carrying their `file` value when present and otherwise the whole block.
- A non-empty top-level item `text` contributes one `text` before those content events only where the content contains no non-empty text block, and otherwise is suppressed so mirrored text is not duplicated.
- A top-level `tool_result`, `function_call_result`, or `tool_output` item contributes one compatibility `tool_result` selected by [[codex-21](#codex-21)] after every selected top-level text and content-array event, whether or not content blocks are present.
- With no content blocks, non-empty top-level item text and top-level compatibility tool-use or file shapes produce the corresponding event, a top-level `file_change` or `file.changed` item carrying its `file` value when present and otherwise the whole item, while empty text and every unrecognized shape produce none.

### codex-19

When the adapter normalizes a canonical `command_execution` or `mcp_tool_call` item lifecycle using [[codex-54](#codex-54)]'s common identity, it shall emit events according to this per-item state matrix:

| First or later observation | Outcome |
| --- | --- |
| first `item.started` or `item.updated` carrying a non-empty item `id` | one `tool_use` |
| later `item.started` or `item.updated` for an announced `id` | no event |
| `item.completed` for an announced, not-yet-completed `id` | one terminal `tool_result` |
| `item.completed` for an unannounced `id` | synthesize the missing `tool_use` immediately before one terminal `tool_result` |
| repeated `item.completed` for a completed `id` | no event |
| `item.started` or `item.updated` without a non-empty `id` | no event |
| `item.completed` without a non-empty `id` | one `tool_use` and one `tool_result` correlated by [[codex-54](#codex-54)]'s generated identifier |

### codex-54

When the adapter selects correlation for a canonical `command_execution` or `mcp_tool_call` item lifecycle, it shall choose the common `toolUseId` according to this matrix:

| Item identity | Common `toolUseId` |
| --- | --- |
| non-empty native item `id` | that value unchanged for every emitted `tool_use` and `tool_result` |
| `item.completed` without a non-empty native item `id` | one identifier generated through [[engine-7](../engine.md#engine-7)] and shared by the synthesized `tool_use` and `tool_result` |

### codex-20

When the adapter normalizes a canonical tool lifecycle event, it shall select its payload according to this matrix:

| Item and event | Payload |
| --- | --- |
| command `tool_use` | `toolName: 'command_execution'`, the `toolUseId` selected by [[codex-54](#codex-54)], and input `{ command }`, using an empty command where the native value is not a non-empty string |
| MCP `tool_use` | the `toolUseId` selected by [[codex-54](#codex-54)], `toolName: '<server>.<tool>'` when both names are non-empty and otherwise the non-empty tool or `mcp_tool_call`, and absent arguments as `{}`, non-array objects preserved, JSON strings parsed only when they name such objects, and every other value preserved under `raw` |
| command `tool_result` | the same tool name and identifier, `status: 'error'` for case-insensitive native `failed` and otherwise `success`, and output containing the native `aggregated_output` or an empty string plus a finite native `exit_code` when present |
| MCP `tool_result` | the same tool name and identifier, the same status mapping, and output preferring native `error` then `result` for failure or `result` then `error` otherwise, with `null` as the final fallback |

### codex-21

Where a non-canonical `item.completed` shape carries a compatibility tool alias at top level or in content, the adapter shall normalize it according to this matrix:

| Source | Accepted aliases or selection |
| --- | --- |
| tool-use type | `tool_call`, `function_call`, or `tool_use` |
| tool-result type | `tool_result`, `function_call_result`, or `tool_output` |
| `toolName` | first non-empty `toolName`, then `name`, otherwise `unknown_tool` |
| `toolUseId` | first non-empty `toolUseId`, `callId`, `tool_call_id`, or `id`, otherwise an identifier generated through [[engine-7](../engine.md#engine-7)] |
| tool input | first non-nullish `input`, `arguments`, or `args`; a non-array object is preserved, a JSON string is parsed only when it names such an object, an absent value becomes `{}`, and every other value is preserved under `raw` |
| result status | case-insensitive `denied` becomes `denied` and takes priority over either error flag; case-insensitive `failed` or `error`, `isError: true`, or `is_error: true` becomes `error`; every other value becomes `success` |
| result output | first non-nullish `output`, `result`, or `content`, otherwise `null` |
| result duration | first finite `durationMs`, then `duration_ms`, otherwise omitted |

### codex-22

When a run emits its exactly one `init`, the adapter shall select its payload according to this matrix:

| Payload member | First available value |
| --- | --- |
| `model` | requested model when supplied, including an empty string, then non-empty first-event model, otherwise `unknown` |
| `cwd` | requested cwd when supplied, including an empty string, then non-empty first-event cwd, otherwise the process cwd |
| `tools` | first non-empty string list from first-event `tools`, `session.tools`, or `turn.tools`, otherwise `[]`; object entries contribute their non-empty `name` |
| `capabilities.toolsKnown` | `true` when a non-empty native tool list was selected, otherwise `false` |
| `capabilities.toolsSource` | `sdk` when native tools were selected, otherwise `unavailable` |

### codex-23

When Codex emits `turn.completed`, the adapter shall emit [[codex-59](#codex-59)]'s diagnostic followed by one terminal `done`, stop consuming the stream, and select the terminal payload according to this matrix:

| Payload member | Selection |
| --- | --- |
| `status` source | first non-empty `turn.status`, then event `status`, compared case-insensitively |
| `status: 'success'` | source absent, `success`, `completed`, `ok`, or any unrecognized value |
| `status: 'interrupted'` | `interrupted`, `cancelled`, or `aborted` |
| `status: 'max_turns'` | `max_turns` or `maxturns` |
| `status: 'max_budget'` | `max_budget`, `maxbudget`, or `budget_exceeded` |
| `status: 'error'` | `error` or `failed` |
| `result` | first non-empty `turn.result`, then event `result`, otherwise omitted |
| `durationMs` | first finite `turn.durationMs`, `turn.duration_ms`, event `durationMs`, or event `duration_ms`, otherwise elapsed run time |
| `resumeToken` with `status: 'interrupted'` | the interrupted-terminal selection in [[codex-33](#codex-33)] |
| `resumeToken` with any other status | the normal-terminal selection in [[codex-6](#codex-6)] |
| `usage` | first non-nullish `turn.usage`, then event `usage`, mapped through [[codex-53](#codex-53)], [[codex-15](#codex-15)], [[codex-16](#codex-16)], [[codex-17](#codex-17)], and [[codex-29](#codex-29)] |

### codex-24

When Codex emits `turn.failed`, the adapter shall yield an `error` selected by [[codex-28](#codex-28)], then [[codex-59](#codex-59)]'s diagnostic, then terminal `done` with `status: 'error'`, the normal-terminal resume token in [[codex-6](#codex-6)], event usage mapped through [[codex-53](#codex-53)], [[codex-15](#codex-15)], [[codex-16](#codex-16)], [[codex-17](#codex-17)], and [[codex-29](#codex-29)], elapsed duration, and no result, stopping consumption before the SDK can replace that failure with a generic non-zero-exit error.

### codex-25

While the run is not aborted and has emitted no terminal event, when the SDK stream exhausts, the adapter shall emit `init` first if needed, then a non-recoverable `error` with code `MISSING_TURN_DONE` and message `Protocol violation: Codex stream ended without turn.completed`, followed by terminal `done` with `status: 'error'`, the normal-terminal resume token in [[codex-6](#codex-6)], elapsed duration, usage containing only [[codex-29](#codex-29)]'s tool count, and no result.

### codex-26

While the run is not aborted and has emitted no terminal event, when iteration of the SDK stream throws, the adapter shall emit `init` first if needed, then a non-recoverable `error` with code `SDK_STREAM_ERROR` and the bounded JSON/error-envelope decoding used by [[codex-28](#codex-28)] on a thrown `Error` message or `Codex adapter failed during stream` for a non-`Error`, followed by terminal `done` with `status: 'error'`, the normal-terminal resume token in [[codex-6](#codex-6)], elapsed duration, usage containing only [[codex-29](#codex-29)]'s tool count, and no result.

### codex-27

While the mapped SDK signal is aborted and no terminal event has been emitted, when the SDK stream exhausts or throws, the adapter shall emit `init` first if needed and then only terminal `done` with [[engine-73](../engine.md#engine-73)] status `'interrupted'`, the resume token selected by [[codex-33](#codex-33)], elapsed duration, usage containing only [[codex-29](#codex-29)]'s tool count, and no result.

### codex-28

When the adapter normalizes a native error, it shall select the unified payload according to this matrix:

| Payload member | First available value |
| --- | --- |
| `code` | non-empty `code` or `error_code` from the top-level event, nested `error`, or object-valued `message`, then non-empty nested `type`, otherwise omitted; replace upstream `SESSION_RESUME_REJECTED` with `SDK_STREAM_ERROR` because provider codes do not establish pre-execution rejection [[engine-84](../engine.md#engine-84)] |
| `message` | non-empty top-level `message`, `detail`, or `error`, walking nested objects in `detail`, `message`, `error_description`, then `error` order and decoding JSON-object strings until the third nesting level, otherwise `Codex SDK error` |
| `recoverable` | `true` when top-level, nested-error, or object-valued-message `recoverable` or `retryable` is `true`, otherwise `false` |

### codex-29

When a run emits any terminal `done`, the adapter shall report `DonePayload.usage.toolUses` as the number of distinct `toolUseId` values observed through canonical or compatibility `tool_use` and `tool_result` events, ignoring provider-reported tool counts and preserving the observed count when token accounting is absent.

### Permission Mapping

### codex-4

When the adapter maps the closed `PermissionPolicy.mode` set in [[engine-21](../engine.md#engine-21)] and its capability levels to Codex's modern permission controls under [[engine-52](../engine.md#engine-52)] per [DR-005](../../decisions/005-per-adapter-permission-configuration.md), it shall select both axes from these matrices and omit `ThreadOptions.sandboxMode` and `ThreadOptions.networkAccessEnabled` in every row [[3]][[4]]:

| Policy input | `ThreadOptions.approvalPolicy` | `CodexOptions.config.approvals_reviewer` |
| --- | --- | --- |
| policy absent | omitted | omitted |
| `mode: 'auto'`, with any capability levels | `on-request` | `auto_review` [[2]] |
| `mode: 'bypass'`, with any capability levels | `never` | omitted |
| supplied policy with mode omitted and every capability `allow` | `never` | omitted |
| supplied policy with mode omitted and any capability `ask` | `untrusted` | omitted |
| every other supplied policy with mode omitted, including an empty policy | `on-request` | omitted |

| Policy input | `CodexOptions.config.default_permissions` |
| --- | --- |
| policy absent | omitted |
| `mode: 'bypass'`, with any capability levels | `:danger-full-access` |
| `mode: 'auto'` or omitted and every capability `allow` | `:danger-full-access` |
| `mode: 'auto'` or omitted and `fileWrite` or `shellExecute` is `deny` | `:read-only` |
| every other supplied policy, including an empty policy, network-only deny, or a network allow without both local capabilities allowed | `:workspace` |

### codex-31

When a run has no permission policy or a supplied policy whose mapping succeeds, the adapter shall select its per-run Codex configuration source from this isolation matrix:

| Permission-policy input | Configuration source |
| --- | --- |
| policy absent | emit no `--ignore-user-config`, inherit Codex's native configuration, and preserve normal `CODEX_HOME` authentication and session state |
| any supplied policy, including empty | include `--ignore-user-config` in the selected Codex `exec` arguments while preserving normal `CODEX_HOME` authentication and session state, so user-level legacy `sandbox_mode` or stale `default_permissions` cannot replace the selected profile |

### codex-32

When the adapter maps `PermissionPolicy.writablePaths` per [[engine-53](../engine.md#engine-53)] and [[engine-54](../engine.md#engine-54)], it shall produce this matrix without changing the approval axis selected by [[codex-4](#codex-4)]:

| Input and resolved profile | Outcome |
| --- | --- |
| paths absent or empty | omit `WritablePathsPermissionMapping` and any generated profile |
| any invalid path | reject the policy before starting a thread |
| valid non-empty paths with `:workspace` | expose canonical paths with `enforcement: 'profile'` and select a generated `cligent-workspace-extra-writes` profile extending `:workspace` with one `write` grant per path under `:workspace_roots` |
| valid non-empty paths with `:read-only` | reject the policy before starting a thread |
| valid non-empty paths with `:danger-full-access` | expose canonical paths with `enforcement: 'ambient'`, generate no extra-writes profile, and leave the broader posture unchanged |

### Thread Resumption

### codex-5

When the adapter selects a Codex thread, it shall produce this matrix:

| `AgentOptions.resume` and SDK surface | Outcome |
| --- | --- |
| non-empty and `resumeThread()` available | continue the named thread |
| non-empty and `resumeThread()` unavailable | throw `Codex SDK does not support resumeThread() in this version` |
| absent or empty | start a fresh thread whose pre-backend events carry the non-empty identifier selected by [[codex-34](#codex-34)] |

### codex-6

When a non-interrupted terminal `done` is emitted, the adapter shall set `DonePayload.resumeToken` to the latest backend thread identifier observed during the run and otherwise omit it, rather than echoing an inbound resume value, enabling [[engine-5](../engine.md#engine-5)] storage and [[engine-33](../engine.md#engine-33)] selection across steps per [DR-003](../../decisions/003-role-scoped-session-management.md).

### codex-33

When terminal `done` has `status: 'interrupted'`, whether selected from a native status or caused by abort, the adapter shall select `DonePayload.resumeToken` from this ordered matrix:

| Identifier state before terminal | `resumeToken` |
| --- | --- |
| a backend thread identifier | the latest observed backend identifier |
| no backend identifier and a non-empty inbound `resume` | the inbound value |
| no backend identifier and no non-empty inbound `resume` | omitted |

### Options Mapping

### codex-7

When the adapter maps the Codex-specific `AgentOptions.effort` vocabulary from [[engine-40](../engine.md#engine-40)] per [DR-009](../../decisions/009-adapter-scoped-effort-vocabularies.md), it shall produce this matrix per [[1]], [[3]], and [[5]]:

| `AgentOptions.effort` | SDK `ThreadOptions.modelReasoningEffort` | Codex constructor `config.model_reasoning_effort` | Outcome |
| --- | --- | --- | --- |
| omitted | omitted | omitted | preserve independently selected configuration, including [[codex-31](#codex-31)] |
| `minimal` | `minimal` | omitted | accepted |
| `low` | `low` | omitted | accepted |
| `medium` | `medium` | omitted | accepted |
| `high` | `high` | omitted | accepted |
| `xhigh` | `xhigh` | omitted | accepted |
| `max` | omitted | `max` | accepted through constructor pass-through |
| `ultra` | omitted | `ultra` | accepted through constructor pass-through |
| `ultracode` or any other unsupported value | not invoked | not invoked | reject before starting a thread with an error naming Codex and its allowed values |

### codex-35

Where `AgentOptions.effort` is `ultra`, when the adapter maps the same permission input with and without that effort, it shall leave every permission profile, approval, reviewer, legacy-control omission, writable-path mapping, and configuration-isolation control unchanged.

### Fast Mode

### codex-55

When the adapter maps `AgentOptions.fastMode` under [[engine-75](../engine.md#engine-75)], it shall produce this Codex constructor-configuration matrix per [[9]], [[10]], [[11]], and [[12]] while preserving [[codex-4](#codex-4)] permission configuration, [[codex-7](#codex-7)] effort configuration, and [[codex-31](#codex-31)] configuration isolation in the same `CodexOptions.config` object:

| `AgentOptions.fastMode` | `config.service_tier` | `config.features.fast_mode` |
| --- | --- | --- |
| omitted | omitted | omitted |
| `true` | `'fast'` | `true` |
| `false` | `'default'` | `true` |

Every row retains independent `default_permissions`, `approvals_reviewer`, and `model_reasoning_effort` values, with `false` selecting Codex's native default tier rather than disabling the fast-mode feature mechanism.

### codex-56

While the public Codex SDK event stream exposes no effective service-tier result per [[12]], when the adapter emits unified init or done events, it shall omit [[engine-78](../engine.md#engine-78)]'s fast-mode observation even where the caller requested `fastMode`, never promoting constructor configuration to observed state.

### codex-11

When the adapter maps `AgentOptions.allowedTools` and `AgentOptions.disallowedTools`, it shall produce this matrix:

| Tool-list input | Outcome |
| --- | --- |
| either field present, including an empty array | reject before loading or invoking the Codex SDK with an error explaining that this integration cannot enforce explicit tool restrictions |
| both fields omitted | preserve Codex's native available-tool set |

### Token Accounting

### codex-15

Under [[engine-37](../engine.md#engine-37)]'s permitted per-session baseline and [[engine-38](../engine.md#engine-38)]'s same-resume serialization contract, when the adapter accounts for a run using cumulative native terminal usage classified by [[codex-53](#codex-53)], it shall produce this provenance matrix:

| State | Outcome |
| --- | --- |
| fresh thread with a valid snapshot and no baseline | treat the absent baseline as zero, report the current snapshot, and retain it as the new baseline when a backend thread identifier is known |
| resumed thread with a valid snapshot and no retained baseline | omit tokens and retain the current snapshot as the new baseline |
| valid snapshot with the same optional-counter presence shape and no decreased counter | report the exact difference from the preceding snapshot and retain the current snapshot |
| any decreased counter | omit tokens and retain the current snapshot so the next stable turn can recover |
| usage value yielding no valid snapshot | omit tokens and discard any old baseline keyed by the latest backend thread identifier or, before one is observed on a resumed run, the non-empty inbound resume value |
| first valid resumed snapshot after a discarded baseline | omit tokens and establish the new baseline |
| optional cache or reasoning counter presence changes | omit tokens and retain the new shape |
| next valid same-shape, non-decreasing snapshot after a retained decrease or shape-transition baseline, or after the re-established post-malformed baseline | recover exact differencing |

### codex-62

While a run has observed no native terminal usage, when it closes, the adapter shall maintain the retained token baseline according to this execution-boundary matrix under [[engine-37](../engine.md#engine-37)] and [[engine-38](../engine.md#engine-38)]:

| Execution state | Outcome |
| --- | --- |
| `runStreamed()` was invoked, including setup failure, abort, exhaustion, thrown stream failure, or consumer closure | discard the baseline keyed by the latest backend thread identifier or, before one is observed on a resumed run, the non-empty inbound resume value, before releasing the session's serialization queue, because unobserved work may have advanced the native counters |
| failure before `runStreamed()` was invoked | preserve the prior baseline because no execution request was made |

### codex-16

When the adapter maps a valid per-turn delta from [[codex-15](#codex-15)] into exact token details, it shall produce this subset matrix under [[engine-57](../engine.md#engine-57)]:

| Reported counters | Output |
| --- | --- |
| both cache subsets present | inclusive input total plus `cacheRead`, `cacheWrite`, and exact non-negative `uncached` subtraction |
| either cache subset absent | preserve the inclusive input total and each present cache detail, but omit `uncached` |
| reasoning subset present | inclusive output total plus `reasoning` and exact non-negative `visible` subtraction |
| reasoning subset absent | preserve the inclusive output total but omit `reasoning` and `visible` |
| any mapped counter malformed, any subset greater than its inclusive total, or combined cache subsets greater than inclusive input | omit tokens rather than clamp or estimate |

### codex-17

When the adapter publishes current Codex token accounting, it shall produce this authentic report matrix under [[engine-58](../engine.md#engine-58)] and [[engine-59](../engine.md#engine-59)]:

| Source state | Report outcome |
| --- | --- |
| exact valid per-turn delta from [[codex-15](#codex-15)] | `coverage: 'partial'`, because the pinned exec surface does not aggregate descendant Codex threads, with inclusive totals and the exact details selected by [[codex-16](#codex-16)] |
| first runtime-reported model selected by [[codex-36](#codex-36)] | one record carrying that report's totals and details |
| no runtime-reported model | omit `records` |
| requested model only | never use it as a record label, because it is not evidence of the effective model or a reroute |
| any input, provenance, or validity failure named by [[codex-53](#codex-53)], [[codex-15](#codex-15)], or [[codex-16](#codex-16)] | omit `tokens` rather than publish a cumulative total, placeholder, or estimate |
| any run | publish no cost because Codex exec reports none |

### codex-59

When the adapter consumes `turn.completed` or `turn.failed`, it shall emit one `codex:usage` diagnostic before terminal `done`, describing that terminal's accounting decision under [[codex-15](#codex-15)], [[codex-16](#codex-16)], and [[codex-53](#codex-53)] through this payload matrix:

| Field | Outcome |
| --- | --- |
| `status` | `reported` when tokens are published; otherwise `omitted` |
| `reason` | `reported`, `missing-usage`, `invalid-usage`, `missing-baseline`, `counter-shape-changed`, `counter-decreased`, or `invalid-token-subsets`, naming the decision reached by the accounting rules |
| `resumed` | whether the run selected an inbound resume token |
| `threadId` | latest known backend identifier, otherwise the inbound resume identifier, otherwise omitted |
| `snapshot`, `baseline`, `delta` | independent copies of the numerically valid current cumulative counters, preceding retained counters, and arithmetic difference, respectively, when each is available |
| counter fields | required `inputTokens` and `outputTokens`, plus only the present `cachedInputTokens`, `cacheWriteInputTokens`, and `reasoningOutputTokens`; exclude raw provider objects and invalid counter values |
| numeric difference failing subset validation | retain it as diagnostic evidence; only `status: 'reported'` confirms a valid token report |

## Internal Behavior

### Session Identity

### codex-34

When the adapter selects the event `sessionId` and records whether a backend identifier is known, it shall use this matrix:

| Source state | Selection |
| --- | --- |
| fresh run before a backend identifier | one identifier generated through [[engine-7](../engine.md#engine-7)] |
| resumed run before a backend identifier | the non-empty inbound `resume` value |
| native event supplies identifiers | first non-empty `sessionId`, `session_id`, `threadId`, `thread_id`, `session.id`, or `thread.id` |
| native event supplies only absent, empty, or non-string identifier aliases | retain the current identifier and whether a backend identifier was already known |
| later native event supplies another identifier | replace the prior value and retain the latest as backend-provided |

### Runtime Model Identity

### codex-36

When the adapter selects the effective model for a usage record, it shall retain the first non-empty `model` reported by this run's native event stream and never substitute the requested model.

### Usage Snapshot Validity

### codex-53

When the adapter reads a cumulative Codex usage value, it shall admit and normalize it according to this counter matrix [[6]][[7]]:

| Input state | Snapshot outcome |
| --- | --- |
| non-array object | inspect its counter aliases |
| absent, `null`, array, or primitive | no valid snapshot |
| `inputTokens` / `input_tokens` and `outputTokens` / `output_tokens` | each counter is required |
| `cachedInputTokens` / `cached_input_tokens`, `cacheWriteInputTokens` / `cache_write_input_tokens`, and `reasoningOutputTokens` / `reasoning_output_tokens` | each counter is optional |
| one alias present | use its value |
| both aliases present with equal values | use their common value |
| both aliases present with different values | no valid snapshot |
| present finite, non-negative safe integer, including zero | valid counter |
| present non-numeric, non-finite, negative, fractional, or unsafe value | no valid snapshot |
| optional counter absent | retain zero internally while recording that its presence shape is absent |
| required counter absent or any counter invalid | no valid snapshot |

### Working Directory

### codex-9

When the adapter maps a run to Codex thread options, it shall produce this matrix so the CLI's interactive-user git-repository gate does not refuse a programmatic invocation:

| Caller `cwd` | `workingDirectory` | `skipGitRepoCheck` |
| --- | --- | --- |
| absent | `undefined` | `true` |
| empty string | empty string | `true` |
| non-empty string | the supplied string | `true` |

The programmatic tmux-play runtime accepts and forwards an optional caller-selected cwd [[tmux-play-29](../tmux-play.md#tmux-play-29)], while library consumers select `AgentOptions.cwd` directly.

### Workspace Writable Paths

### codex-10

Where [[codex-32](#codex-32)] selects profile enforcement for non-empty `writablePaths`, when the adapter starts a run, it shall make the generated permission-profile definition available through Codex's normal configuration loading without writing repository `.codex/config.toml`, writing user-level Codex configuration, or replacing the user's Codex home, authentication, or session configuration.

### codex-37

When a supplied permission policy can activate Codex project trust, the adapter shall inject a per-run trusted-project override only for a non-empty caller `cwd` whose local-access profile is not `:read-only`, and omit it for an absent or empty cwd, an absent policy, or `:read-only`.

### codex-38

When the adapter resolves the project key for [[codex-37](#codex-37)]'s trust override, it shall produce this matrix:

| Workspace state | Project key |
| --- | --- |
| ordinary repository with a `.git` directory at or above cwd | that repository root |
| linked worktree whose `.git` file names a valid `.../worktrees/<name>` directory | the main repository root |
| malformed, unreadable, or non-worktree `.git` file | the lexical absolute caller workspace |
| no repository marker | the lexical absolute caller workspace |
| Windows device-prefixed path | the same selection after Codex-compatible device-prefix simplification |
| non-Windows symlink alias | preserve the lexical absolute alias rather than independently realpath-canonicalizing it |

### codex-39

When the adapter serializes [[codex-37](#codex-37)]'s trust override, it shall encode the complete top-level `projects={<path>={trust_level="trusted"}}` inline table rather than a dotted key with a quoted path segment, without creating a project or user configuration file.

### Codex Executable Resolution

### codex-12

When a run requires the Codex CLI entry `@openai/codex/bin/codex.js` for [[codex-10](#codex-10)] and [[codex-31](#codex-31)], the adapter shall resolve it through this ordered anchor matrix, because `@openai/codex` belongs to the optional `@openai/codex-sdk` peer's tree rather than Cligent's [[package-4](../package.md#package-4)]:

| Resolution state | Outcome |
| --- | --- |
| ESM loader can resolve the SDK to a file URL | search the canonical physical SDK tree for its Codex entry first [[8]] |
| loader unavailable, throws, returns a non-file URL, or its SDK tree has no entry | continue through SDK manifests on the adapter's module search paths |
| a search-path SDK manifest is found | search that canonical physical SDK tree, including on the [[package-2](../package.md#package-2)] runtime floor |
| no SDK-anchored route succeeds | fall back to the adapter's own module-resolution context |
| SDK is reached through a symbolic link | canonicalize the anchor to the SDK's physical location |
| caller injects a module-resolution scope without an explicit loader resolver | suppress ambient loader lookup and use only the injected scope's search paths and fallback |
| SDK-owned and independently installed Codex copies are both visible | return the SDK-owned entry matching the SDK's pinned dependency |
| Codex is nested only inside the SDK | return that SDK-owned entry |
| an earlier route yields no entry | continue rather than fail until all ordered routes are exhausted |

### codex-13

When every route in [[codex-12](#codex-12)] fails, the adapter shall raise an error with this shape:

| Error member | Required content |
| --- | --- |
| message | the attempted `@openai/codex/bin/codex.js` specifier, every attempted resolution anchor, the fact that `@openai/codex-sdk` provides the entry, and the instruction to install that SDK where Cligent can resolve it |
| `code` | `MODULE_NOT_FOUND` |

### codex-40

Where executable resolution or wrapper setup fails while starting a run, the adapter shall release that run's abort registration before propagating the error so repeated failures on one long-lived caller signal accumulate no listeners.

## Verification

### codex-201

Given canned native Codex events typed against the SDK's canonical exported event and item shapes, together with deliberately degraded-member variants, when the adapter runs, it shall satisfy this canonical lifecycle matrix [[codex-3](#codex-3)], [[codex-19](#codex-19)], [[codex-20](#codex-20)], [[codex-54](#codex-54)]:

| Case | Assertion |
| --- | --- |
| full interleaved command and MCP turn | ordered `init`, two correlated `tool_use`, two correlated `tool_result`, `text`, `codex:file_change`, [[codex-59](#codex-59)]'s `codex:usage`, and terminal `done`, with each pair's `toolUseId` equal to its native item `id`, native payloads, and one common backend session identifier |
| repeated updates | one `tool_use`, no event for later updates, and one terminal `tool_result` |
| first observation at `item.updated` | announce the call there and correlate its later result |
| completion without an earlier observation | synthesize the correlated `tool_use` immediately before the result |
| repeated completion | emit only one terminal result |
| interleaved distinct IDs | preserve each correlation despite reverse completion order |
| failed command and MCP completion | preserve command output and exit code or MCP error details with `status: 'error'` |
| missing canonical item ID or payload member | apply [[codex-19](#codex-19)]'s lifecycle, [[codex-54](#codex-54)]'s generated-ID, and [[codex-20](#codex-20)]'s payload fallback rows |

### codex-41

Given the SDK stream supplies events, no events, or throws before its first event, when the adapter runs, it shall emit exactly one `init` before every other output with the model, cwd, tool, and capability selections in [[codex-22](#codex-22)].

### codex-42

Given each status, source position, result, duration, usage, and normal-or-interrupted resume case in [[codex-23](#codex-23)], when Codex emits `turn.completed`, the adapter shall emit exactly one selected `done` under [[codex-6](#codex-6)] or [[codex-33](#codex-33)] and stop consuming.

### codex-43

Given Codex emits `turn.failed` with trailing native events, when the adapter runs, it shall expose the selected native failure as `error`, then [[codex-59](#codex-59)]'s diagnostic, then one error-status `done` with its usage, duration, and resume selection, and consume none of the trailing events [[codex-24](#codex-24)].

### codex-44

Given every top-level and content-block compatibility text or tool type, field alias, priority, default, input shape, status, output, and duration case in [[codex-3](#codex-3)] and [[codex-21](#codex-21)], when the adapter runs, it shall preserve content order, suppress mirrored text, and emit the selected legacy `text`, `tool_use`, and `tool_result` events.

### codex-45

Given non-aborted exhaustion, non-aborted iterator failure, and aborted exhaustion or iterator failure after zero or more tool events, when the adapter runs, it shall emit the exact `init`, error, `done`, ordering, omission, duration, resume, and tool-count outcome in [[codex-25](#codex-25)], [[codex-26](#codex-26)], and [[codex-27](#codex-27)], including [[codex-6](#codex-6)]'s normal-terminal and [[codex-33](#codex-33)]'s interrupted-terminal resume selection.

### codex-46

Given duplicate and distinct canonical identifiers on normal completion, compatibility use-only and result-only identifiers plus a provider count, and representative failed, exhausted, iterator-failure, and aborted terminal paths, when the adapter runs, `DonePayload.usage.toolUses` shall equal the distinct observed identifier count, ignore the provider count, and survive absent token accounting [[codex-29](#codex-29)].

### codex-47

Where the packed package is installed without the Codex SDK peer, when a consumer imports the Codex adapter subpath, the import shall succeed [[codex-2](#codex-2)].

### codex-202

Where the Codex SDK is not installed, `isAvailable()` shall return `false` [[codex-8](#codex-8)].

### codex-48

Where the Codex SDK is not installed and both tool-list fields are omitted, when `run()` starts, it shall throw the install diagnostic in [[codex-18](#codex-18)].

### codex-203

Where an application configuration selects representative thread and constructor effort values for Codex, when the runtime constructs and invokes the corresponding `Cligent`, each value shall reach its own native transport [[codex-7](#codex-7)].

### codex-204

Given a missing policy and the complete supplied-policy mode and capability matrix, when the adapter maps permissions, it shall produce every approval, reviewer, modern local-profile, user-config-isolation, and legacy-control-omission outcome in [[codex-4](#codex-4)] and [[codex-31](#codex-31)].

### codex-205

Where the packed tarball and exact Codex SDK target are installed in turn into a global-style prefix and a nested-strategy consumer, with neither layout leaving `@openai/codex` at its install root, when the installed adapter resolves the executable, creates a permission-managed wrapper, and runs until a scheduled abort, it shall return the SDK-owned executable in both layouts, embed that path in the wrapper, terminate the invocation without a module-resolution failure, and exercise the nested-strategy case on the Node 18.3.0 floor without an ESM loader resolution surface [[codex-10](#codex-10)], [[codex-12](#codex-12)], [[codex-31](#codex-31)].

### codex-51

Where an installed consumer resolves `@openai/codex` from no route, when the adapter resolves the executable, it shall raise [[codex-13](#codex-13)]'s ownership diagnostic.

### codex-52

Given loader, search-path, nested, hoisted, independently installed, scoped, fallback, non-file, throwing, missing-entry, and symbolic-link resolution states, when the adapter resolves the Codex executable, it shall select or continue through every ordered route in [[codex-12](#codex-12)] and return the SDK-owned physical entry whenever that tree supplies one.

### codex-206

Given each top-level and item-contained native file-change alias, when the adapter runs, it shall emit `codex:file_change` with the selected native payload [[codex-3](#codex-3)].

### codex-211

Given normal completion with each backend-identifier alias and priority, later replacement, or no backend identifier, when the adapter emits events and terminal `done`, it shall use [[codex-34](#codex-34)]'s session identity and expose the latest backend identifier as `resumeToken` or omit it as required by [[codex-6](#codex-6)].

### codex-215

Given each thread-selection row in [[codex-5](#codex-5)], when the adapter starts a run, it shall resume the named thread, create a fresh thread whose pre-backend events use [[codex-34](#codex-34)]'s selected identifier, or raise the missing-surface diagnostic selected by that row.

### codex-217

Given every top-level, nested, object-valued, JSON-encoded, absent, and priority case for native error code, message, and recoverability, when the adapter normalizes an error, it shall expose exactly [[codex-28](#codex-28)]'s payload rather than a raw JSON string.

### codex-218

Given every Codex effort value, omission, foreign value, and unknown value, when the adapter maps a run, it shall produce [[codex-7](#codex-7)]'s exact transport or pre-backend rejection with `ultra` leaving every permission control unchanged per [[codex-35](#codex-35)].

### codex-57

Where `fastMode` omitted, `true`, and `false` are crossed with native and isolated configuration, supplied permissions, and ordinary, `max`, and `ultra` effort, when the adapter reaches the Codex SDK boundary, the check shall assert [[codex-55](#codex-55)]'s exact tier and feature values in one merged configuration object without losing any independent permission, effort, or isolation field.

### codex-58

Where Codex init, completion, failure, and stream-exhaustion outcomes follow omitted and explicit fast-mode requests, when the adapter emits unified events, the check shall assert [[codex-56](#codex-56)]'s absence of fast-mode observation and requested-value echoes.

### codex-219

Where a `Cligent` is constructed on the adapter with `CligentOptions.permissions = { mode: 'auto' }`, when `run()` is invoked first to create and then to update a temporary file in a throwaway working directory, the adapter's auto-mode Codex knobs per [DR-005](../../decisions/005-per-adapter-permission-configuration.md) shall let both non-destructive writes proceed without interactive approval [[codex-4](#codex-4)]:

- the file shall exist with the expected contents after each phase;
- neither stream shall contain `permission_request`, a denied tool result, or an error;
- each stream shall terminate with successful `done`;
- filesystem state shall be the ground-truth assertion, because adapters normalize file edits differently;
- the harness shall retry the complete fresh probe after, and only after, an explicit upstream-overload, rate-limit, or service-unavailable failure, shall make at most two retries, and shall treat any other failure and the third consecutive named transient failure as fatal;
- the leg shall run against the real SDK, which any checkout able to run this suite has installed as a `devDependency`, so SDK absence shall not be a skip condition; the leg shall self-skip when the adapter's credential is absent from the environment, shall hard-fail instead under `CI`, and a missing dependency for one adapter shall never skip another's leg;
- because `mode: 'auto'` resolves to the `:workspace` profile, which runs commands inside a sandbox some hosts cannot initialize, only this real-run leg shall self-skip with a logged reason for that detected limitation, including under `CI`, the mapping itself remaining covered by [[codex-204](#codex-204)].

### codex-220

Given each backend-identifier alias and priority, later replacement, inbound-resume state, or absent identifier in [[codex-34](#codex-34)] and [[codex-33](#codex-33)], when an aborted run emits events and interrupted `done`, the adapter shall expose those rows' exact session and resume-token outcomes.

### codex-221

Given absent, empty, invalid, profile-enforced, read-only, and ambient `writablePaths` inputs, when the adapter maps permissions, it shall produce every outcome in [[codex-32](#codex-32)].

### codex-223

Given the Codex CLI can initialize its native sandbox, when a credential-free sandbox probe, every trust mapping row, and a real `CligentOptions.permissions = { mode: 'auto', writablePaths: ['.git'] }` run in a throwaway git repository are exercised, the adapter shall satisfy this delivery matrix [[codex-10](#codex-10)], [[codex-32](#codex-32)], [[codex-37](#codex-37)], [[codex-38](#codex-38)], [[codex-39](#codex-39)]:

- the built-in `:workspace` profile cannot write inside `.git`, while the generated profile grants `write` there;
- each project-root and trust-injection input selects the exact inline-table override or omission required by the cited behaviors;
- the real run completes a git metadata write without `permission_request`, denied tool results, or error events and without creating or modifying repository or user-level Codex configuration;
- the leg uses [[codex-219](#codex-219)]'s sandbox-initialization skip and `CI` dependency and credential conditions.

### codex-224

Given [[codex-219](#codex-219)]'s credential, sandbox, and `CI` preconditions and a throwaway `CODEX_HOME` whose `config.toml` grants broader user-level access, when a no-policy run and then a `mode: 'auto'` run each attempts to write outside its working directory, the probe shall prove [[codex-31](#codex-31)]'s isolation matrix from the pinned native root threads' persisted permission contexts:

- the no-policy context selects `danger-full-access` and approval policy `never`, and its write succeeds without permission or error events;
- the managed context selects `workspace-write`, approval policy `on-request`, and reviewer `auto_review`, rather than the broader user configuration;
- only each root thread's own context supplies evidence, excluding reviewer or other threads;
- both runs end successfully, the caller's `CODEX_HOME` is restored, and isolated native storage is cleaned after bounded shutdown retries; and
- an auto-reviewed outside write may succeed, so file existence alone is not evidence of user-config leakage [[2]].

### codex-229

Given either tool-list field is present or both are omitted, when the adapter runs, it shall produce the pre-load rejection or native-tool preservation selected by [[codex-11](#codex-11)].

### codex-240

Given authentic zero, nonzero, absent, malformed, and resumed accounting, when a caller reads terminal `usage`, the adapter shall assert this current-report matrix:

- exact valid per-turn deltas produce the partial inclusive token report and subset details in [[codex-53](#codex-53)], [[codex-15](#codex-15)], [[codex-16](#codex-16)], and [[codex-17](#codex-17)];
- the first runtime model selected by [[codex-36](#codex-36)] produces one authentic record, while no runtime model produces none and a requested model is never substituted [[codex-17](#codex-17)];
- malformed, decreasing, unseen-resumed, optional-shape-transition, or otherwise unattributable accounting omits tokens and recovers only through [[codex-15](#codex-15)]'s valid baseline states;
- every terminal preserves [[codex-29](#codex-29)]'s independently observed tool count, including when tokens are omitted; and
- no current report publishes removed flat fields, an availability placeholder, requested-model attribution, or cost [[codex-17](#codex-17)].

### codex-60

Under [[codex-219](#codex-219)]'s credential precondition, when one `Cligent` and adapter run a fresh prompt and two automatic resumes through the real pinned SDK and CLI in isolated session storage, verification shall compare the unified events with independently captured native events:

- all three invocations complete successfully on one backend thread [[codex-5](#codex-5)], [[codex-6](#codex-6)];
- the fresh report equals the native snapshot and each resumed report equals the exact difference between consecutive native snapshots [[codex-15](#codex-15)];
- present cache and reasoning subsets reconcile with inclusive totals, coverage remains partial, and no cost is invented [[codex-16](#codex-16)], [[codex-17](#codex-17)];
- tool counts equal distinct native tool identities [[codex-29](#codex-29)]; and
- each diagnostic identifies the native snapshot, preceding baseline, and reported difference [[codex-59](#codex-59)].

### codex-61

Given native success and failure streams with valid, absent, malformed, decreased, shape-changing, and invalid-subset usage, and interrupted, exhausted, thrown, consumer-closed, or setup-failed invocations followed by resumed runs, when one adapter normalizes the streams, verification shall assert this accounting continuity matrix:

- every native terminal's diagnostic names the exact report or omission reason, carries numeric counter copies with optional presence preserved, retains an arithmetic difference even when its subsets are invalid, and precedes terminal `done` [[codex-59](#codex-59)];
- changing a diagnostic payload does not mutate a later run's baseline [[codex-59](#codex-59)];
- a run without native terminal usage invalidates its old baseline before a queued resume can use it, while a pre-execution failure preserves the baseline [[codex-62](#codex-62)]; the next valid resumed snapshot after invalidation omits tokens and establishes a baseline, and the following stable snapshot reports its own exact difference [[codex-15](#codex-15)]; and
- omitted tokens leave observed tool counts and terminal status intact [[codex-29](#codex-29)], [[codex-25](#codex-25)], [[codex-26](#codex-26)], [[codex-27](#codex-27)].

### codex-49

Given absent, empty, and non-empty caller working directories, when the adapter maps thread options, it shall preserve each supplied directory exactly and set `skipGitRepoCheck: true` in every row [[codex-9](#codex-9)].

### codex-50

Given repeated executable-resolution or wrapper-setup failures on one caller signal, when each attempted run rejects, no abort listener shall remain registered after any rejection [[codex-40](#codex-40)].

## References

[1]: https://github.com/openai/codex/blob/main/sdk/typescript/README.md 'Codex TypeScript SDK'
[2]: https://developers.openai.com/codex/concepts/sandboxing/auto-review 'Codex: Auto-review'
[3]: https://developers.openai.com/codex/config-reference 'Codex: Configuration Reference'
[4]: https://developers.openai.com/codex/permissions 'Codex: Permission profiles and sandbox settings'
[5]: https://openai.com/index/gpt-5-6/ 'Introducing GPT-5.6'
[6]: https://github.com/openai/codex/blob/rust-v0.151.0/sdk/typescript/src/events.ts#L20-L38 'Codex SDK 0.151.0 turn usage'
[7]: https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/protocol/src/protocol.rs#L2169-L2198 'Codex 0.151.0 token-usage protocol'
[8]: https://nodejs.org/api/esm.html#importmetaresolvespecifier "Node.js import.meta.resolve"
[9]: https://learn.chatgpt.com/docs/agent-configuration/speed "Codex speed"
[10]: https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/config.schema.json "Codex 0.151.0 configuration schema"
[11]: https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/tui/src/chatwidget/service_tiers.rs "Codex 0.151.0 fast-tier selection"
[12]: https://unpkg.com/@openai/codex-sdk@0.151.0/dist/index.d.ts "Codex SDK 0.151.0 public event declarations"
