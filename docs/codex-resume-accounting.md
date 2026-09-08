<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Codex resume accounting investigation

This investigation addresses [Cligent #49](https://github.com/sublang-ai/cligent/issues/49)
using Codex SDK and CLI 0.151.0 on 2026-09-08.

## Original observation

[CLI-010](https://github.com/kagami-l/deepswe-eval-lab/tree/e18a77395da6775c84075bab99713f591a01822d/docs/dogfooding/CLI-010-codex-resume-missing-token)
recorded a successful fresh turn with tokens and a successful resumed turn with
only `toolUses: 6`. The caller reused one Cligent and adapter instance. The saved
evidence contains normalized events, not native terminal counters or the retained
baseline, so it cannot identify which accounting condition caused that omission.
The investigation does not claim to reproduce that exact successful-turn omission.

## Native semantics

Although the SDK type comment describes turn usage, the pinned Rust exec
[event processor](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L117-L127)
uses cumulative thread totals. Session resume
[restores persisted token information](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/session/mod.rs#L1406-L1411).
Removing cumulative subtraction would therefore overcount successful resumes.

A real fresh turn followed by two automatic resumes on one adapter reconciled
exactly with consecutive native snapshots. Native totals of 11,043/910,
23,013/915, and 35,009/934 input/output tokens yielded resumed reports of
11,970/5 and 11,996/19.

The native protocol also has a
[context-window reset](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/protocol/src/protocol.rs#L2232-L2244)
that can decrease component counters. Its presence justifies retaining conservative
reset handling; it is not evidence that the original CLI-010 run took that path.

## Reproduced attribution defect

A separate real run successfully completed one turn, then executed part of a
two-command turn before interruption. The interrupted turn persisted additional
usage without emitting a terminal exec snapshot. The old adapter retained the
baseline from before that work.

| Stage | Cumulative input | Cumulative output |
| --- | ---: | ---: |
| Fresh successful terminal | 11,026 | 5 |
| Interrupted turn's persisted usage | 22,114 | 120 |
| Next successful resumed terminal | 33,450 | 125 |

The resumed request itself consumed 11,336 input and 5 output tokens, as independently
recorded by native `last_token_usage`. The old adapter reported 22,424 input and
120 output tokens: it charged the interrupted work to the later invocation.
The sanitized [captured fixture](../src/__tests__/fixtures/codex-interrupted-usage-0.151.0.json)
preserves all five counters used to reproduce this failure.

## Resolution

A run that closes without native terminal usage now invalidates its baseline
before another run can use it. Its next valid resume omits tokens and establishes
a new baseline; the following stable resume recovers exact differencing. This
applies to interruption, exhausted streams, stream errors, and consumer closure.
The adapter does not recover hidden work by reading Codex's private session files.

Native terminals emit a sanitized `codex:usage` diagnostic with the snapshot,
baseline, attributable delta, and exact report or omission reason. This makes a
future successful-turn omission diagnosable from captured Cligent events.
Tool counts remain independent, coverage stays partial, and the adapter still
does not invent a monetary cost or effective model.

Regression tests cover the captured defect and interrupted-stream variants,
plus existing missing-baseline, reset, optional-counter, malformed, zero, and
recovery cases. A real SDK acceptance test independently reconciles a fresh turn
and two resumes on one backend thread.

A real four-stage rerun after the fix confirmed recovery: fresh native totals
were 11,034/5, the interrupted two-tool turn emitted no terminal snapshot, and
the next resume's 33,489/139 snapshot produced `missing-baseline` with no tokens.
The following resume's 44,870/146 snapshot yielded 11,381/7, exactly matching
native `last_token_usage`, including 11,356 cache-read and 22 cache-write tokens.
