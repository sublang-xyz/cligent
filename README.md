<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# cligent

[![npm version](https://img.shields.io/npm/v/@sublang/cligent)](https://www.npmjs.com/package/@sublang/cligent)
[![Node.js](https://img.shields.io/node/v/@sublang/cligent)](https://nodejs.org/)
[![CI](https://github.com/sublang-ai/cligent/actions/workflows/ci.yml/badge.svg)](https://github.com/sublang-ai/cligent/actions/workflows/ci.yml)

Unified TypeScript SDK for AI coding agent CLIs (Claude Code, Codex CLI, Gemini CLI, Kimi Code, OpenCode, and more).

Register an adapter, send a prompt, and consume a single async event stream — regardless of which agent runs underneath.

## Install

```bash
npm install @sublang/cligent
```

The agent SDKs are optional peer dependencies — add the one(s) for the
adapters you use:

```bash
# `>=` keeps the declaration open so a cligent upgrade can carry the runtime
# forward. A bare `npm install <pkg>` writes a caret instead, and for a
# `0.MINOR.PATCH` package a caret pins the minor: `^0.139.0` never reaches
# `0.151.0`, however often you run `npm update`.
npm install "@anthropic-ai/claude-agent-sdk@>=0.3.219"   # Claude Code
npm install "@openai/codex-sdk@>=0.144.0"                # Codex
npm install "@opencode-ai/sdk@>=1.18.12"                 # OpenCode
```

Gemini and default managed-mode OpenCode also need their CLI on `PATH`.
External-mode OpenCode connects to a caller-owned server and needs only the
SDK. Kimi has its own pinned CLI setup below.

```bash
npm install -g @google/gemini-cli   # Gemini CLI
npm install -g opencode-ai          # OpenCode managed server
```

cligent owns which versions of those runtimes work. It refuses one it does
not support, naming the version it found, the version it needs, and the
command that repairs it — before an agent call rather than in the middle of
one. `@sublang/cligent/runtime-targets` publishes the supported and tested
version of every runtime, so a tool built on cligent inherits the policy by
upgrading cligent and carries no agent-SDK version knowledge of its own.
For Claude, those fields classify the Claude Agent SDK itself; that SDK owns
its Claude Code executable selection, and repository conformance checks only
the selected-binary identity and version its own metadata reports. Missing
metadata fields stay `unreported` rather than being guessed from `PATH` or
another installed package. Codex explicitly names its SDK-owned executable
package and resolves that version from inside the Codex SDK's dependency tree.
Note pnpm rewrites `>=` back into a caret on `pnpm update`; there, move the
pin deliberately and let the lockfile hold it.

The Kimi adapter targets the maintained Kimi Code CLI through ACP. Install
the exact conformance target. The external Kimi CLI itself requires Node.js
22.19 or newer to install and run, then authenticate once:

```bash
npm install -g @moonshot-ai/kimi-code@0.39.1
kimi login
```

Adapters reuse each vendor's own authentication from your environment —
a signed-in CLI (e.g. `claude`, `codex`) or its API-key variable
(e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Kimi Code 0.39.1 ACP accepts any
of three: stored OAuth material resolved from the default model or reported
by any logged-in provider, including after `kimi login`; a configured
default-model alias resolving to non-OAuth credentials; or `KIMI_MODEL_NAME`
plus `KIMI_MODEL_API_KEY`. A bare `MOONSHOT_API_KEY` is not one of them,
because it names no default model.
Cligent stores no credentials and never starts an authentication flow itself.

Runtime and declaration requirements:

- Node.js 18.3.0 or newer for Cligent itself; using the Kimi adapter also
  requires the external Kimi CLI to run under Node.js 22.19 or newer.
- TypeScript 5.4 or newer when consuming the package declarations.

## Quick start

```ts
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';

// Cligent wraps an adapter with role identity, session continuity,
// option merging, and protocol hardening.
const agent = new Cligent(new ClaudeCodeAdapter(), {
  role: 'coder',
  model: 'claude-opus-4-8',
});

for await (const event of agent.run('Refactor auth module')) {
  if (event.type === 'text_delta') process.stdout.write(event.payload.delta);
  if (event.type === 'done') console.log('\nDone:', event.payload.status);
}

// Session continuity — the next run auto-resumes the previous session.
for await (const event of agent.run('Now add tests for it')) {
  // ...
}
```

## Supported agents

- **Claude Code** — via `@anthropic-ai/claude-agent-sdk`
- **Codex CLI** — via `@openai/codex-sdk`
- **Gemini CLI** — via child-process NDJSON
- **Kimi Code** — via one short-lived `kimi acp` process per run
- **OpenCode** — via `@opencode-ai/sdk` and, in managed mode, `opencode`

Claude and Codex also accept the optional `fastMode` request, independently
of reasoning `effort`. Availability still depends on the selected model,
account, provider, and policy, and fast serving may cost more. Use the exported
`FAST_MODE_SUPPORT` metadata before presenting the option; see the
[fast-mode guide](docs/guide.md#fast-mode) for request and observation limits.

## Model discovery

Query the installed runtime on demand, without sending a prompt:

```ts
import { discoverAgentModels } from '@sublang/cligent';

const catalog = await discoverAgentModels('codex', { timeoutMs: 10_000 });
if (catalog.status === 'available') {
  for (const model of catalog.models) {
    console.log(model.id, model.effortValues, model.fastModeSupported);
  }
} else {
  console.log(catalog.reason);
}
```

Model metadata comes from the provider: an empty `effortValues` list or
`fastModeSupported: false` means unsupported; an absent field means unknown.
`resolvedModel`, when present, names the model behind an alias. Keep custom
model input available: catalogs may be incomplete and do not guarantee account
access. `getEffortSupport()` and `getFastModeSupport()` describe what the
adapter accepts, independently of model support.

Claude, Codex, Kimi and OpenCode expose read-only catalogs; Gemini currently
returns `unavailable`. Discovery accepts `cwd`, `env` and `signal`, cleans up
its transport, and defaults to a 10-second deadline.

## tmux-play

`tmux-play` is a reference application built on `Cligent` — a working
showcase of what you can compose with the SDK. You chat with a **Captain**
on the left pane; the Captain dispatches work to **players**, each a
`Cligent` on its own adapter and model, streaming live into its own pane
on the right.

```bash
npm install -g @sublang/cligent
npm install -g @openai/codex-sdk         # plus at least one agent runtime
tmux-play                                # discover or create config
tmux-play --config ./tmux-play.config.yaml
```

`tmux-play` needs at least one agent runtime installed alongside it. The
agent SDKs are optional peers, so a global cligent install needs them
globally too — that is the same tree its adapters resolve from. Install
whichever providers you have credentials for:

| Adapter | Install |
| --- | --- |
| `claude` | `npm install -g @anthropic-ai/claude-agent-sdk` |
| `codex` | `npm install -g @openai/codex-sdk` |
| `gemini` | `npm install -g @google/gemini-cli` |
| `kimi` | `npm install -g @moonshot-ai/kimi-code@0.39.1` then `kimi login` (or configure a default model) |
| `opencode` | `npm install -g @opencode-ai/sdk opencode-ai` |

On first run, if neither the cwd nor the home config exists, `tmux-play`
creates `${XDG_CONFIG_HOME:-~/.config}/tmux-play/config.yaml` wired to the
built-in `fanout` Captain plus one player per installed adapter, taking up
to two in the order above — so with the Claude and Codex SDKs installed you
get a `claude` and a `codex` player. The file is yours to edit afterwards.

`tmux-play` installs nothing itself. With no agent runtime installed it
writes no config and prints an install command for each adapter above; if a
configured adapter's runtime is missing, the launcher names it and its
install command before starting tmux, rather than failing on your first
prompt.

The commands above assume cligent sits where npm installs globally by
default. It is the launcher's printed command that is authoritative: an SDK
has to land in the one tree cligent resolves from, and a bare
`npm install [-g]` follows whatever prefix or enclosing project your
shell's npm happens to resolve, so the launcher prints every SDK command
with `--prefix` already filled in. Run what it prints. The error also names
the tree itself, so a layout no canned command reaches stays fixable by
hand.

Requirements:

- [`tmux`](https://github.com/tmux/tmux/wiki/Installing) 3.3 or newer.
- [`glow`](https://github.com/charmbracelet/glow#installation) — Markdown renderer used by the in-pane output pipeline; the launcher fails fast if it is missing.
- An installed runtime, plus credentials, for each adapter your config uses:
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview),
  [Codex CLI](https://github.com/openai/codex),
  [Gemini CLI](https://github.com/google-gemini/gemini-cli),
  [Kimi Code](https://github.com/MoonshotAI/kimi-code),
  [OpenCode](https://opencode.ai).
  The launcher checks that the runtime is installed; credentials stay each
  vendor's own concern and surface when a turn runs.

**The Captain is the extension point.** `tmux-play` owns player
orchestration, panes, and event streaming; you write a Captain to decide
_how_ players collaborate — fanout, planner/router, debate protocol, an
XState graph, anything. The built-in `fanout` Captain runs every player in
parallel and synthesizes their answers; swap it for your own using the
same contract.

See [docs/tmux-play.md](docs/tmux-play.md) for config, layout,
notifications, and writing a Captain.

## Documentation

- [docs/guide.md](docs/guide.md) — `Cligent` class, adapters, permissions, session continuity, [token usage](docs/guide.md#token-usage), parallel execution, event types.
- [docs/tmux-play.md](docs/tmux-play.md) — `tmux-play` config, layout, notifications, snapshot, and writing custom Captains.

## Contributing

We welcome contributions of all kinds. If you'd like to help:

- 🌟 Star our repo if you find cligent useful.
- [Open an issue](https://github.com/sublang-ai/cligent/issues) for bugs or feature requests.
- [Open a PR](https://github.com/sublang-ai/cligent/pulls) for fixes or improvements.
- Discuss on [Discord](https://discord.gg/XxTPjNqy9g) for support or new ideas.

Live Kimi acceptance automatically discovers a local `~/.kimi-code` login
and its managed `bin/kimi` when no override is set. CI reconstructs a
dedicated, disposable Kimi source home from the base64 repository secrets
`KIMI_CODE_CONFIG_TOML_B64` (`config.toml`) and
`KIMI_CODE_CREDENTIALS_JSON_B64` (`credentials/kimi-code.json`). The harness
copies those files into an owner-only temporary home and never runs against the
source directly. If a cloned run rotates the OAuth refresh credential, repeat
`kimi login` for an affected local source. For the dedicated CI account, repeat
the login and replace both repository secrets.

## License

[Apache-2.0](LICENSE)
