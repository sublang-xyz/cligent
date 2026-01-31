<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://www.sublang.xyz> -->

# DR-001: Unified CLI Agent Interface Architecture

## Status

Accepted

## Context

Multiple CLI agents (e.g., Claude Code, Codex CLI, Gemini CLI) have different invocation methods, output formats, and streaming behaviors. We need a unified abstraction layer that:

- Provides a consistent interface to invoke any supported CLI agent
- Normalizes streaming output into a common event structure
- Enables any UI layer (desktop app, web app, terminal) to render agent replies

## Decision

**TypeScript library providing a unified async generator interface across CLI agents.**

### Interface Pattern

```typescript
// Illustrative — actual interface design is out of scope for this decision
interface AgentEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'done';
  agent: string;
  timestamp: number;
  payload: TextEvent | ToolUseEvent | ToolResultEvent | ErrorEvent | DoneEvent;
}

async function* runAgent(agent: string, prompt: string, options?: AgentOptions): AsyncGenerator<AgentEvent>;
```

The key architectural choice is that all adapters emit a **common event structure** (with its final design in later decisions), allowing UI layers to render replies uniformly.

## Architecture

The following examples illustrate the adapter pattern for specific CLI agents.

### Claude Code via Agent SDK

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) returns typed `SDKMessage` objects via async generator [^1]:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({ prompt, options })) {
  // message.type: 'assistant' | 'user' | 'result' | 'system'
  // assistant messages contain content blocks: text, tool_use, tool_result
}
```

The SDK uses Claude Code as its runtime; filesystem-based settings can be loaded via `settingSources` option [^1][^8]. The wrapper normalizes `SDKMessage` → `AgentEvent`.

### Codex via SDK

The Codex SDK (`@openai/codex-sdk`) provides `startThread()` and `run()` methods for programmatic control [^2]:

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread();
await thread.run(prompt);
// See SDK repository for full API details
```

The SDK is preferred over non-interactive CLI mode [^2]. The wrapper normalizes Codex events → `AgentEvent`.

### Gemini via Stream Parser

Spawn CLI and parse streaming JSON output [^3]:

```typescript
spawn('gemini', ['--output-format', 'stream-json', '--prompt', prompt]);
// Parse NDJSON events: init, message, tool_use, tool_result, error, result
```

The wrapper parses NDJSON and normalizes to `AgentEvent`.

### Validated by Industry Prior Art

Official VS Code extensions integrate with their CLI counterparts and share configuration where documented [^4][^5]:

| Extension | Architecture |
| --------- | ------------ |
| **Claude Code** | Shares settings/configuration with the CLI [^4] |
| **Codex** | Uses the Codex CLI and shares `~/.codex/config.toml` configuration [^5] |

## Alternatives Considered

### CLI Wrapper (Shell Script)

Spawn CLIs directly via shell and parse streaming output (e.g., `--output-format stream-json`).

**Advantages:** No runtime dependencies, process isolation (agent crash doesn't affect coordinator), transparent execution that LLMs can generate/debug, real-time observability via NDJSON streams.

**Disadvantages:** Extra processes for JSON parsing (`jq`/awk), string-based error handling (exit codes + stderr), shell job control for parallelism (`&`/`wait`, traps) less ergonomic than `Promise.all()`/`AbortController`, less unit-testable than typed interfaces.

TypeScript library is preferred because it provides typed events (e.g., Claude Agent SDK's `SDKMessage` [^1]), in-process JSON parsing, and compile-time validation.

### MCP

Treat agents as MCP servers and communicate via JSON-RPC [^9].

**Advantages:** Standardized protocol with SSE streaming and notifications [^9], dynamic tool discovery, built-in permission model [^6][^7].

**Disadvantages:** MCP is designed for tool connectivity (agents calling external tools), not agent invocation. Coordinating parallel agents via MCP requires managing multiple server connections, adding complexity compared to async generators with `Promise.all()`.

MCP doesn't define a standard for token-delta or trace events, so achieving glass-box observability would require additional, non-standard instrumentation.

### Why Not Existing Frameworks

| Framework | Approach | Gap |
| --------- | -------- | --- |
| **AWS CLI Agent Orchestrator** [^10] | tmux sessions | Multi-provider (Amazon Q, Claude Code, Codex); tmux-based, not a unified stream schema |
| **Claude Squad** [^11] | Go TUI, tmux, git worktrees | Multi-agent terminal manager; not an orchestration engine |
| **Claude Flow** [^12] | Stream-JSON chaining for Claude Code | Supports real-time NDJSON events; focused on Claude Code, not unified multi-CLI |
| **MCP-Agent** [^13] | Agents as MCP servers | Composable workflows; granular streaming not standardized by MCP |

These solutions address pieces of the problem but none provide a unified, observable, rich-UI-friendly interface across multiple CLI agents.

## Consequences

- **Runtime:** Node.js 18+ (TypeScript library)
- **Per-agent adapters:** Each CLI agent needs an adapter that normalizes its output to a common event structure
- **SDK-first:** Use official SDKs (Claude Agent SDK, Codex SDK) as primary adapters when available
- **Parsers as fallback:** Implement stream parsers for CLI streaming output when SDK is unavailable or unsuitable
- **UI agnostic:** Any renderer (desktop, web, terminal) can consume the unified event stream
- **Extensible:** Adding new agents requires only a new adapter

## References

[^1]: Claude Agent SDK TypeScript Reference: <https://platform.claude.com/docs/en/agent-sdk/typescript>
[^2]: Codex SDK: <https://developers.openai.com/codex/sdk/>
[^3]: Gemini CLI Headless Mode: <https://geminicli.com/docs/cli/headless/>
[^4]: Claude Code VS Code Extension: <https://code.claude.com/docs/en/vs-code>
[^5]: Codex IDE Extension Settings: <https://developers.openai.com/codex/ide/settings/>
[^6]: Claude Code MCP: <https://code.claude.com/docs/en/mcp>
[^7]: Codex Agents SDK Guide (MCP server): <https://developers.openai.com/codex/guides/agents-sdk/>
[^8]: Claude Agent SDK Overview: <https://platform.claude.com/docs/en/agent-sdk/overview>
[^9]: MCP Specification: <https://spec.modelcontextprotocol.io/specification/>
[^10]: AWS CLI Agent Orchestrator: <https://github.com/awslabs/cli-agent-orchestrator>
[^11]: Claude Squad: <https://github.com/smtg-ai/claude-squad>
[^12]: Claude Flow: <https://github.com/ruvnet/claude-flow>
[^13]: MCP-Agent: <https://github.com/lastmile-ai/mcp-agent>
