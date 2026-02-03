<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://www.sublang.ai> -->

# DR-002: Unified Event Stream and Adapter Interface

## Status

Proposed

## Context

[DR-001](001-unified-cli-agent-interface-architecture.md) established the architectural direction: a TypeScript library with async generator interface across CLI agents. This decision defines the concrete interface design—event types, adapter contract, and permission model.

## Decision

### Driver-Adapter Architecture

```text
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Cligent   │────▶│   Adapter    │────▶│   Agent     │
│    Core     │◀────│   (Driver)   │◀────│  (Backend)  │
└─────────────┘     └──────────────┘     └─────────────┘
       │                                        │
       ▼                                        ▼
  AgentEvent                              Native Events
```

The core normalizes heterogeneous agent outputs into a **Unified Event Stream (UES)**.
Adapter implementations should align with vendor CLI documentation and repositories for event mapping and option semantics (Claude Code [^1][^2], Codex CLI [^3][^4], Gemini CLI [^5], OpenCode [^6]).

### Unified Event Stream

Nine event types cover the agent lifecycle:

| Event | Purpose |
| ----- | ------- |
| `init` | Session start, capabilities |
| `text` | Complete assistant message |
| `text_delta` | Streaming token |
| `tool_use` | Tool invocation request |
| `tool_result` | Tool execution outcome |
| `thinking` | Reasoning summary (if exposed) |
| `error` | Recoverable/fatal errors |
| `permission_request` | Approval needed |
| `done` | Session end with usage stats |

**Extensibility:** Adapters may emit additional namespaced event types (e.g., `opencode:step_start`, `codex:file_change`, `codex:plan_update`). Consumers should ignore unknown types. If `thinking` is emitted, it should be a safe summary rather than raw chain-of-thought.

#### Base Event

```typescript
type AgentEventType =
  | 'init' | 'text' | 'text_delta' | 'tool_use' | 'tool_result'
  | 'thinking' | 'error' | 'permission_request' | 'done';

interface BaseEvent {
  type: AgentEventType | string;  // string allows namespaced extensions
  agent: AgentId;
  timestamp: number;
  sessionId: string;
  metadata?: Record<string, unknown>;  // vendor-specific fields
}

type AgentId = 'claude-code' | 'codex' | 'gemini' | 'opencode' | string;
```

#### Key Payloads

```typescript
interface InitPayload {
  model: string;
  cwd: string;
  tools: string[];
  capabilities?: Record<string, unknown>;  // feature discovery
}

interface ToolUsePayload {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  description?: string;
}

interface ToolResultPayload {
  toolUseId: string;
  toolName: string;
  status: 'success' | 'error' | 'denied';
  output: unknown;
  durationMs?: number;
}

interface DonePayload {
  status: 'success' | 'error' | 'interrupted' | 'max_turns' | 'max_budget';
  result?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    toolUses: number;
    totalCostUsd?: number;
  };
  durationMs: number;
}
```

Adapters should emit `init` first when possible to establish capabilities.

### Unified Permission Model (UPM)

Three canonical tiers abstract vendor-specific flags:

| Tier | Semantics |
| ---- | --------- |
| `dry-run` | Read-only, plan/suggest only |
| `supervised` | Edit files, ask for shell/network |
| `autonomous` | Full access without prompts |

```typescript
type PermissionTier = 'dry-run' | 'supervised' | 'autonomous';

type PermissionMode = 'default' | 'accept_edits' | 'bypass' | 'plan' | 'ask';
```

`PermissionTier` is optional; adapters use their default if omitted. `PermissionMode` is an optional, adapter-specific hint that may be ignored.

### Adapter Interface

```typescript
interface AgentAdapter {
  readonly id: AgentId;
  readonly name: string;

  run(
    prompt: string,
    options?: AgentOptions
  ): AsyncGenerator<AgentEvent, void, void>;

  isAvailable(): Promise<boolean>;
}

interface AgentOptions {
  cwd?: string;
  model?: string;
  permissionTier?: PermissionTier;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
  abortSignal?: AbortSignal;
  allowedTools?: string[];     // whitelist: only these tools can be used
  disallowedTools?: string[];  // blacklist: these tools cannot be used
  canUseTool?: CanUseTool;
}

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<{ allow: boolean; message?: string }>;
```

Tool filtering: if `allowedTools` is set, only listed tools are available; `disallowedTools` further excludes from that set. Adapters should emit `permission_request` when user decision is required. The `canUseTool` callback allows consistent approval UX across agents, but requires SDK-based adapters or interactive mode; CLI-spawn adapters in headless mode may not support it.

### Session Control

The async generator supports interruption via `AbortSignal`:

```typescript
const controller = new AbortController();
const stream = adapter.run(prompt, { abortSignal: controller.signal });

// Soft interrupt
controller.abort();
```

### Parallel Execution

```typescript
async function* runParallel(
  tasks: Array<{ adapter: AgentAdapter; prompt: string; options?: AgentOptions }>
): AsyncGenerator<AgentEvent> {
  // Merge streams, events tagged by adapter.id
}
```

## Consequences

- **Adapters** translate native events to UES; each agent needs one adapter
- **UPM** provides consistent safety semantics across vendors
- **AbortSignal** standardizes interruption (no custom `interrupt()` method)
- **Session resumption** via `resume` option; checkpointing is adapter-specific
- **Permission hooks** via `canUseTool` require SDK-based adapters or interactive mode
- **Tool filtering** via `allowedTools`/`disallowedTools` supported by all agents; implementation varies (CLI flags, permissions config, policy engine)
- **Budgeting**: `maxTurns` supported by Claude Code, OpenCode (`steps`), Gemini (`maxSessionTurns`); `maxBudgetUsd` only by Claude Code
- **MCP integration** deferred to adapter implementation [^7]
- **Extensibility** via namespaced events, `metadata`, and `capabilities` fields

## References

[^1]: Claude Code documentation: <https://code.claude.com/docs/en/overview>
[^2]: Claude Code GitHub repository: <https://github.com/anthropics/claude-code>
[^3]: OpenAI Codex CLI GitHub repository: <https://github.com/openai/codex>
[^4]: Codex CLI features: <https://developers.openai.com/codex/cli/features/>
[^5]: Gemini CLI GitHub repository: <https://github.com/google-gemini/gemini-cli>
[^6]: OpenCode GitHub repository: <https://github.com/anomalyco/opencode>
[^7]: MCP Specification: <https://modelcontextprotocol.io/specification/2025-11-25>
