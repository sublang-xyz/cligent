<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Spec Map

Quick-reference index for locating decisions and spec packages.
Spec items are the source of truth.
Code can be inconsistent with specs during development.

## Authoring and reviewing specs

Know the rules in [`meta.md`](meta.md) before authoring, modifying, or reviewing a DR, IR, or item.

## Layout

```text
decisions/    Decision records (DRs)
intents/      Intent records (IRs)
packages/     Spec packages (one file per package)
map.md        This index
meta.md       The spec of specs
```

## Decisions

| ID | File | Summary |
| --- | --- | --- |
| [DR-000](decisions/000-spec-structure-format.md) | 000-spec-structure-format.md | Spec structure and format |
| [DR-001](decisions/001-unified-cli-agent-interface-architecture.md) | 001-unified-cli-agent-interface-architecture.md | Unified CLI-agent library architecture |
| [DR-002](decisions/002-unified-event-stream-and-adapter-interface.md) | 002-unified-event-stream-and-adapter-interface.md | Unified events and adapter contract |
| [DR-003](decisions/003-role-scoped-session-management.md) | 003-role-scoped-session-management.md | Role-scoped sessions and continuity |
| [DR-004](decisions/004-tmux-play-captain-architecture.md) | 004-tmux-play-captain-architecture.md | tmux-play Captain and player architecture |
| [DR-005](decisions/005-per-adapter-permission-configuration.md) | 005-per-adapter-permission-configuration.md | Portable permission policy and adapter mappings |
| [DR-006](decisions/006-workspace-writable-paths.md) | 006-workspace-writable-paths.md | Workspace-relative writable paths |
| [DR-007](decisions/007-tmux-play-dynamic-player-visibility.md) | 007-tmux-play-dynamic-player-visibility.md | tmux-play dynamic player visibility |
| [DR-008](decisions/008-captain-pre-close-lifecycle.md) | 008-captain-pre-close-lifecycle.md | Captain pre-close lifecycle |
| [DR-009](decisions/009-adapter-scoped-effort-vocabularies.md) | 009-adapter-scoped-effort-vocabularies.md | Adapter-scoped effort vocabularies |
| [DR-010](decisions/010-isolated-captain-control-calls.md) | 010-isolated-captain-control-calls.md | Isolated Captain control calls |
| [DR-011](decisions/011-kimi-code-acp-integration.md) | 011-kimi-code-acp-integration.md | Kimi Code ACP integration |
| [DR-012](decisions/012-runtime-derived-tmux-play-defaults.md) | 012-runtime-derived-tmux-play-defaults.md | Runtime-derived tmux-play defaults |
| [DR-013](decisions/013-cligent-owned-runtime-compatibility.md) | 013-cligent-owned-runtime-compatibility.md | Agent-runtime compatibility ownership |
| [DR-014](decisions/014-unified-token-usage-breakdown.md) | 014-unified-token-usage-breakdown.md | Unified usage accounting |
| [DR-015](decisions/015-managed-tmux-play-lifecycle.md) | 015-managed-tmux-play-lifecycle.md | Managed tmux-play launch lifecycle |
| [DR-016](decisions/016-tmux-pane-logical-identity.md) | 016-tmux-pane-logical-identity.md | Logical tmux pane identity |
| [DR-017](decisions/017-spec-generation-migration.md) | 017-spec-generation-migration.md | Spec-generation migration and released-ID mappings |
| [DR-018](decisions/018-ndjson-end-of-stream-tail.md) | 018-ndjson-end-of-stream-tail.md | NDJSON end-of-stream tail handling |
| [DR-019](decisions/019-superseded-item-retirements.md) | 019-superseded-item-retirements.md | Superseded-item retirement and permanent ID reservations |
| [DR-020](decisions/020-audited-release-preparation.md) | 020-audited-release-preparation.md | Audited release-preparation evidence |
| [DR-021](decisions/021-agent-runtime-fast-mode.md) | 021-agent-runtime-fast-mode.md | Adapter-scoped fast-mode requests and authentic observations |
| [DR-022](decisions/022-definite-session-rejection.md) | 022-definite-session-rejection.md | Typed pre-execution resume rejection, preserved to hosts without automatic retry |
| [DR-023](decisions/023-provider-model-discovery.md) | 023-provider-model-discovery.md | On-demand runtime model catalogs, model effort/fast facts and honest unavailable results |

## Packages

| File | Summary |
| --- | --- |
| [claude-code.md](packages/adapters/claude-code.md) | Claude Code SDK adapter |
| [codex.md](packages/adapters/codex.md) | Codex SDK adapter |
| [engine.md](packages/engine.md) | Cligent engine and shared adapter contract |
| [gemini.md](packages/adapters/gemini.md) | Gemini CLI child-process adapter |
| [git.md](packages/git.md) | Commit workflow and message conventions |
| [kimi.md](packages/adapters/kimi.md) | Kimi Code ACP adapter |
| [licensing.md](packages/licensing.md) | SPDX header policy |
| [ndjson.md](packages/ndjson.md) | NDJSON stream parser |
| [opencode.md](packages/adapters/opencode.md) | OpenCode SDK and server adapter |
| [package.md](packages/package.md) | Distributable package configuration |
| [release.md](packages/release.md) | Versioning and release workflow |
| [tmux-play.md](packages/tmux-play.md) | tmux-play multi-agent application |
