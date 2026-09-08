// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Codex,
  type CodexOptions,
  type Thread,
  type ThreadEvent,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import {
  assertAcceptanceDependencies,
  gateAcceptanceTest,
} from '../__tests__/helpers/acceptance-dependency-gate.js';
import { Cligent } from '../index.js';
import type { CligentEvent, DonePayload } from '../index.js';
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import { CodexAdapter, resolveCodexBinPath } from './codex.js';

interface NativeAccounting {
  resumed?: string;
  threadIds: string[];
  completed: Usage[];
  toolIds: Set<string>;
  errors: string[];
}

interface AccountingPhase {
  native: NativeAccounting;
  diagnostics: unknown[];
  done: DonePayload[];
  errors: string[];
}

const missing = process.env.CODEX_API_KEY ? [] : ['CODEX_API_KEY'];
const acceptanceIt = gateAcceptanceTest(it, it.skip, 'codex', missing);
const prompts = [
  'Do not use any tools. Write a simple 100-word paragraph about tree leaves.',
  'Do not use any tools. Reply only with OK.',
  'Do not use any tools. Reply with one sentence explaining the color green.',
];

describe('Codex real resumed token accounting (codex-60)', () => {
  acceptanceIt(
    'reconciles each invocation with native cumulative counters on one thread',
    async () => {
      assertAcceptanceDependencies('codex', missing);
      const root = mkdtempSync(join(tmpdir(), 'cligent-codex-usage-'));
      const codexHome = join(root, 'codex-home');
      mkdirSync(codexHome);
      const phases: AccountingPhase[] = [];
      const captures: NativeAccounting[] = [];

      // Keep native persistence isolated without changing process.env or the
      // caller's Codex configuration. The SDK still executes its real CLI.
      const nativeEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      nativeEnv.CODEX_HOME = codexHome;

      class CapturingCodex {
        private readonly client: Codex;

        constructor(options?: CodexOptions) {
          this.client = new Codex({ ...options, env: nativeEnv });
        }

        startThread(options?: ThreadOptions) {
          return captureThread(this.client.startThread(options), captures);
        }

        resumeThread(id: string, options?: ThreadOptions) {
          return captureThread(
            this.client.resumeThread(id, options),
            captures,
            id,
          );
        }
      }

      const cligent = new Cligent(
        new CodexAdapter({ loadSdk: async () => ({ Codex: CapturingCodex }) }),
        {
          cwd: root,
          model: process.env.CODEX_MODEL ?? 'gpt-5.6-luna',
          effort: 'low',
          permissions: { mode: 'auto' },
        },
      );

      try {
        expect(
          execFileSync(process.execPath, [resolveCodexBinPath(), '--version'], {
            encoding: 'utf8',
            timeout: 10_000,
            env: nativeEnv,
          }).trim(),
        ).toBe(`codex-cli ${AGENT_RUNTIME_TARGETS.codex[0]!.tested}`);

        let previous: Usage | undefined;
        let sessionId: string | undefined;
        for (const prompt of prompts) {
          const events: CligentEvent[] = [];
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 90_000);
          try {
            for await (const event of cligent.run(prompt, {
              abortSignal: controller.signal,
            })) {
              events.push(event);
            }
          } finally {
            clearTimeout(timer);
          }

          const phase: AccountingPhase = {
            native: captures.at(-1)!,
            diagnostics: events
              .filter((event) => event.type === 'codex:usage')
              .map((event) => event.payload),
            done: events
              .filter((event) => event.type === 'done')
              .map((event) => event.payload as DonePayload),
            errors: events
              .filter((event) => event.type === 'error')
              .map((event) =>
                String((event.payload as { code?: string }).code),
              ),
          };
          phases.push(phase);
          // Failure evidence contains counters and identities only, never
          // prompts, model output, tool arguments, or environment values.
          const evidence = accountingEvidence(phases);
          expect(phase.errors, evidence).toEqual([]);
          expect(phase.native.errors, evidence).toEqual([]);
          expect(phase.done, evidence).toHaveLength(1);
          const done = phase.done[0]!;
          expect(done.status, evidence).toBe('success');
          expect(phase.native.completed, evidence).toHaveLength(1);
          expect(phase.native.threadIds, evidence).toHaveLength(1);
          const nativeId = phase.native.threadIds[0]!;
          expect(phase.native.resumed, evidence).toBe(sessionId);
          sessionId ??= nativeId;
          expect(nativeId, evidence).toBe(sessionId);
          expect(done.resumeToken, evidence).toBe(sessionId);

          const current = phase.native.completed[0]!;
          const delta = (key: keyof Usage): number =>
            current[key] - (previous?.[key] ?? 0);
          const input = delta('input_tokens');
          const output = delta('output_tokens');
          const cacheRead = delta('cached_input_tokens');
          const cacheWrite = delta('cache_write_input_tokens');
          const reasoning = delta('reasoning_output_tokens');

          expect(phase.diagnostics, evidence).toEqual([
            {
              status: 'reported',
              reason: 'reported',
              resumed: previous !== undefined,
              threadId: sessionId,
              snapshot: diagnosticCounters(current),
              ...(previous ? { baseline: diagnosticCounters(previous) } : {}),
              delta: {
                inputTokens: input,
                cachedInputTokens: cacheRead,
                cacheWriteInputTokens: cacheWrite,
                outputTokens: output,
                reasoningOutputTokens: reasoning,
              },
            },
          ]);
          expect(input, evidence).toBeGreaterThan(0);
          expect(output, evidence).toBeGreaterThan(0);
          expect(done.usage.tokens, evidence).toMatchObject({
            coverage: 'partial',
            totals: {
              input: {
                total: input,
                cacheRead,
                cacheWrite,
                uncached: input - cacheRead - cacheWrite,
              },
              output: { total: output, reasoning, visible: output - reasoning },
            },
          });
          expect(done.usage.toolUses, evidence).toBe(phase.native.toolIds.size);
          expect(done.usage.cost, evidence).toBeUndefined();
          previous = current;
        }
      } finally {
        // Native shutdown can finish writing its isolated SQLite state just
        // after the terminal event, so tolerate that bounded cleanup race.
        rmSync(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
    300_000,
  );
});

function captureThread(
  thread: Thread,
  captures: NativeAccounting[],
  resumed?: string,
) {
  const accounting: NativeAccounting = {
    resumed,
    threadIds: [],
    completed: [],
    toolIds: new Set(),
    errors: [],
  };
  captures.push(accounting);
  return {
    async runStreamed(prompt: string, options?: TurnOptions) {
      const { events } = await thread.runStreamed(prompt, options);
      return {
        events: (async function* () {
          for await (const event of events) {
            captureAccounting(event, accounting);
            yield event;
          }
        })(),
      };
    },
  };
}

function captureAccounting(
  event: ThreadEvent,
  capture: NativeAccounting,
): void {
  if (event.type === 'thread.started') capture.threadIds.push(event.thread_id);
  if (event.type === 'turn.completed') capture.completed.push(event.usage);
  if (event.type === 'error' || event.type === 'turn.failed') {
    capture.errors.push(event.type);
  }
  if (
    (event.type === 'item.started' ||
      event.type === 'item.updated' ||
      event.type === 'item.completed') &&
    (event.item.type === 'command_execution' ||
      event.item.type === 'mcp_tool_call')
  ) {
    capture.toolIds.add(event.item.id);
  }
}

function accountingEvidence(phases: AccountingPhase[]): string {
  return JSON.stringify(
    phases.map(({ native, diagnostics, done, errors }) => ({
      native: { ...native, toolIds: [...native.toolIds] },
      diagnostics,
      done: done.map(({ status, resumeToken, usage }) => ({
        status,
        resumeToken,
        usage,
      })),
      errors,
    })),
  );
}

function diagnosticCounters(usage: Usage) {
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    cacheWriteInputTokens: usage.cache_write_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
}
