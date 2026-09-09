// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { Usage as CodexUsage } from '@openai/codex-sdk';

import {
  CodexAdapter,
  mapAgentOptionsToCodexOptions,
  mapEffortToCodexEffort,
  mapPermissionsToCodexOptions,
  resolveCodexBinPath,
} from '../adapters/codex.js';
import { normalizeCodexWindowsDevicePath } from '../adapters/codex-path.js';
import type {
  AgentEvent,
  AgentOptions,
  CodexEffort,
  DonePayload,
  PermissionLevel,
  PermissionPolicy,
} from '../types.js';
import {
  CANONICAL_THREAD_ID,
  canonicalAgentMessage,
  canonicalCommand,
  canonicalCommandCompleted,
  canonicalCommandFailed,
  canonicalFileChange,
  canonicalMcpCall,
  canonicalMcpFailed,
  canonicalMcpResult,
  canonicalToolLifecycleEvents,
  canonicalUsage,
  duplicatedCompletionEvents,
  failedCommandEvents,
  failedMcpEvents,
  interleavedCommandA,
  interleavedCommandB,
  interleavedParallelEvents,
  missedStartEvents,
  repeatedUpdateEvents,
  toolThenStreamEndEvents,
  toolThenTurnFailedEvents,
  updateFirstEvents,
} from './helpers/codex-sdk-events.js';

interface ToolUseAssertion {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

interface ToolResultAssertion {
  toolName: string;
  toolUseId: string;
  status: string;
  output: unknown;
  durationMs?: number;
}

function toolUsePayload(event: AgentEvent): ToolUseAssertion {
  expect(event.type).toBe('tool_use');
  return event.payload as ToolUseAssertion;
}

function toolResultPayload(event: AgentEvent): ToolResultAssertion {
  expect(event.type).toBe('tool_result');
  return event.payload as ToolResultAssertion;
}

interface DoneAssertion {
  status: string;
  result?: string;
  resumeToken?: string;
  usage: DonePayload['usage'];
  durationMs: number;
}

function donePayload(event: AgentEvent): DoneAssertion {
  expect(event.type).toBe('done');
  return event.payload as DoneAssertion;
}

interface MockRunOptions {
  signal?: AbortSignal;
  abortSignal?: AbortSignal;
}

interface MockThreadOptions {
  cwd?: string;
  workingDirectory?: string;
  model?: string;
  modelReasoningEffort?: string;
  maxTurns?: number;
  sandboxMode?: string;
  approvalPolicy?: string;
  networkAccessEnabled?: boolean;
  skipGitRepoCheck?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
}

interface MockCodexConstructorOptions {
  codexPathOverride?: string;
  config?: Record<string, unknown>;
}

interface MockCodexThread {
  runStreamed(
    prompt: string,
    options?: MockRunOptions,
  ): Promise<{ events: AsyncIterable<unknown> }>;
}

interface MockCodexClient {
  startThread(options?: MockThreadOptions): MockCodexThread;
  resumeThread?(threadId: string, options?: MockThreadOptions): MockCodexThread;
}

/**
 * Replay a different event batch per `run()`, so a test can observe how the
 * adapter treats successive turns on one thread.
 */
function makeQueuedLoader(
  batches: unknown[][],
): () => Promise<{ Codex: new () => MockCodexClient }> {
  let index = 0;
  const nextBatch = (): unknown[] =>
    batches[Math.min(index++, batches.length - 1)] ?? [];

  async function* eventStream(
    batch: unknown[],
  ): AsyncGenerator<unknown, void, void> {
    for (const event of batch) yield event;
  }

  const thread = (): MockCodexThread => {
    const batch = nextBatch();
    return {
      async runStreamed(): Promise<{ events: AsyncIterable<unknown> }> {
        return { events: { [Symbol.asyncIterator]: () => eventStream(batch) } };
      },
    };
  };

  return async () => ({
    Codex: class {
      startThread(): MockCodexThread {
        return thread();
      }

      resumeThread(): MockCodexThread {
        return thread();
      }
    },
  });
}

function makeLoader(config: {
  events: unknown[];
  onConstruct?: (options: MockCodexConstructorOptions | undefined) => void;
  onStartThread?: (options: MockThreadOptions | undefined) => void;
  onResumeThread?: (
    threadId: string,
    options: MockThreadOptions | undefined,
  ) => void;
  onRun?: (prompt: string, options: MockRunOptions | undefined) => void;
  onEventConsumed?: (event: unknown) => void;
  throwFromRun?: Error;
  throwFromStreamSetup?: Error;
}): () => Promise<{ Codex: new () => MockCodexClient }> {
  async function* eventStream(): AsyncGenerator<unknown, void, void> {
    for (const event of config.events) {
      config.onEventConsumed?.(event);
      yield event;
    }
    if (config.throwFromRun) {
      throw config.throwFromRun;
    }
  }

  return async () =>
    ({
      Codex: class {
        constructor(options?: MockCodexConstructorOptions) {
          config.onConstruct?.(options);
        }

        startThread(options?: MockThreadOptions): MockCodexThread {
          config.onStartThread?.(options);
          return {
            async runStreamed(
              prompt: string,
              runOptions?: MockRunOptions,
            ): Promise<{ events: AsyncIterable<unknown> }> {
              config.onRun?.(prompt, runOptions);
              if (config.throwFromStreamSetup)
                throw config.throwFromStreamSetup;
              return {
                events: {
                  [Symbol.asyncIterator]: () => eventStream(),
                },
              };
            },
          };
        }

        resumeThread(
          threadId: string,
          options?: MockThreadOptions,
        ): MockCodexThread {
          config.onResumeThread?.(threadId, options);
          return {
            async runStreamed(
              prompt: string,
              runOptions?: MockRunOptions,
            ): Promise<{ events: AsyncIterable<unknown> }> {
              config.onRun?.(prompt, runOptions);
              if (config.throwFromStreamSetup)
                throw config.throwFromStreamSetup;
              return {
                events: {
                  [Symbol.asyncIterator]: () => eventStream(),
                },
              };
            },
          };
        }
      },
    }) as unknown as { Codex: new (options?: unknown) => MockCodexClient };
}

async function collect(
  stream: AsyncGenerator<AgentEvent, void, void>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('CodexAdapter', () => {
  it('maps canonical SDK tool lifecycles to unified events (codex-201)', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({ events: canonicalToolLifecycleEvents }),
    });

    const events = await collect(
      adapter.run('do it', {
        model: 'gpt-5-codex',
        cwd: '/repo',
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_use',
      'tool_result',
      'tool_result',
      'text',
      'codex:file_change',
      'codex:usage',
      'done',
    ]);
    for (const event of events) {
      expect(event.sessionId).toBe(CANONICAL_THREAD_ID);
    }

    const init = events[0] as AgentEvent & {
      payload: { model: string; cwd: string; tools: string[] };
    };
    expect(init.payload.model).toBe('gpt-5-codex');
    expect(init.payload.cwd).toBe('/repo');

    const commandUse = toolUsePayload(events[1]);
    expect(commandUse.toolName).toBe('command_execution');
    expect(commandUse.toolUseId).toBe(canonicalCommand.id);
    expect(commandUse.input).toEqual({ command: canonicalCommand.command });

    const mcpUse = toolUsePayload(events[2]);
    expect(mcpUse.toolName).toBe('files.read');
    expect(mcpUse.toolUseId).toBe(canonicalMcpCall.id);
    expect(mcpUse.input).toEqual(canonicalMcpCall.arguments);

    const commandResult = toolResultPayload(events[3]);
    expect(commandResult.toolName).toBe('command_execution');
    expect(commandResult.toolUseId).toBe(canonicalCommand.id);
    expect(commandResult.status).toBe('success');
    expect(commandResult.output).toEqual({
      aggregated_output: canonicalCommandCompleted.aggregated_output,
      exit_code: 0,
    });

    const mcpResult = toolResultPayload(events[4]);
    expect(mcpResult.toolName).toBe('files.read');
    expect(mcpResult.toolUseId).toBe(canonicalMcpCall.id);
    expect(mcpResult.status).toBe('success');
    expect(mcpResult.output).toEqual(canonicalMcpResult);

    const text = events[5] as AgentEvent & { payload: { content: string } };
    expect(text.payload.content).toBe(canonicalAgentMessage.text);

    // codex:file_change keeps passing the native item through unchanged.
    expect(events[6].payload).toEqual(canonicalFileChange);

    const done = donePayload(events.at(-1)!);
    expect(done.status).toBe('success');
    expect(done.resumeToken).toBe(CANONICAL_THREAD_ID);
    // toolUses derives from the unique observed tool item ids; the SDK
    // usage object carries token counts only.
    expect(done.usage).toEqual({
      toolUses: 2,
      tokens: {
        coverage: 'partial',
        totals: {
          input: {
            total: 33,
            uncached: 16,
            cacheRead: 12,
            cacheWrite: 5,
          },
          output: {
            total: 44,
            visible: 38,
            reasoning: 6,
          },
        },
      },
    });
  });

  // codex-240
  it('does not substitute the requested model for an observed rate-card key', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({ events: canonicalToolLifecycleEvents }),
    });

    const events = await collect(
      adapter.run('do it', { cwd: '/repo', model: 'requested-model' }),
    );
    const done = donePayload(events.at(-1)!);
    // Nothing in the runtime stream named the effective model. The requested
    // model may have been rerouted, so it is not published as a rate-card key.
    expect(done.usage.tokens).toBeDefined();
    expect(done.usage.tokens?.records).toBeUndefined();
  });

  it('publishes a turn record when the runtime names the effective model', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          { type: 'thread.started', thread_id: 'thread-model' },
          {
            type: 'turn.completed',
            model: 'runtime-model',
            usage: canonicalUsage,
          },
        ],
      }),
    });

    const events = await collect(
      adapter.run('do it', { model: 'requested-model' }),
    );
    expect(donePayload(events.at(-1)!).usage.tokens?.records).toEqual([
      {
        model: 'runtime-model',
        tokens: {
          input: {
            total: 33,
            uncached: 16,
            cacheRead: 12,
            cacheWrite: 5,
          },
          output: { total: 44, visible: 38, reasoning: 6 },
        },
      },
    ]);
  });

  it('emits one tool_use and one terminal tool_result across repeated updates', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({ events: repeatedUpdateEvents }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'codex:usage',
      'done',
    ]);
    expect(toolUsePayload(events[1]).toolUseId).toBe(canonicalCommand.id);
    expect(toolResultPayload(events[2]).toolUseId).toBe(canonicalCommand.id);
    expect(donePayload(events.at(-1)!).usage.toolUses).toBe(1);
  });

  it('keeps an explicitly reported zero distinct from unavailable usage', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          { type: 'thread.started', thread_id: 'thread-zero' },
          {
            type: 'turn.completed',
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(donePayload(events.at(-1)!).usage).toEqual({
      toolUses: 0,
      tokens: {
        coverage: 'partial',
        totals: {
          input: { total: 0 },
          output: { total: 0 },
        },
      },
    });
  });

  it('reports the turn delta of the cumulative thread snapshot', async () => {
    // Codex attaches the thread's running total to every turn.completed, so
    // turn two's snapshot already contains turn one.
    const turns = [
      [
        { type: 'thread.started', thread_id: 'thread-delta' },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            cache_write_input_tokens: 10,
            output_tokens: 30,
            reasoning_output_tokens: 12,
          },
        },
      ],
      [
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 260,
            cached_input_tokens: 90,
            cache_write_input_tokens: 10,
            output_tokens: 55,
            reasoning_output_tokens: 20,
          },
        },
      ],
    ];
    const adapter = new CodexAdapter({
      loadSdk: makeQueuedLoader(turns),
    });

    const first = await collect(adapter.run('one'));
    expect(donePayload(first.at(-1)!).usage.tokens).toMatchObject({
      coverage: 'partial',
      totals: { input: { total: 100 }, output: { total: 30 } },
    });

    const second = await collect(
      adapter.run('two', { resume: 'thread-delta' }),
    );
    expect(donePayload(second.at(-1)!).usage.tokens).toMatchObject({
      coverage: 'partial',
      totals: { input: { total: 160 }, output: { total: 25 } },
    });
  });

  it('omits an absent-to-present optional-counter transition, then recovers', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeQueuedLoader([
        [
          { type: 'thread.started', thread_id: 'thread-shape-appears' },
          {
            type: 'turn.completed',
            usage: { input_tokens: 100, output_tokens: 30 },
          },
        ],
        [
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 160,
              cached_input_tokens: 40,
              output_tokens: 50,
            },
          },
        ],
        [
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 200,
              cached_input_tokens: 50,
              output_tokens: 60,
            },
          },
        ],
      ]),
    });

    await collect(adapter.run('seed'));
    const transition = await collect(
      adapter.run('transition', { resume: 'thread-shape-appears' }),
    );
    expect(donePayload(transition.at(-1)!).usage.tokens).toBeUndefined();

    const stable = await collect(
      adapter.run('stable', { resume: 'thread-shape-appears' }),
    );
    expect(donePayload(stable.at(-1)!).usage.tokens?.totals).toEqual({
      input: { total: 40, cacheRead: 10 },
      output: { total: 10 },
    });
  });

  it('omits a present-to-absent optional-counter transition, then recovers', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeQueuedLoader([
        [
          { type: 'thread.started', thread_id: 'thread-shape-disappears' },
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 100,
              cached_input_tokens: 30,
              output_tokens: 30,
              reasoning_output_tokens: 10,
            },
          },
        ],
        [
          {
            type: 'turn.completed',
            usage: { input_tokens: 160, output_tokens: 50 },
          },
        ],
        [
          {
            type: 'turn.completed',
            usage: { input_tokens: 200, output_tokens: 60 },
          },
        ],
      ]),
    });

    await collect(adapter.run('seed'));
    const transition = await collect(
      adapter.run('transition', { resume: 'thread-shape-disappears' }),
    );
    expect(donePayload(transition.at(-1)!).usage.tokens).toBeUndefined();

    const stable = await collect(
      adapter.run('stable', { resume: 'thread-shape-disappears' }),
    );
    expect(donePayload(stable.at(-1)!).usage.tokens?.totals).toEqual({
      input: { total: 40 },
      output: { total: 10 },
    });
  });

  it('serializes concurrent turns resumed on the same cumulative thread', async () => {
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let markSecondConstructed!: () => void;
    const secondConstructed = new Promise<void>((resolve) => {
      markSecondConstructed = resolve;
    });
    const startedPrompts: string[] = [];
    let constructions = 0;

    const snapshots: Record<
      string,
      { input_tokens: number; output_tokens: number }
    > = {
      seed: { input_tokens: 100, output_tokens: 40 },
      first: { input_tokens: 130, output_tokens: 52 },
      second: { input_tokens: 175, output_tokens: 70 },
    };
    const thread: MockCodexThread = {
      async runStreamed(prompt): Promise<{ events: AsyncIterable<unknown> }> {
        startedPrompts.push(prompt);
        if (prompt === 'first') markFirstStarted();

        async function* events(): AsyncGenerator<unknown, void, void> {
          if (prompt === 'first') await firstMayFinish;
          if (prompt === 'seed') {
            yield { type: 'thread.started', thread_id: 'thread-serialized' };
          }
          yield { type: 'turn.completed', usage: snapshots[prompt] };
        }

        return { events: { [Symbol.asyncIterator]: () => events() } };
      },
    };
    const adapter = new CodexAdapter({
      loadSdk: async () => ({
        Codex: class {
          constructor() {
            constructions += 1;
            if (constructions === 3) markSecondConstructed();
          }

          startThread(): MockCodexThread {
            return thread;
          }

          resumeThread(): MockCodexThread {
            return thread;
          }
        },
      }),
    });

    await collect(adapter.run('seed'));
    const firstRun = collect(
      adapter.run('first', { resume: 'thread-serialized' }),
    );
    await firstStarted;
    const secondRun = collect(
      adapter.run('second', { resume: 'thread-serialized' }),
    );
    await secondConstructed;

    // The second invocation has reached the adapter, but its prompt cannot
    // start while the first still owns this resumed session's baseline.
    expect(startedPrompts).toEqual(['seed', 'first']);

    releaseFirst();
    const first = await firstRun;
    const second = await secondRun;
    expect(startedPrompts).toEqual(['seed', 'first', 'second']);
    expect(donePayload(first.at(-1)!).usage.tokens?.totals).toEqual({
      input: { total: 30 },
      output: { total: 12 },
    });
    expect(donePayload(second.at(-1)!).usage.tokens?.totals).toEqual({
      input: { total: 45 },
      output: { total: 18 },
    });
  });

  it('keeps inclusive output while omitting unreported reasoning detail', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeQueuedLoader([
        [
          { type: 'thread.started', thread_id: 'thread-no-reasoning' },
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 90,
              cached_input_tokens: 30,
              output_tokens: 20,
            },
          },
        ],
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    expect(donePayload(events.at(-1)!).usage.tokens?.totals).toEqual({
      input: { total: 90, cacheRead: 30 },
      output: { total: 20 },
    });
  });

  it('omits tokens when a reported subset exceeds its inclusive total', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeQueuedLoader([
        [
          { type: 'thread.started', thread_id: 'thread-inconsistent' },
          {
            type: 'turn.completed',
            usage: {
              // cached exceeds the inclusive base, so no exclusive input
              // component exists; clamping would overstate the partition.
              input_tokens: 10,
              cached_input_tokens: 40,
              output_tokens: 8,
              reasoning_output_tokens: 3,
            },
          },
        ],
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    const usage = donePayload(events.at(-1)!).usage;
    expect(usage.tokens).toBeUndefined();
  });

  it('reports unavailable for a resumed thread it holds no baseline for', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeQueuedLoader([
        [
          {
            type: 'turn.completed',
            usage: { input_tokens: 900, output_tokens: 400 },
          },
        ],
      ]),
    });

    const events = await collect(
      adapter.run('resumed', { resume: 'thread-unseen' }),
    );
    expect(donePayload(events.at(-1)!).usage).toEqual({
      toolUses: 0,
    });
  });

  it('reports unavailable when the cumulative snapshot decreases', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeQueuedLoader([
        [
          { type: 'thread.started', thread_id: 'thread-reset' },
          {
            type: 'turn.completed',
            usage: { input_tokens: 500, output_tokens: 200 },
          },
        ],
        [
          // A runtime reset restarts the thread's accounting; the drop cannot be
          // attributed to this turn.
          {
            type: 'turn.completed',
            usage: { input_tokens: 120, output_tokens: 40 },
          },
        ],
        [
          {
            type: 'turn.completed',
            usage: { input_tokens: 200, output_tokens: 90 },
          },
        ],
      ]),
    });

    await collect(adapter.run('one'));
    const reset = await collect(adapter.run('two', { resume: 'thread-reset' }));
    expect(donePayload(reset.at(-1)!).usage.tokens).toBeUndefined();

    // The baseline advanced anyway, so the next turn is attributable again.
    const recovered = await collect(
      adapter.run('three', { resume: 'thread-reset' }),
    );
    expect(donePayload(recovered.at(-1)!).usage.tokens).toMatchObject({
      coverage: 'partial',
      totals: { input: { total: 80 }, output: { total: 50 } },
    });
  });

  it('invalidates a stale baseline after a malformed cumulative snapshot', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeQueuedLoader([
        [
          { type: 'thread.started', thread_id: 'thread-malformed' },
          {
            type: 'turn.completed',
            usage: { input_tokens: 10, output_tokens: 4 },
          },
        ],
        [
          {
            type: 'turn.completed',
            usage: { input_tokens: 'bad', output_tokens: 6 },
          },
        ],
        [
          {
            type: 'turn.completed',
            usage: { input_tokens: 20, output_tokens: 8 },
          },
        ],
        [
          {
            type: 'turn.completed',
            usage: { input_tokens: 25, output_tokens: 10 },
          },
        ],
      ]),
    });

    await collect(adapter.run('seed'));
    const malformed = await collect(
      adapter.run('malformed', { resume: 'thread-malformed' }),
    );
    expect(donePayload(malformed.at(-1)!).usage.tokens).toBeUndefined();

    // The next valid total cannot be subtracted across the malformed turn.
    const rebaseline = await collect(
      adapter.run('rebaseline', { resume: 'thread-malformed' }),
    );
    expect(donePayload(rebaseline.at(-1)!).usage.tokens).toBeUndefined();

    const recovered = await collect(
      adapter.run('recovered', { resume: 'thread-malformed' }),
    );
    expect(donePayload(recovered.at(-1)!).usage.tokens?.totals).toEqual({
      input: { total: 5 },
      output: { total: 2 },
    });
  });

  it('emits a sanitized native usage diagnostic before done', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeQueuedLoader([
        [
          { type: 'thread.started', thread_id: 'diagnostic-thread' },
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 100,
              output_tokens: 30,
              cached_input_tokens: 40,
            },
          },
        ],
        [
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 160,
              output_tokens: 50,
              cached_input_tokens: 50,
              private_payload: 'must not appear',
            },
          },
        ],
      ]),
    });
    const fresh = await collect(adapter.run('fresh'));
    expect(fresh.map((event) => event.type)).toEqual([
      'init',
      'codex:usage',
      'done',
    ]);
    const firstDiagnostic = fresh.at(-2)!;
    expect(firstDiagnostic.payload).toEqual({
      status: 'reported',
      reason: 'reported',
      resumed: false,
      threadId: 'diagnostic-thread',
      snapshot: { inputTokens: 100, outputTokens: 30, cachedInputTokens: 40 },
      delta: { inputTokens: 100, outputTokens: 30, cachedInputTokens: 40 },
    });
    // Event consumers must not gain a mutable reference to the retained baseline.
    (
      firstDiagnostic.payload as { snapshot: { inputTokens: number } }
    ).snapshot.inputTokens = 999;
    const resumed = await collect(
      adapter.run('resume', { resume: 'diagnostic-thread' }),
    );
    expect(resumed.at(-2)?.sessionId).toBe(resumed.at(-1)?.sessionId);
    expect(resumed.at(-2)?.payload).toEqual({
      status: 'reported',
      reason: 'reported',
      resumed: true,
      threadId: 'diagnostic-thread',
      snapshot: { inputTokens: 160, outputTokens: 50, cachedInputTokens: 50 },
      baseline: { inputTokens: 100, outputTokens: 30, cachedInputTokens: 40 },
      delta: { inputTokens: 60, outputTokens: 20, cachedInputTokens: 10 },
    });
    expect(donePayload(resumed.at(-1)!).usage.tokens?.totals).toEqual({
      input: { total: 60, cacheRead: 10 },
      output: { total: 20 },
    });
  });

  it.each([
    { name: 'missing', raw: undefined, reason: 'missing-usage' },
    {
      name: 'malformed',
      raw: { input_tokens: 'private', output_tokens: 5 },
      reason: 'invalid-usage',
    },
    {
      name: 'conflicting aliases',
      raw: { input_tokens: 100, inputTokens: 101, output_tokens: 5 },
      reason: 'invalid-usage',
    },
    {
      name: 'invalid subsets',
      raw: { input_tokens: 5, output_tokens: 5, cached_input_tokens: 10 },
      reason: 'invalid-token-subsets',
    },
  ])(
    'explains $name native usage without exposing arbitrary fields',
    async ({ raw, reason }) => {
      const adapter = new CodexAdapter({
        loadSdk: makeLoader({
          events: [
            { type: 'thread.started', thread_id: 'diagnostic-invalid' },
            { type: 'turn.completed', usage: raw },
          ],
        }),
      });
      const events = await collect(adapter.run('prompt'));
      expect(events.at(-2)?.type).toBe('codex:usage');
      expect(events.at(-2)?.payload).toMatchObject({
        status: 'omitted',
        reason,
        resumed: false,
      });
      expect(JSON.stringify(events.at(-2)?.payload)).not.toContain('private');
      expect(donePayload(events.at(-1)!).usage).toEqual({ toolUses: 0 });
      if (reason === 'invalid-usage' || reason === 'missing-usage') {
        expect(events.at(-2)?.payload).not.toHaveProperty('snapshot');
        expect(events.at(-2)?.payload).not.toHaveProperty('delta');
      }
    },
  );

  it.each([
    {
      name: 'unseen resume',
      seed: undefined,
      current: { input_tokens: 160, output_tokens: 50 },
      reason: 'missing-baseline',
    },
    {
      name: 'optional shape change',
      seed: { input_tokens: 100, output_tokens: 30 },
      current: {
        input_tokens: 160,
        output_tokens: 50,
        cached_input_tokens: 20,
      },
      reason: 'counter-shape-changed',
    },
    {
      name: 'decreased counter',
      seed: { input_tokens: 100, output_tokens: 30 },
      current: { input_tokens: 160, output_tokens: 20 },
      reason: 'counter-decreased',
    },
    {
      name: 'inconsistent delta subsets',
      seed: { input_tokens: 100, output_tokens: 30, cached_input_tokens: 10 },
      current: {
        input_tokens: 120,
        output_tokens: 50,
        cached_input_tokens: 40,
      },
      reason: 'invalid-token-subsets',
    },
  ])(
    'explains $name attribution failure',
    async ({ seed, current, reason }) => {
      const adapter = new CodexAdapter({
        loadSdk: makeQueuedLoader([
          ...(seed
            ? [
                [
                  { type: 'thread.started', thread_id: 'diagnostic-resume' },
                  { type: 'turn.completed', usage: seed },
                ],
              ]
            : []),
          [{ type: 'turn.completed', usage: current }],
        ]),
      });
      if (seed) await collect(adapter.run('seed'));
      const events = await collect(
        adapter.run('resume', { resume: 'diagnostic-resume' }),
      );
      expect(events.at(-2)?.payload).toMatchObject({
        status: 'omitted',
        reason,
        resumed: true,
        threadId: 'diagnostic-resume',
      });
      expect(events.at(-2)?.payload).toHaveProperty('snapshot');
      if (seed) expect(events.at(-2)?.payload).toHaveProperty('baseline');
      else expect(events.at(-2)?.payload).not.toHaveProperty('baseline');
      if (reason === 'invalid-token-subsets') {
        // The arithmetic is preserved as evidence even though cache reads
        // exceed this turn's inclusive input and cannot form a token report.
        expect(events.at(-2)?.payload).toHaveProperty('delta', {
          inputTokens: 20,
          outputTokens: 20,
          cachedInputTokens: 30,
        });
      }
      expect(donePayload(events.at(-1)!).usage.tokens).toBeUndefined();
    },
  );

  it.each([
    'abort',
    'exhaustion',
    'iterator error',
    'consumer close',
    'stream setup error',
    'empty stream result',
  ] as const)(
    'invalidates the boundary before a queued resume after %s and recovers (native 0.151.0 fixture)',
    async (exit) => {
      const fixture = JSON.parse(
        readFileSync(
          new URL(
            './fixtures/codex-interrupted-usage-0.151.0.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as {
        threadId: string;
        fresh: CodexUsage;
        interruptedPersisted: CodexUsage;
        resumed: CodexUsage;
        resumedLastRequest: CodexUsage;
      };
      // This relation is the captured defect: subtracting the old successful
      // baseline assigns the interrupted request to the resumed invocation.
      expect(fixture.resumed.output_tokens - fixture.fresh.output_tokens).toBe(
        120,
      );
      expect(fixture.resumedLastRequest.output_tokens).toBe(5);
      expect(fixture.interruptedPersisted.output_tokens).toBe(120);
      const controller = new AbortController();
      const setupFailure =
        exit === 'stream setup error' || exit === 'empty stream result';
      const gate = (): { promise: Promise<void>; resolve: () => void } => {
        let resolve!: () => void;
        const promise = new Promise<void>((release) => {
          resolve = release;
        });
        return { promise, resolve };
      };
      const interruptionStarted = gate();
      const interruptionMayFinish = gate();
      const queuedConstructed = gate();
      const startedPrompts: string[] = [];
      const following = {
        ...fixture.resumed,
        input_tokens: fixture.resumed.input_tokens + 10,
        output_tokens: fixture.resumed.output_tokens + 2,
      };
      const command = {
        type: 'item.started',
        item: {
          id: 'pending-command',
          type: 'command_execution',
          command: 'sleep 30',
          status: 'in_progress',
        },
      };
      const interruptedThread: MockCodexThread = {
        async runStreamed(prompt) {
          startedPrompts.push(prompt);
          interruptionStarted.resolve();
          if (setupFailure) {
            await interruptionMayFinish.promise;
            if (exit === 'empty stream result') {
              // Deliberately violate the SDK shape to exercise its empty-result
              // guard after execution was requested.
              return undefined as unknown as { events: AsyncIterable<unknown> };
            }
            throw new Error('stream setup failed');
          }
          return {
            events: (async function* () {
              try {
                yield command;
                await interruptionMayFinish.promise;
                if (exit === 'abort') controller.abort();
                if (exit === 'iterator error') {
                  throw new Error('transport closed');
                }
              } finally {
                // Consumer return also waits here, so every exit keeps the
                // first invocation open until its successor is queued.
                await interruptionMayFinish.promise;
              }
            })(),
          };
        },
      };
      const loaders = [
        makeLoader({
          events: [
            { type: 'thread.started', thread_id: fixture.threadId },
            { type: 'turn.completed', usage: fixture.fresh },
          ],
          onRun: (prompt) => startedPrompts.push(prompt),
        }),
        async () => ({
          Codex: class {
            startThread(): MockCodexThread {
              return interruptedThread;
            }
            resumeThread(): MockCodexThread {
              return interruptedThread;
            }
          },
        }),
        makeLoader({
          events: [{ type: 'turn.completed', usage: fixture.resumed }],
          onConstruct: () => queuedConstructed.resolve(),
          onRun: (prompt) => startedPrompts.push(prompt),
        }),
        makeLoader({ events: [{ type: 'turn.completed', usage: following }] }),
      ];
      let invocation = 0;
      const adapter = new CodexAdapter({
        loadSdk: () => loaders[invocation++]!(),
      });
      const queueState = adapter as unknown as {
        threadUsageBaselines: Map<string, unknown>;
        acquireResumeSession(id: string): Promise<() => void>;
      };
      const acquire = queueState.acquireResumeSession.bind(adapter);
      const baselinesAtRelease: boolean[] = [];
      queueState.acquireResumeSession = async (id) => {
        const release = await acquire(id);
        return () => {
          // Observe the actual release boundary without changing queue order.
          baselinesAtRelease.push(queueState.threadUsageBaselines.has(id));
          release();
        };
      };
      await collect(adapter.run('first'));
      const interrupted = adapter.run('interrupted', {
        resume: fixture.threadId,
        abortSignal: controller.signal,
      });
      let interruptedRun: Promise<AgentEvent[]>;
      if (exit === 'consumer close') {
        expect((await interrupted.next()).value?.type).toBe('init');
        expect((await interrupted.next()).value?.type).toBe('tool_use');
        interruptedRun = interrupted.return().then(() => []);
      } else {
        interruptedRun = collect(interrupted);
      }
      const interruptedCompletion = setupFailure
        ? expect(interruptedRun).rejects.toThrow(
            exit === 'stream setup error'
              ? 'stream setup failed'
              : 'does not support runStreamed',
          )
        : interruptedRun;
      await interruptionStarted.promise;
      const resumedRun = collect(
        adapter.run('resumed', { resume: fixture.threadId }),
      );
      try {
        await queuedConstructed.promise;
        // Construction occurs before queue acquisition. Its completion proves
        // the next call reached the adapter, while runStreamed stays blocked.
        expect(startedPrompts).toEqual(['first', 'interrupted']);
      } finally {
        interruptionMayFinish.resolve();
      }
      await interruptedCompletion;
      expect(
        baselinesAtRelease[0],
        'baseline discarded before queue release',
      ).toBe(false);
      if (!setupFailure && exit !== 'consumer close') {
        const events = await interruptedRun;
        expect(donePayload(events.at(-1)!).usage).toEqual({ toolUses: 1 });
        expect(donePayload(events.at(-1)!).status).toBe(
          exit === 'abort' ? 'interrupted' : 'error',
        );
        expect(events.some((event) => event.type === 'codex:usage')).toBe(
          false,
        );
      }
      const resumed = await resumedRun;
      expect(startedPrompts).toEqual(['first', 'interrupted', 'resumed']);
      expect(resumed.at(-2)?.payload).toMatchObject({
        status: 'omitted',
        reason: 'missing-baseline',
      });
      expect(resumed.at(-2)?.payload).not.toHaveProperty('baseline');
      expect(donePayload(resumed.at(-1)!).usage.tokens).toBeUndefined();
      const recovered = await collect(
        adapter.run('following', { resume: fixture.threadId }),
      );
      expect(recovered.at(-2)?.payload).toMatchObject({
        status: 'reported',
        reason: 'reported',
      });
      expect(donePayload(recovered.at(-1)!).usage.tokens?.totals).toEqual({
        input: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
        output: { total: 2, visible: 2, reasoning: 0 },
      });
    },
  );

  it('retains an observed baseline when setup never calls the stream', async () => {
    const loaders = [
      makeLoader({
        events: [
          { type: 'thread.started', thread_id: 'setup-before-stream' },
          {
            type: 'turn.completed',
            usage: { input_tokens: 100, output_tokens: 40 },
          },
        ],
      }),
      async () => ({
        Codex: class {
          startThread(): MockCodexThread {
            return {} as MockCodexThread;
          }
          resumeThread(): MockCodexThread {
            return {} as MockCodexThread;
          }
        },
      }),
      makeLoader({
        events: [
          {
            type: 'turn.completed',
            usage: { input_tokens: 140, output_tokens: 55 },
          },
        ],
      }),
    ];
    let invocation = 0;
    const adapter = new CodexAdapter({
      loadSdk: () => loaders[invocation++]!(),
    });
    await collect(adapter.run('seed'));
    await expect(
      collect(
        adapter.run('no stream method', { resume: 'setup-before-stream' }),
      ),
    ).rejects.toThrow('does not support runStreamed');
    const resumed = await collect(
      adapter.run('resume', { resume: 'setup-before-stream' }),
    );
    expect(resumed.at(-2)?.payload).toMatchObject({
      reason: 'reported',
      baseline: { inputTokens: 100, outputTokens: 40 },
    });
    expect(donePayload(resumed.at(-1)!).usage.tokens?.totals).toEqual({
      input: { total: 40 },
      output: { total: 15 },
    });
  });

  it('announces the call on item.updated when item.started was missed', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({ events: updateFirstEvents }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'codex:usage',
      'done',
    ]);
    expect(toolUsePayload(events[1]).toolUseId).toBe(canonicalCommand.id);
    expect(toolResultPayload(events[2]).toolUseId).toBe(canonicalCommand.id);
    expect(donePayload(events.at(-1)!).usage.toolUses).toBe(1);
  });

  it('reports observed tool uses when the stream ends without a turn event', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          { type: 'thread.started', thread_id: 'thread-exhausted' },
          ...toolThenStreamEndEvents,
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'error',
      'done',
    ]);
    const error = events[3] as AgentEvent & { payload: { code?: string } };
    expect(error.payload.code).toBe('MISSING_TURN_DONE');
    const done = donePayload(events.at(-1)!);
    expect(done.status).toBe('error');
    expect(done.resumeToken).toBe('thread-exhausted');
    expect(done.usage.tokens).toBeUndefined();
    expect(done.usage.toolUses).toBe(1);
  });

  it('reports observed tool uses on the error done after a stream failure', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          { type: 'thread.started', thread_id: 'thread-failed' },
          ...toolThenStreamEndEvents,
        ],
        throwFromRun: new Error('stream blew up'),
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'error',
      'done',
    ]);
    const error = events[3] as AgentEvent & { payload: { code?: string } };
    expect(error.payload.code).toBe('SDK_STREAM_ERROR');
    const done = donePayload(events.at(-1)!);
    expect(done.status).toBe('error');
    expect(done.resumeToken).toBe('thread-failed');
    expect(done.usage.tokens).toBeUndefined();
    expect(done.usage.toolUses).toBe(1);
  });

  it.each([
    ['stream exhaustion', undefined],
    ['iterator failure', new Error('stream blew up')],
  ] as const)(
    'does not echo an inbound resume on synthetic %s',
    async (_case, throwFromRun) => {
      const adapter = new CodexAdapter({
        loadSdk: makeLoader({
          events: toolThenStreamEndEvents,
          ...(throwFromRun ? { throwFromRun } : {}),
        }),
      });

      const events = await collect(
        adapter.run('prompt', { resume: 'inbound-only' }),
      );
      const done = donePayload(events.at(-1)!);
      expect(done.status).toBe('error');
      expect(done).not.toHaveProperty('resumeToken');
    },
  );

  it('synthesizes the missing tool_use before the result when the start was missed', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({ events: missedStartEvents }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'codex:usage',
      'done',
    ]);

    const use = toolUsePayload(events[1]);
    expect(use.toolUseId).toBe(canonicalCommandCompleted.id);
    expect(use.input).toEqual({ command: canonicalCommandCompleted.command });
    expect(toolResultPayload(events[2]).toolUseId).toBe(
      canonicalCommandCompleted.id,
    );
    expect(donePayload(events.at(-1)!).usage.toolUses).toBe(1);
  });

  it('preserves native output and exit code for failed command executions', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({ events: failedCommandEvents }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'codex:usage',
      'done',
    ]);

    const result = toolResultPayload(events[2]);
    expect(result.toolUseId).toBe(canonicalCommandFailed.id);
    expect(result.status).toBe('error');
    expect(result.output).toEqual({
      aggregated_output: canonicalCommandFailed.aggregated_output,
      exit_code: 127,
    });
    expect(donePayload(events.at(-1)!).usage.toolUses).toBe(1);
  });

  it('preserves native error details for failed MCP tool calls', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({ events: failedMcpEvents }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'codex:usage',
      'done',
    ]);

    const use = toolUsePayload(events[1]);
    expect(use.toolName).toBe('files.write');
    expect(use.input).toEqual(canonicalMcpFailed.arguments);

    const result = toolResultPayload(events[2]);
    expect(result.toolName).toBe('files.write');
    expect(result.toolUseId).toBe(canonicalMcpFailed.id);
    expect(result.status).toBe('error');
    expect(result.output).toEqual(canonicalMcpFailed.error);
  });

  it('correlates interleaved concurrent tool items by item id', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({ events: interleavedParallelEvents }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_use',
      'tool_result',
      'tool_result',
      'codex:usage',
      'done',
    ]);

    expect(toolUsePayload(events[1]).toolUseId).toBe(interleavedCommandA.id);
    expect(toolUsePayload(events[2]).toolUseId).toBe(interleavedCommandB.id);
    // Completions arrive in reverse start order and keep their own ids.
    expect(toolResultPayload(events[3]).toolUseId).toBe(interleavedCommandB.id);
    expect(toolResultPayload(events[3]).output).toEqual({
      aggregated_output: 'b\n',
      exit_code: 0,
    });
    expect(toolResultPayload(events[4]).toolUseId).toBe(interleavedCommandA.id);
    expect(donePayload(events.at(-1)!).usage.toolUses).toBe(2);
  });

  it('emits at most one terminal tool_result for duplicated completions', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({ events: duplicatedCompletionEvents }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'codex:usage',
      'done',
    ]);
    expect(donePayload(events.at(-1)!).usage.toolUses).toBe(1);
  });

  it('reports observed tool uses on the done event after turn.failed', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({ events: toolThenTurnFailedEvents }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'tool_result',
      'error',
      'codex:usage',
      'done',
    ]);
    const done = donePayload(events.at(-1)!);
    expect(done.status).toBe('error');
    expect(done.usage.toolUses).toBe(1);
  });

  it('retains legacy alias item shapes as a compatibility fallback', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            sessionId: 'thread-1',
            item: {
              type: 'message',
              content: [
                { type: 'output_text', text: 'Hello from Codex' },
                {
                  type: 'tool_call',
                  id: 'call-1',
                  name: 'bash',
                  arguments: '{"command":"ls"}',
                },
                {
                  type: 'tool_result',
                  tool_call_id: 'call-1',
                  toolName: 'bash',
                  status: 'success',
                  output: { stdout: 'file.txt' },
                  duration_ms: 15,
                },
                {
                  type: 'file_change',
                  path: '/repo/file.txt',
                  action: 'modified',
                },
              ],
            },
          },
          {
            type: 'file.changed',
            sessionId: 'thread-1',
            file: {
              path: '/repo/another.ts',
              action: 'created',
            },
          },
          {
            type: 'error',
            sessionId: 'thread-1',
            code: 'TEMP',
            message: 'transient hiccup',
            recoverable: true,
          },
          {
            type: 'turn.completed',
            sessionId: 'thread-1',
            turn: {
              status: 'max_turns',
              result: 'final summary',
              usage: {
                input_tokens: 33,
                output_tokens: 44,
                tool_uses: 2,
                total_cost_usd: 0.17,
              },
              duration_ms: 222,
            },
          },
        ],
      }),
    });

    const events = await collect(
      adapter.run('do it', {
        model: 'gpt-5-codex',
        cwd: '/repo',
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'tool_use',
      'tool_result',
      'codex:file_change',
      'codex:file_change',
      'error',
      'codex:usage',
      'done',
    ]);

    const text = events[1] as AgentEvent & { payload: { content: string } };
    expect(text.payload.content).toBe('Hello from Codex');

    const toolUse = toolUsePayload(events[2]);
    expect(toolUse.toolName).toBe('bash');
    expect(toolUse.toolUseId).toBe('call-1');
    expect(toolUse.input).toEqual({ command: 'ls' });

    const toolResult = toolResultPayload(events[3]);
    expect(toolResult.toolName).toBe('bash');
    expect(toolResult.toolUseId).toBe('call-1');
    expect(toolResult.status).toBe('success');
    expect(toolResult.output).toEqual({ stdout: 'file.txt' });
    expect(toolResult.durationMs).toBe(15);

    const fileChangeOne = events[4] as AgentEvent & {
      payload: Record<string, unknown>;
    };
    expect(fileChangeOne.payload.path).toBe('/repo/file.txt');

    const fileChangeTwo = events[5] as AgentEvent & {
      payload: Record<string, unknown>;
    };
    expect(fileChangeTwo.payload.path).toBe('/repo/another.ts');

    const error = events[6] as AgentEvent & {
      payload: { code: string; message: string; recoverable: boolean };
    };
    expect(error.payload.code).toBe('TEMP');
    expect(error.payload.message).toBe('transient hiccup');
    expect(error.payload.recoverable).toBe(true);

    const done = donePayload(events.at(-1)!);
    expect(done.status).toBe('max_turns');
    expect(done.result).toBe('final summary');
    // toolUses derives from the unique observed tool-call ids (call-1);
    // the legacy usage field tool_uses: 2 is deliberately not consulted.
    expect(done.usage).toEqual({
      toolUses: 1,
      tokens: {
        coverage: 'partial',
        totals: {
          input: { total: 33 },
          output: { total: 44 },
        },
      },
    });
    expect(done.durationMs).toBe(222);
  });

  it('maps legacy tool-result status values case-insensitively', async () => {
    const statusCases = [
      ['FaIlEd', 'error'],
      ['ERROR', 'error'],
      ['DeNiEd', 'denied'],
      ['SuCcEsS', 'success'],
    ] as const;
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            item: {
              type: 'message',
              content: statusCases.map(([status], index) => ({
                type: 'tool_result',
                tool_call_id: `status-${index}`,
                name: 'status_tool',
                status,
                output: { status },
              })),
            },
          },
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_result',
      'tool_result',
      'tool_result',
      'tool_result',
      'codex:usage',
      'done',
    ]);
    expect(
      events.slice(1, 5).map((event) => toolResultPayload(event).status),
    ).toEqual(statusCases.map(([, expected]) => expected));
  });

  it('preserves top-level result arrays alongside their content events', async () => {
    const arrayOutput = [
      { type: 'output_text', text: 'mirrored output' },
      { type: 'output_text', text: 'block-only output' },
      { code: 0 },
    ];
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            item: {
              type: 'tool_result',
              tool_call_id: 'array-result',
              name: 'array_tool',
              status: 'success',
              text: 'mirrored output',
              content: arrayOutput,
            },
          },
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'text',
      'tool_result',
      'codex:usage',
      'done',
    ]);
    expect(events[1]).toMatchObject({
      payload: { content: 'mirrored output' },
    });
    expect(events[2]).toMatchObject({
      payload: { content: 'block-only output' },
    });
    expect(toolResultPayload(events[3])).toEqual({
      toolName: 'array_tool',
      toolUseId: 'array-result',
      status: 'success',
      output: arrayOutput,
    });
  });

  it('preserves item.completed content block order', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            item: {
              type: 'message',
              content: [
                {
                  type: 'tool_call',
                  id: 'call-order',
                  name: 'bash',
                  arguments: '{}',
                },
                { type: 'output_text', text: 'After tool call' },
                {
                  type: 'tool_result',
                  tool_call_id: 'call-order',
                  toolName: 'bash',
                  status: 'success',
                  output: { ok: true },
                },
              ],
            },
          },
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'text',
      'tool_result',
      'codex:usage',
      'done',
    ]);
  });

  it('does not duplicate text when top-level item.text mirrors content text', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            item: {
              type: 'message',
              text: 'hello',
              content: [{ type: 'output_text', text: 'hello' }],
            },
          },
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'codex:usage',
      'done',
    ]);
    const textEvents = events.filter((event) => event.type === 'text');
    expect(textEvents).toHaveLength(1);
    expect(
      (textEvents[0] as AgentEvent & { payload: { content: string } }).payload
        .content,
    ).toBe('hello');
  });

  it('emits unknown-tools init when tool set cannot be inferred', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            sessionId: 'thread-unknown-tools',
            item: {
              id: 'item_msg',
              type: 'agent_message',
              text: 'hello',
            },
          },
          {
            type: 'turn.completed',
            sessionId: 'thread-unknown-tools',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'codex:usage',
      'done',
    ]);

    const init = events[0] as AgentEvent & {
      payload: {
        tools: string[];
        capabilities: { toolsKnown: boolean; toolsSource: string };
      };
    };
    expect(init.payload.tools).toEqual([]);
    expect(init.payload.capabilities.toolsKnown).toBe(false);
    expect(init.payload.capabilities.toolsSource).toBe('unavailable');
  });

  it('emits degraded init before terminal events when stream throws immediately', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [],
        throwFromRun: new Error('boom-before-first-event'),
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);

    const init = events[0] as AgentEvent & {
      payload: {
        model: string;
        cwd: string;
        tools: string[];
        capabilities: { toolsKnown: boolean; toolsSource: string };
      };
    };
    expect(init.payload.model).toBe('unknown');
    expect(init.payload.tools).toEqual([]);
    expect(init.payload.capabilities.toolsKnown).toBe(false);
    expect(init.payload.capabilities.toolsSource).toBe('unavailable');

    const error = events[1] as AgentEvent & {
      payload: { code: string; message: string; recoverable: boolean };
    };
    expect(error.payload.code).toBe('SDK_STREAM_ERROR');
    expect(error.payload.message).toBe('boom-before-first-event');
    expect(error.payload.recoverable).toBe(false);

    const done = events.at(-1) as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('error');
  });

  it('surfaces turn.failed message and stops iterating before SDK exit', async () => {
    let eventsConsumed = 0;
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'thread.started',
            thread_id: 'thread-fail',
          },
          {
            type: 'turn.started',
          },
          {
            type: 'turn.failed',
            error: {
              message: "The 'gpt-5.5' model requires a newer version of Codex.",
              code: 'model_not_found',
            },
          },
          {
            type: 'item.completed',
            item: {
              type: 'message',
              content: [{ type: 'output_text', text: 'never read' }],
            },
          },
        ],
        onEventConsumed: () => {
          eventsConsumed += 1;
        },
      }),
    });

    const events = await collect(adapter.run('prompt'));

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'codex:usage',
      'done',
    ]);

    const error = events[1] as AgentEvent & {
      payload: { code?: string; message: string; recoverable: boolean };
    };
    expect(error.payload.message).toContain('gpt-5.5');
    expect(error.payload.message).toContain(
      'requires a newer version of Codex',
    );
    expect(error.payload.code).toBe('model_not_found');

    const done = events.at(-1) as AgentEvent & {
      payload: { status: string; resumeToken?: string };
    };
    expect(done.payload.status).toBe('error');
    expect(done.payload.resumeToken).toBe('thread-fail');

    // Iteration must stop at turn.failed; trailing events shall not be read.
    expect(eventsConsumed).toBe(3);
  });

  it('unwraps JSON-encoded Codex error details', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.failed',
            message: JSON.stringify({
              detail: "The 'gpt-5.5' model requires a newer version of Codex.",
              code: 'model_not_found',
            }),
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'codex:usage',
      'done',
    ]);

    const error = events[1] as AgentEvent & {
      payload: { code?: string; message: string; recoverable: boolean };
    };
    expect(error.payload.message).toBe(
      "The 'gpt-5.5' model requires a newer version of Codex.",
    );
    expect(error.payload.message).not.toContain('{"detail"');
    expect(error.payload.code).toBe('model_not_found');
  });

  it('returns false from isAvailable when SDK load fails', async () => {
    const adapter = new CodexAdapter({
      loadSdk: async () => {
        throw new Error('missing sdk');
      },
    });

    await expect(adapter.isAvailable()).resolves.toBe(false);
  });

  it('throws from run when SDK is not installed', async () => {
    const adapter = new CodexAdapter({
      loadSdk: async () => {
        throw new Error('missing sdk');
      },
    });

    const stream = adapter.run('prompt');
    await expect(stream.next()).rejects.toThrow(
      'CodexAdapter requires @openai/codex-sdk. Install it to use this adapter.',
    );
  });

  it('maps UPM permissions to codex modern permission-profile controls for all combinations', () => {
    const levels: PermissionLevel[] = ['allow', 'ask', 'deny'];

    for (const fileWrite of levels) {
      for (const shellExecute of levels) {
        for (const networkAccess of levels) {
          const policy: PermissionPolicy = {
            fileWrite,
            shellExecute,
            networkAccess,
          };

          const mapped = mapPermissionsToCodexOptions(policy);

          const allAllow =
            fileWrite === 'allow' &&
            shellExecute === 'allow' &&
            networkAccess === 'allow';

          const expectedDefaultPermissions = allAllow
            ? ':danger-full-access'
            : fileWrite === 'deny' || shellExecute === 'deny'
              ? ':read-only'
              : ':workspace';

          const anyAsk =
            fileWrite === 'ask' ||
            shellExecute === 'ask' ||
            networkAccess === 'ask';

          const expectedApproval = allAllow
            ? 'never'
            : anyAsk
              ? 'untrusted'
              : 'on-request';

          expect(mapped.codexOptions).toEqual({
            config: {
              default_permissions: expectedDefaultPermissions,
            },
          });
          expect(mapped.approvalPolicy).toBe(expectedApproval);
          expect(mapped).not.toHaveProperty('sandboxMode');
          expect(mapped).not.toHaveProperty('networkAccessEnabled');
        }
      }
    }
  });

  it('leaves Codex permission knobs unset when no policy is provided', () => {
    const mapped = mapPermissionsToCodexOptions(undefined);
    expect(mapped).toEqual({});

    const agentMapped = mapAgentOptionsToCodexOptions({});
    expect(agentMapped.codexOptions).toBeUndefined();
    expect(agentMapped.codexCliExecArgs).toBeUndefined();
    expect(agentMapped.codexCliConfigOverrides).toBeUndefined();
    expect(agentMapped.threadOptions).not.toHaveProperty('approvalPolicy');
    expect(agentMapped.threadOptions).not.toHaveProperty('sandboxMode');
    expect(agentMapped.threadOptions).not.toHaveProperty(
      'networkAccessEnabled',
    );
  });

  it('keeps network-only deny on the workspace default_permissions profile', () => {
    const mapped = mapPermissionsToCodexOptions({
      fileWrite: 'allow',
      shellExecute: 'allow',
      networkAccess: 'deny',
    });

    expect(mapped.codexOptions).toEqual({
      config: {
        default_permissions: ':workspace',
      },
    });
    expect(mapped.approvalPolicy).toBe('on-request');
    expect(mapped).not.toHaveProperty('sandboxMode');
    expect(mapped).not.toHaveProperty('networkAccessEnabled');
  });

  it('treats omitted capability fields as unset within a provided Codex policy', () => {
    const mapped = mapPermissionsToCodexOptions({});

    expect(mapped.codexOptions).toEqual({
      config: {
        default_permissions: ':workspace',
      },
    });
    expect(mapped.approvalPolicy).toBe('on-request');
    expect(mapped).not.toHaveProperty('sandboxMode');
    expect(mapped).not.toHaveProperty('networkAccessEnabled');
  });

  it('maps workspace writablePaths to a custom Codex permission profile', () => {
    const mapped = mapPermissionsToCodexOptions({
      mode: 'auto',
      writablePaths: ['./.git/', 'generated/./cache//'],
    });

    expect(mapped.approvalPolicy).toBe('on-request');
    expect(mapped.writablePaths).toEqual({
      paths: ['.git', 'generated/cache'],
      enforcement: 'profile',
    });
    expect(mapped.codexOptions).toEqual({
      config: {
        default_permissions: 'cligent-workspace-extra-writes',
        approvals_reviewer: 'auto_review',
      },
    });
    expect(mapped.codexCliExecArgs).toEqual(['--ignore-user-config']);
    expect(mapped.codexCliConfigOverrides).toEqual([
      'permissions.cligent-workspace-extra-writes={extends=":workspace", filesystem={":workspace_roots"={".git"="write", "generated/cache"="write"}}}',
    ]);
    expect(mapped).not.toHaveProperty('sandboxMode');
    expect(mapped).not.toHaveProperty('networkAccessEnabled');
  });

  it('injects generated Codex profile config through a temporary CLI wrapper', async () => {
    let capturedCodexOptions: MockCodexConstructorOptions | undefined;
    let wrapperScript: string | undefined;
    let wrapperPath: string | undefined;

    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
        onConstruct(options) {
          capturedCodexOptions = options;
          wrapperPath = options?.codexPathOverride;
          if (wrapperPath) {
            wrapperScript = readFileSync(wrapperPath, 'utf8');
          }
        },
      }),
    });

    await collect(
      adapter.run('implement feature', {
        cwd: process.cwd(),
        permissions: { mode: 'auto', writablePaths: ['.git'] },
      }),
    );

    expect(capturedCodexOptions?.config).toEqual({
      default_permissions: 'cligent-workspace-extra-writes',
      approvals_reviewer: 'auto_review',
    });
    expect(wrapperPath).toBeDefined();
    expect(wrapperScript).toContain('--ignore-user-config');
    expect(wrapperScript).toContain('projects={');
    expect(wrapperScript).not.toContain('projects.\\"');
    expect(wrapperScript).toContain('trust_level=\\"trusted\\"');
    expect(wrapperScript).toContain(
      'permissions.cligent-workspace-extra-writes={extends=\\"' +
        ':workspace\\", filesystem={\\":workspace_roots\\"={\\".git\\"=\\"write\\"}}}',
    );
    expect(existsSync(wrapperPath!)).toBe(false);
  });

  it('rejects writablePaths that conflict with read-only Codex local access', () => {
    expect(() =>
      mapPermissionsToCodexOptions({
        fileWrite: 'deny',
        writablePaths: ['.git'],
      }),
    ).toThrow(
      'Codex permission policy cannot combine non-empty writablePaths with read-only local access',
    );

    expect(() =>
      mapPermissionsToCodexOptions({
        shellExecute: 'deny',
        writablePaths: ['.git'],
      }),
    ).toThrow(/read-only local access/);
  });

  it('keeps danger-full-access broad when writablePaths are redundant', () => {
    const mapped = mapPermissionsToCodexOptions({
      mode: 'bypass',
      writablePaths: ['./.git/'],
    });

    expect(mapped.writablePaths).toEqual({
      paths: ['.git'],
      enforcement: 'ambient',
    });
    expect(mapped.codexOptions).toEqual({
      config: {
        default_permissions: ':danger-full-access',
      },
    });
    expect(mapped.approvalPolicy).toBe('never');
  });

  it('passes AgentOptions through to thread/run options', async () => {
    let capturedCodexOptions: MockCodexConstructorOptions | undefined;
    let capturedThreadOptions: MockThreadOptions | undefined;
    let capturedRunPrompt: string | undefined;
    let capturedRunOptions: MockRunOptions | undefined;

    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
        onConstruct(options) {
          capturedCodexOptions = options;
        },
        onStartThread(options) {
          capturedThreadOptions = options;
        },
        onRun(prompt, options) {
          capturedRunPrompt = prompt;
          capturedRunOptions = options;
        },
      }),
    });

    await collect(
      adapter.run('implement feature', {
        cwd: '/tmp/repo',
        model: 'gpt-5-codex',
        maxTurns: 12,
        permissions: {
          fileWrite: 'allow',
          shellExecute: 'ask',
          networkAccess: 'deny',
        },
      }),
    );

    expect(capturedCodexOptions).toMatchObject({
      config: {
        default_permissions: ':workspace',
      },
    });
    expect(capturedCodexOptions?.codexPathOverride).toBeDefined();
    expect(capturedThreadOptions).toMatchObject({
      workingDirectory: '/tmp/repo',
      model: 'gpt-5-codex',
      approvalPolicy: 'untrusted',
      skipGitRepoCheck: true,
    });
    expect(capturedThreadOptions).not.toHaveProperty('sandboxMode');
    expect(capturedThreadOptions).not.toHaveProperty('networkAccessEnabled');

    expect(capturedRunPrompt).toBe('implement feature');
    expect(capturedRunOptions?.signal).toBeUndefined();
  });

  it('rejects explicit tool restrictions before loading the SDK', async () => {
    let loads = 0;
    const adapter = new CodexAdapter({
      loadSdk: async () => {
        loads++;
        throw new Error('loader must not run');
      },
    });

    for (const options of [
      { allowedTools: [] },
      { allowedTools: ['bash'] },
      { disallowedTools: [] },
      { disallowedTools: ['web_fetch'] },
    ]) {
      await expect(collect(adapter.run('control', options))).rejects.toThrow(
        'cannot enforce explicit allowedTools or disallowedTools',
      );
    }
    expect(loads).toBe(0);
  });

  it('passes auto-review config to the Codex SDK constructor for auto mode', async () => {
    let capturedCodexOptions: MockCodexConstructorOptions | undefined;
    let capturedThreadOptions: MockThreadOptions | undefined;

    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
        onConstruct(options) {
          capturedCodexOptions = options;
        },
        onStartThread(options) {
          capturedThreadOptions = options;
        },
      }),
    });

    await collect(
      adapter.run('implement feature', {
        permissions: { mode: 'auto' },
      }),
    );

    expect(capturedCodexOptions).toMatchObject({
      config: {
        default_permissions: ':workspace',
        approvals_reviewer: 'auto_review',
      },
    });
    expect(capturedCodexOptions?.codexPathOverride).toBeDefined();
    expect(capturedThreadOptions).toMatchObject({
      approvalPolicy: 'on-request',
    });
    expect(capturedThreadOptions).not.toHaveProperty('sandboxMode');
    expect(capturedThreadOptions).not.toHaveProperty('networkAccessEnabled');
  });

  it('sets danger-full-access default_permissions without auto-review for bypass mode', async () => {
    let capturedCodexOptions: MockCodexConstructorOptions | undefined;
    let capturedThreadOptions: MockThreadOptions | undefined;

    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
        onConstruct(options) {
          capturedCodexOptions = options;
        },
        onStartThread(options) {
          capturedThreadOptions = options;
        },
      }),
    });

    await collect(
      adapter.run('implement feature', {
        permissions: { mode: 'bypass' },
      }),
    );

    expect(capturedCodexOptions).toMatchObject({
      config: {
        default_permissions: ':danger-full-access',
      },
    });
    expect(capturedCodexOptions?.codexPathOverride).toBeDefined();
    expect(capturedThreadOptions).toMatchObject({
      approvalPolicy: 'never',
    });
    expect(capturedThreadOptions).not.toHaveProperty('sandboxMode');
    expect(capturedThreadOptions).not.toHaveProperty('networkAccessEnabled');
  });

  it('resumes thread when resume option is provided', async () => {
    let startThreadCalled = false;
    let resumeThreadCalledWith: string | undefined;

    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
        onStartThread() {
          startThreadCalled = true;
        },
        onResumeThread(threadId) {
          resumeThreadCalledWith = threadId;
        },
      }),
    });

    await collect(
      adapter.run('continue', {
        resume: 'thread-xyz',
      }),
    );

    expect(startThreadCalled).toBe(false);
    expect(resumeThreadCalledWith).toBe('thread-xyz');
  });

  it('treats an empty resume value as a fresh thread', async () => {
    let startThreadCalled = false;
    let resumeThreadCalled = false;
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            item: { id: 'before-id', type: 'agent_message', text: 'hello' },
          },
          { type: 'thread.started', thread_id: 'empty-resume-thread' },
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 5, output_tokens: 2 },
            },
          },
        ],
        onStartThread() {
          startThreadCalled = true;
        },
        onResumeThread() {
          resumeThreadCalled = true;
        },
      }),
    });

    const events = await collect(adapter.run('start fresh', { resume: '' }));

    expect(startThreadCalled).toBe(true);
    expect(resumeThreadCalled).toBe(false);
    expect(events[0]?.sessionId).toBeTruthy();
    expect(events[0]?.sessionId).not.toBe('');
    expect(events[1]?.sessionId).toBe(events[0]?.sessionId);
    expect(events.at(-1)?.sessionId).toBe('empty-resume-thread');
    expect(donePayload(events.at(-1)!).usage.tokens?.totals.input.total).toBe(
      5,
    );
  });

  it('throws when resume is requested but SDK lacks resumeThread', async () => {
    const adapter = new CodexAdapter({
      loadSdk: async () => ({
        Codex: class {
          startThread(): MockCodexThread {
            return {
              async runStreamed(): Promise<{ events: AsyncIterable<unknown> }> {
                return {
                  events: {
                    async *[Symbol.asyncIterator](): AsyncGenerator<
                      unknown,
                      void,
                      void
                    > {},
                  },
                };
              },
            };
          }
        },
      }),
    });

    const stream = adapter.run('continue', { resume: 'thread-missing' });
    await expect(stream.next()).rejects.toThrow(
      'Codex SDK does not support resumeThread() in this version',
    );
  });

  it('propagates AbortSignal and emits interrupted done when aborted', async () => {
    const externalAbort = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    const adapter = new CodexAdapter({
      loadSdk: async () => ({
        Codex: class {
          startThread(_options?: MockThreadOptions): MockCodexThread {
            return {
              async runStreamed(
                _prompt: string,
                runOptions?: MockRunOptions,
              ): Promise<{ events: AsyncIterable<unknown> }> {
                capturedSignal = runOptions?.signal;
                return {
                  events: {
                    async *[Symbol.asyncIterator](): AsyncGenerator<
                      unknown,
                      void,
                      void
                    > {
                      yield {
                        type: 'item.completed',
                        item: {
                          id: 'item_msg',
                          type: 'agent_message',
                          text: 'started',
                        },
                      };
                      yield {
                        type: 'item.completed',
                        item: canonicalCommandCompleted,
                      };

                      await new Promise<void>((resolve) => {
                        if (runOptions?.signal?.aborted) {
                          resolve();
                          return;
                        }
                        runOptions?.signal?.addEventListener(
                          'abort',
                          () => resolve(),
                          {
                            once: true,
                          },
                        );
                      });
                    },
                  },
                };
              },
            };
          }
        },
      }),
    });

    const stream = adapter.run('prompt', { abortSignal: externalAbort.signal });

    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe('init');

    const second = await stream.next();
    expect(second.done).toBe(false);
    expect(second.value?.type).toBe('text');

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    externalAbort.abort();

    expect(capturedSignal?.aborted).toBe(true);

    const rest = await collect(stream);
    expect(rest.map((event) => event.type)).toEqual([
      'tool_use',
      'tool_result',
      'done',
    ]);
    const done = donePayload(rest[2]);
    expect(done.status).toBe('interrupted');
    // The interrupted done also reports the tools observed before abort.
    expect(done.usage.toolUses).toBe(1);
  });

  it('sets interrupted resumeToken from backend id, inbound resume, or omission', async () => {
    async function interruptedResumeToken(options: {
      backendThreadId?: string;
      resume?: string;
    }): Promise<string | undefined> {
      const externalAbort = new AbortController();
      const makeThread = (): MockCodexThread => ({
        async runStreamed(
          _prompt: string,
          runOptions?: MockRunOptions,
        ): Promise<{ events: AsyncIterable<unknown> }> {
          return {
            events: {
              async *[Symbol.asyncIterator](): AsyncGenerator<
                unknown,
                void,
                void
              > {
                yield {
                  type: 'item.completed',
                  item: {
                    id: 'item_msg',
                    type: 'agent_message',
                    text: 'started',
                  },
                  ...(options.backendThreadId
                    ? { threadId: options.backendThreadId }
                    : {}),
                };

                await new Promise<void>((resolve) => {
                  if (runOptions?.signal?.aborted) {
                    resolve();
                    return;
                  }
                  runOptions?.signal?.addEventListener(
                    'abort',
                    () => resolve(),
                    {
                      once: true,
                    },
                  );
                });
              },
            },
          };
        },
      });

      const adapter = new CodexAdapter({
        loadSdk: async () => ({
          Codex: class {
            startThread(_options?: MockThreadOptions): MockCodexThread {
              return makeThread();
            }

            resumeThread(
              threadId: string,
              _options?: MockThreadOptions,
            ): MockCodexThread {
              expect(threadId).toBe(options.resume);
              return makeThread();
            }
          },
        }),
      });

      const stream = adapter.run('prompt', {
        abortSignal: externalAbort.signal,
        ...(options.resume ? { resume: options.resume } : {}),
      });
      const first = await stream.next();
      expect(first.done).toBe(false);
      expect(first.value?.type).toBe('init');

      externalAbort.abort();

      const rest = await collect(stream);
      const done = rest.find((event) => event.type === 'done') as AgentEvent & {
        payload: { status: string; resumeToken?: string };
      };
      expect(done.payload.status).toBe('interrupted');
      return done.payload.resumeToken;
    }

    await expect(
      interruptedResumeToken({ backendThreadId: 'thread-abort-new' }),
    ).resolves.toBe('thread-abort-new');
    await expect(
      interruptedResumeToken({ resume: 'thread-abort-resume' }),
    ).resolves.toBe('thread-abort-resume');
    await expect(interruptedResumeToken({})).resolves.toBeUndefined();
  });

  it('builds mapped options helper with synced abort signal wiring', () => {
    const externalAbort = new AbortController();
    const mapped = mapAgentOptionsToCodexOptions({
      abortSignal: externalAbort.signal,
      permissions: {
        fileWrite: 'allow',
        shellExecute: 'allow',
        networkAccess: 'allow',
      },
    });

    expect(mapped.codexOptions).toEqual({
      config: {
        default_permissions: ':danger-full-access',
      },
    });
    expect(mapped.threadOptions.approvalPolicy).toBe('never');
    expect(mapped.threadOptions).not.toHaveProperty('sandboxMode');
    expect(mapped.threadOptions).not.toHaveProperty('networkAccessEnabled');

    expect(mapped.runOptions.signal).toBeDefined();

    externalAbort.abort();

    expect(mapped.runOptions.signal?.aborted).toBe(true);

    mapped.cleanupAbort();
  });

  it('sets skipGitRepoCheck so the SDK accepts non-git working directories', () => {
    // Asserted even with no cwd: programmatic callers (tmux-play) choose
    // workingDirectory deliberately and frequently target tmpdirs.
    const mapped = mapAgentOptionsToCodexOptions({});
    expect(mapped.threadOptions.skipGitRepoCheck).toBe(true);

    const mappedWithCwd = mapAgentOptionsToCodexOptions({
      cwd: '/tmp/elsewhere',
    });
    expect(mappedWithCwd.threadOptions.workingDirectory).toBe('/tmp/elsewhere');
    expect(mappedWithCwd.threadOptions.skipGitRepoCheck).toBe(true);
  });

  it('supplies managed runs with non-persisted project trust', () => {
    const projectRoot = process.cwd();
    const cwd = join(projectRoot, 'src', 'adapters');
    const unmanaged = mapAgentOptionsToCodexOptions({ cwd });
    const managed = mapAgentOptionsToCodexOptions({
      cwd,
      permissions: { mode: 'auto' },
    });
    const emptyManaged = mapAgentOptionsToCodexOptions({
      cwd,
      permissions: {},
    });
    const readOnlyManaged = mapAgentOptionsToCodexOptions({
      cwd,
      permissions: { fileWrite: 'deny' },
    });
    const noCwdManaged = mapAgentOptionsToCodexOptions({ permissions: {} });
    const emptyCwdManaged = mapAgentOptionsToCodexOptions({
      cwd: '',
      permissions: {},
    });

    expect(unmanaged.codexCliConfigOverrides).toBeUndefined();
    expect(managed.codexCliExecArgs).toEqual(['--ignore-user-config']);
    expect(managed.codexCliConfigOverrides).toEqual([
      `projects={${JSON.stringify(projectRoot)}={trust_level="trusted"}}`,
    ]);
    expect(emptyManaged.codexCliExecArgs).toEqual(['--ignore-user-config']);
    expect(emptyManaged.codexCliConfigOverrides).toEqual(
      managed.codexCliConfigOverrides,
    );
    expect(readOnlyManaged.codexCliExecArgs).toEqual(['--ignore-user-config']);
    expect(readOnlyManaged.codexCliConfigOverrides).toBeUndefined();
    expect(noCwdManaged.codexCliConfigOverrides).toBeUndefined();
    expect(emptyCwdManaged.codexCliConfigOverrides).toBeUndefined();

    const managedWritable = mapAgentOptionsToCodexOptions({
      cwd,
      permissions: { mode: 'auto', writablePaths: ['.git'] },
    });
    expect(managedWritable.codexCliConfigOverrides).toEqual([
      `projects={${JSON.stringify(projectRoot)}={trust_level="trusted"}}`,
      'permissions.cligent-workspace-extra-writes={extends=":workspace", filesystem={":workspace_roots"={".git"="write"}}}',
    ]);
  });

  it('matches Codex Windows device-path simplification', () => {
    expect(
      normalizeCodexWindowsDevicePath(
        String.raw`\\?\D:\c\x\worktrees\2508\swift-base`,
      ),
    ).toBe(String.raw`D:\c\x\worktrees\2508\swift-base`);
    expect(
      normalizeCodexWindowsDevicePath(
        String.raw`\\.\D:\c\x\worktrees\2508\swift-base`,
      ),
    ).toBe(String.raw`D:\c\x\worktrees\2508\swift-base`);
    expect(
      normalizeCodexWindowsDevicePath(
        String.raw`\\?\UNC\server\share\workspace`,
      ),
    ).toBe(String.raw`\\server\share\workspace`);
    expect(
      normalizeCodexWindowsDevicePath(
        String.raw`\\.\UNC\server\share\workspace`,
      ),
    ).toBe(String.raw`\\server\share\workspace`);
    expect(
      normalizeCodexWindowsDevicePath(String.raw`\\?\GLOBALROOT\Device`),
    ).toBe(String.raw`\\?\GLOBALROOT\Device`);
  });

  it('matches Codex project roots through symlinks and non-git fallbacks', () => {
    const root = mkdtempSync(join(tmpdir(), 'cligent-codex-trust-'));
    const repository = join(root, 'repository.with.dots');
    const nested = join(repository, 'nested');
    const repositoryLink = join(root, 'repository-link');
    const looseWorkspace = join(root, 'loose-workspace');
    mkdirSync(join(repository, '.git'), { recursive: true });
    mkdirSync(nested);
    mkdirSync(looseWorkspace);
    symlinkSync(
      repository,
      repositoryLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    try {
      const linked = mapAgentOptionsToCodexOptions({
        cwd: join(repositoryLink, 'nested'),
        permissions: {},
      });
      const loose = mapAgentOptionsToCodexOptions({
        cwd: looseWorkspace,
        permissions: {},
      });

      expect(linked.codexCliConfigOverrides).toEqual([
        `projects={${JSON.stringify(repositoryLink)}={trust_level="trusted"}}`,
      ]);
      expect(loose.codexCliConfigOverrides).toEqual([
        `projects={${JSON.stringify(looseWorkspace)}={trust_level="trusted"}}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('matches Codex trust roots for linked worktrees and malformed git files', () => {
    const root = mkdtempSync(join(tmpdir(), 'cligent-codex-worktree-trust-'));
    const repository = join(root, 'repository');
    const worktree = join(root, 'worktree');
    const worktreeNested = join(worktree, 'nested');
    const malformedWorktree = join(root, 'malformed-worktree');
    const malformedNested = join(malformedWorktree, 'nested');
    const bomWorktree = join(root, 'bom-worktree');
    const bomNested = join(bomWorktree, 'nested');
    const nelWorktree = join(root, 'nel-worktree');
    const nelNested = join(nelWorktree, 'nested');
    const invalidUtf8Worktree = join(root, 'invalid-utf8-worktree');
    const invalidUtf8Nested = join(invalidUtf8Worktree, 'nested');
    const worktreeGitDir = join(repository, '.git', 'worktrees', 'feature');
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(worktreeNested, { recursive: true });
    mkdirSync(malformedNested, { recursive: true });
    mkdirSync(bomNested, { recursive: true });
    mkdirSync(nelNested, { recursive: true });
    mkdirSync(invalidUtf8Nested, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(join(malformedWorktree, '.git'), 'not-a-gitdir\n');
    writeFileSync(
      join(bomWorktree, '.git'),
      `\uFEFFgitdir: ${worktreeGitDir}\n`,
    );
    writeFileSync(
      join(nelWorktree, '.git'),
      `\u0085gitdir: ${worktreeGitDir}\u0085`,
    );
    writeFileSync(
      join(invalidUtf8Worktree, '.git'),
      Buffer.concat([
        Buffer.from([0xff]),
        Buffer.from(`gitdir: ${worktreeGitDir}\n`),
      ]),
    );

    try {
      const linked = mapAgentOptionsToCodexOptions({
        cwd: worktreeNested,
        permissions: {},
      });
      const malformed = mapAgentOptionsToCodexOptions({
        cwd: malformedNested,
        permissions: {},
      });
      const bom = mapAgentOptionsToCodexOptions({
        cwd: bomNested,
        permissions: {},
      });
      const nel = mapAgentOptionsToCodexOptions({
        cwd: nelNested,
        permissions: {},
      });
      const invalidUtf8 = mapAgentOptionsToCodexOptions({
        cwd: invalidUtf8Nested,
        permissions: {},
      });

      expect(linked.codexCliConfigOverrides).toEqual([
        `projects={${JSON.stringify(repository)}={trust_level="trusted"}}`,
      ]);
      expect(malformed.codexCliConfigOverrides).toEqual([
        `projects={${JSON.stringify(malformedNested)}={trust_level="trusted"}}`,
      ]);
      expect(bom.codexCliConfigOverrides).toEqual([
        `projects={${JSON.stringify(bomNested)}={trust_level="trusted"}}`,
      ]);
      expect(nel.codexCliConfigOverrides).toEqual([
        `projects={${JSON.stringify(repository)}={trust_level="trusted"}}`,
      ]);
      expect(invalidUtf8.codexCliConfigOverrides).toEqual([
        `projects={${JSON.stringify(invalidUtf8Nested)}={trust_level="trusted"}}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [undefined, undefined, undefined],
    ['minimal', 'minimal', undefined],
    ['low', 'low', undefined],
    ['medium', 'medium', undefined],
    ['high', 'high', undefined],
    ['xhigh', 'xhigh', undefined],
    ['max', undefined, 'max'],
    ['ultra', undefined, 'ultra'],
  ] satisfies Array<
    [CodexEffort | undefined, string | undefined, string | undefined]
  >)(
    'maps Codex effort %s to its supported SDK transport',
    (effort, threadEffort, configEffort) => {
      expect(mapEffortToCodexEffort(effort)).toBe(effort);
      const mapped = mapAgentOptionsToCodexOptions(
        effort === undefined ? {} : { effort },
      );

      if (threadEffort === undefined) {
        expect(mapped.threadOptions).not.toHaveProperty('modelReasoningEffort');
      } else {
        expect(mapped.threadOptions.modelReasoningEffort).toBe(threadEffort);
      }
      expect(mapped.codexOptions?.config?.model_reasoning_effort).toBe(
        configEffort,
      );
    },
  );

  it('keeps permission controls unchanged while adding ultra config', () => {
    const permissions: PermissionPolicy = {
      mode: 'auto',
      writablePaths: ['.git'],
    };
    const ordinary = mapAgentOptionsToCodexOptions({ permissions });
    const ultra = mapAgentOptionsToCodexOptions({
      permissions,
      effort: 'ultra',
    });

    expect(ultra.threadOptions.approvalPolicy).toBe(
      ordinary.threadOptions.approvalPolicy,
    );
    expect(ultra.codexCliExecArgs).toEqual(ordinary.codexCliExecArgs);
    expect(ultra.codexCliConfigOverrides).toEqual(
      ordinary.codexCliConfigOverrides,
    );
    expect(ultra.codexOptions?.config).toEqual({
      ...ordinary.codexOptions?.config,
      model_reasoning_effort: 'ultra',
    });
  });

  it('merges fast mode with permission, isolation, and effort configuration at the SDK boundary (codex-57)', async () => {
    const fastModes = [undefined, true, false] as const;
    const efforts = ['high', 'max', 'ultra'] as const;

    for (const fastMode of fastModes) {
      for (const isolated of [false, true]) {
        for (const effort of efforts) {
          let constructorOptions: MockCodexConstructorOptions | undefined;
          let threadOptions: MockThreadOptions | undefined;
          const adapter = new CodexAdapter({
            loadSdk: makeLoader({
              events: [
                {
                  type: 'turn.completed',
                  turn: {
                    status: 'success',
                    usage: { input_tokens: 1, output_tokens: 1 },
                  },
                },
              ],
              onConstruct: (options) => {
                constructorOptions = options;
              },
              onStartThread: (options) => {
                threadOptions = options;
              },
            }),
          });

          await collect(
            adapter.run('prompt', {
              effort,
              ...(fastMode === undefined ? {} : { fastMode }),
              ...(isolated ? { permissions: { mode: 'auto' as const } } : {}),
            }),
          );

          const expectedConfig: Record<string, unknown> = {
            ...(isolated
              ? {
                  default_permissions: ':workspace',
                  approvals_reviewer: 'auto_review',
                }
              : {}),
            ...(effort === 'max' || effort === 'ultra'
              ? { model_reasoning_effort: effort }
              : {}),
            ...(fastMode === undefined
              ? {}
              : {
                  service_tier: fastMode ? 'fast' : 'default',
                  features: { fast_mode: true },
                }),
          };

          expect(constructorOptions?.config).toEqual(
            Object.keys(expectedConfig).length > 0 ? expectedConfig : undefined,
          );
          expect(constructorOptions?.codexPathOverride === undefined).toBe(
            !isolated,
          );
          expect(threadOptions?.modelReasoningEffort).toBe(
            effort === 'high' ? 'high' : undefined,
          );
        }
      }
    }
  });

  it('omits fast-mode observations after every Codex terminal outcome (codex-58)', async () => {
    const outcomes = [
      {
        name: 'completion',
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ],
      },
      {
        name: 'failure',
        events: [
          {
            type: 'turn.failed',
            error: { code: 'refused', message: 'request refused' },
          },
        ],
      },
      { name: 'stream exhaustion', events: [] },
    ] as const;

    for (const fastMode of [undefined, true, false] as const) {
      for (const outcome of outcomes) {
        const adapter = new CodexAdapter({
          loadSdk: makeLoader({ events: [...outcome.events] }),
        });
        const events = await collect(
          adapter.run(
            `prompt for ${outcome.name}`,
            fastMode === undefined ? {} : { fastMode },
          ),
        );
        const init = events.find((event) => event.type === 'init');
        const done = events.find((event) => event.type === 'done');

        expect(init?.payload).not.toHaveProperty('fastMode');
        expect(done?.payload).not.toHaveProperty('fastMode');
      }
    }
  });

  it('rejects malformed fast mode before loading the Codex SDK', async () => {
    let loadCalls = 0;
    const loader = makeLoader({ events: [] });
    const adapter = new CodexAdapter({
      loadSdk: async () => {
        loadCalls += 1;
        return loader();
      },
    });
    const invalid = {
      fastMode: 'turbo',
    } as unknown as AgentOptions<CodexEffort, boolean>;

    expect(() => mapAgentOptionsToCodexOptions(invalid)).toThrow(
      'fastMode for adapter "codex" must be a boolean',
    );
    await expect(collect(adapter.run('prompt', invalid))).rejects.toThrow(
      'fastMode for adapter "codex" must be a boolean',
    );
    expect(loadCalls).toBe(0);
  });

  it('rejects Claude and unknown effort values before starting a thread', async () => {
    let startCalls = 0;
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [],
        onStartThread: () => {
          startCalls += 1;
        },
      }),
    });

    for (const effort of ['ultracode', 'future-effort']) {
      const invalid = { effort } as unknown as AgentOptions<CodexEffort>;
      await expect(collect(adapter.run('prompt', invalid))).rejects.toThrow(
        'effort for adapter "codex" must be one of: minimal, low, medium, high, xhigh, max, ultra',
      );
    }
    expect(startCalls).toBe(0);
  });

  it('forwards effort to startThread()', async () => {
    let captured: MockThreadOptions | undefined;

    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 1, output_tokens: 1, tool_uses: 0 },
            },
          },
        ],
        onStartThread: (options) => {
          captured = options;
        },
      }),
    });

    await collect(adapter.run('prompt', { effort: 'high' }));

    expect(captured?.modelReasoningEffort).toBe('high');
  });

  it('forwards ultra through the SDK constructor-options seam', async () => {
    let captured: MockCodexConstructorOptions | undefined;
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 1, output_tokens: 1, tool_uses: 0 },
            },
          },
        ],
        onConstruct: (options) => {
          captured = options;
        },
      }),
    });

    await collect(adapter.run('prompt', { effort: 'ultra' }));

    expect(captured?.config).toEqual({
      model_reasoning_effort: 'ultra',
    });
  });

  it('surfaces an upstream ultra rejection without substitution', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.failed',
            error: {
              code: 'unsupported_reasoning_effort',
              message: 'ultra is unavailable for this model or account',
            },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt', { effort: 'ultra' }));

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'codex:usage',
      'done',
    ]);
    expect(events[1]?.payload).toMatchObject({
      code: 'unsupported_reasoning_effort',
      message: 'ultra is unavailable for this model or account',
    });
    expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
  });

  it('throws descriptive error when Codex constructor fails', async () => {
    const adapter = new CodexAdapter({
      loadSdk: async () => ({
        Codex: class {
          constructor() {
            throw new Error('Unable to locate Codex CLI binaries');
          }

          startThread(): MockCodexThread {
            throw new Error('unreachable');
          }
        },
      }),
    });

    const stream = adapter.run('prompt');
    await expect(stream.next()).rejects.toThrow(
      'CodexAdapter failed to initialize: Unable to locate Codex CLI binaries',
    );
  });

  it('handles runStreamed returning a direct AsyncIterable without events wrapper', async () => {
    const adapter = new CodexAdapter({
      loadSdk: async () => ({
        Codex: class {
          startThread(): {
            runStreamed(
              prompt: string,
              options?: MockRunOptions,
            ): Promise<AsyncIterable<unknown>>;
          } {
            return {
              async runStreamed(): Promise<AsyncIterable<unknown>> {
                return {
                  async *[Symbol.asyncIterator](): AsyncGenerator<
                    unknown,
                    void,
                    void
                  > {
                    yield {
                      type: 'item.completed',
                      item: { type: 'message', text: 'direct iterable' },
                    };
                    yield {
                      type: 'turn.completed',
                      turn: {
                        status: 'success',
                        usage: {
                          input_tokens: 1,
                          output_tokens: 2,
                          tool_uses: 0,
                        },
                      },
                    };
                  },
                };
              },
            };
          }
        },
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((e) => e.type)).toEqual([
      'init',
      'text',
      'codex:usage',
      'done',
    ]);

    const text = events[1] as AgentEvent & { payload: { content: string } };
    expect(text.payload.content).toBe('direct iterable');

    const done = events.at(-1) as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('success');
  });

  it('sets resumeToken on done when backend provides a new thread ID', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            item: { id: 'item_msg', type: 'agent_message', text: 'hello' },
            threadId: 'thread-new-abc',
          },
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              result: 'done',
              usage: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
              durationMs: 100,
            },
            threadId: 'thread-new-abc',
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as { resumeToken?: string };
    expect(payload.resumeToken).toBe('thread-new-abc');
  });

  it('omits resumeToken when backend provides no thread ID', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              result: 'done',
              usage: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
              durationMs: 100,
            },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as { resumeToken?: string };
    expect(payload.resumeToken).toBeUndefined();
  });

  it('validates canonical cache subsets without double-counting inclusive input', async () => {
    const sdkUsage = {
      input_tokens: 120,
      cached_input_tokens: 80,
      cache_write_input_tokens: 30,
      output_tokens: 20,
      reasoning_output_tokens: 5,
    } satisfies CodexUsage;
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            usage: sdkUsage,
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const usage = donePayload(done).usage;
    expect(usage.tokens).toEqual({
      coverage: 'partial',
      totals: {
        input: {
          total: 120,
          uncached: 10,
          cacheRead: 80,
          cacheWrite: 30,
        },
        output: { total: 20, visible: 15, reasoning: 5 },
      },
    });
  });

  it.each([
    ['negative input', { input_tokens: -1, output_tokens: 2 }],
    ['fractional output', { input_tokens: 1, output_tokens: 2.5 }],
    [
      'invalid cached-input subset',
      {
        input_tokens: 3,
        output_tokens: 2,
        cached_input_tokens: '1',
      },
    ],
    [
      'invalid cache-write subset',
      {
        input_tokens: 3,
        output_tokens: 2,
        cache_write_input_tokens: -1,
      },
    ],
    [
      'invalid reasoning-output subset',
      {
        input_tokens: 3,
        output_tokens: 2,
        reasoning_output_tokens: 0.5,
      },
    ],
  ])('omits tokens for %s accounting', async (_case, rawUsage) => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [{ type: 'turn.completed', usage: rawUsage }],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(donePayload(events.at(-1)!).usage.tokens).toBeUndefined();
  });

  it('maps PermissionPolicy.mode to Codex approval axis and default_permissions per engine-52', () => {
    const auto = mapPermissionsToCodexOptions({ mode: 'auto' });
    expect(auto.approvalPolicy).toBe('on-request');
    expect(auto.codexOptions).toEqual({
      config: {
        default_permissions: ':workspace',
        approvals_reviewer: 'auto_review',
      },
    });
    expect(auto.codexCliExecArgs).toEqual(['--ignore-user-config']);
    expect(auto).not.toHaveProperty('sandboxMode');
    expect(auto).not.toHaveProperty('networkAccessEnabled');

    const autoAllAllow = mapPermissionsToCodexOptions({
      mode: 'auto',
      fileWrite: 'allow',
      shellExecute: 'allow',
      networkAccess: 'allow',
    });
    expect(autoAllAllow.approvalPolicy).toBe('on-request');
    expect(autoAllAllow.codexOptions).toEqual({
      config: {
        default_permissions: ':danger-full-access',
        approvals_reviewer: 'auto_review',
      },
    });

    const bypass = mapPermissionsToCodexOptions({ mode: 'bypass' });
    expect(bypass.approvalPolicy).toBe('never');
    expect(bypass.codexOptions).toEqual({
      config: {
        default_permissions: ':danger-full-access',
      },
    });
    expect(bypass).not.toHaveProperty('sandboxMode');
    expect(bypass).not.toHaveProperty('networkAccessEnabled');

    // Codex models automation and local access independently: auto still
    // selects auto-review, while denied file/shell access narrows the profile.
    const autoNarrowsLocalAccess = mapPermissionsToCodexOptions({
      mode: 'auto',
      fileWrite: 'deny',
      shellExecute: 'deny',
      networkAccess: 'allow',
    });
    expect(autoNarrowsLocalAccess.approvalPolicy).toBe('on-request');
    expect(autoNarrowsLocalAccess.codexOptions).toEqual({
      config: {
        default_permissions: ':read-only',
        approvals_reviewer: 'auto_review',
      },
    });
    expect(autoNarrowsLocalAccess).not.toHaveProperty('sandboxMode');
    expect(autoNarrowsLocalAccess).not.toHaveProperty('networkAccessEnabled');
  });
});

describe('resolveCodexBinPath', () => {
  interface ResolutionTree {
    root: string;
    baseRequire: NodeJS.Require;
    sdkEntry?: string;
    sdkOwnedBin?: string;
    topLevelBin?: string;
  }

  function writeCodexPackage(directory: string, marker: string): string {
    mkdirSync(join(directory, 'bin'), { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: '@openai/codex',
        version: '0.0.0-test',
        bin: { codex: 'bin/codex.js' },
      }),
      'utf8',
    );
    const binPath = join(directory, 'bin', 'codex.js');
    writeFileSync(binPath, `// ${marker}\n`, 'utf8');
    return binPath;
  }

  function makeResolutionTree(shape: {
    sdk?: boolean;
    sdkOwnedCodex?: boolean;
    topLevelCodex?: boolean;
  }): ResolutionTree {
    const root = mkdtempSync(join(tmpdir(), 'cligent-codex-resolution-'));
    const nodeModules = join(root, 'node_modules');
    mkdirSync(nodeModules, { recursive: true });

    const tree: ResolutionTree = {
      root,
      baseRequire: createRequire(join(root, 'resolution-probe.mjs')),
    };

    if (shape.sdk) {
      const sdkDirectory = join(nodeModules, '@openai', 'codex-sdk');
      mkdirSync(join(sdkDirectory, 'dist'), { recursive: true });
      writeFileSync(
        join(sdkDirectory, 'package.json'),
        JSON.stringify({
          name: '@openai/codex-sdk',
          version: '0.0.0-test',
          type: 'module',
          exports: { '.': { import: './dist/index.js' } },
          dependencies: { '@openai/codex': '0.0.0-test' },
        }),
        'utf8',
      );
      tree.sdkEntry = join(sdkDirectory, 'dist', 'index.js');
      writeFileSync(tree.sdkEntry, 'export {};\n', 'utf8');

      if (shape.sdkOwnedCodex) {
        tree.sdkOwnedBin = writeCodexPackage(
          join(sdkDirectory, 'node_modules', '@openai', 'codex'),
          'sdk-owned codex entry',
        );
      }
    }

    if (shape.topLevelCodex) {
      tree.topLevelBin = writeCodexPackage(
        join(nodeModules, '@openai', 'codex'),
        'top-level codex entry',
      );
    }

    return tree;
  }

  function withTree<T>(
    shape: Parameters<typeof makeResolutionTree>[0],
    body: (tree: ResolutionTree) => T,
  ): T {
    const tree = makeResolutionTree(shape);
    try {
      return body(tree);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  }

  it('resolves the SDK-owned entry from search paths without loader resolution', () => {
    withTree({ sdk: true, sdkOwnedCodex: true }, (tree) => {
      const resolved = resolveCodexBinPath({
        baseRequire: tree.baseRequire,
        importMetaResolve: undefined,
      });
      expect(resolved).toBe(realpathSync(tree.sdkOwnedBin ?? ''));
      expect(readFileSync(resolved, 'utf8')).toContain('sdk-owned codex entry');
    });
  });

  it('resolves the SDK-owned entry through loader resolution alone', () => {
    withTree({ sdk: true, sdkOwnedCodex: true }, (tree) => {
      const detachedRoot = mkdtempSync(
        join(tmpdir(), 'cligent-codex-detached-'),
      );
      try {
        const resolved = resolveCodexBinPath({
          baseRequire: createRequire(join(detachedRoot, 'probe.mjs')),
          importMetaResolve: () => pathToFileURL(tree.sdkEntry ?? '').href,
        });
        expect(resolved).toBe(realpathSync(tree.sdkOwnedBin ?? ''));
      } finally {
        rmSync(detachedRoot, { recursive: true, force: true });
      }
    });
  });

  it('prefers the SDK-owned entry over an independently installed copy', () => {
    withTree(
      { sdk: true, sdkOwnedCodex: true, topLevelCodex: true },
      (tree) => {
        const resolved = resolveCodexBinPath({
          baseRequire: tree.baseRequire,
          importMetaResolve: undefined,
        });
        expect(resolved).toBe(realpathSync(tree.sdkOwnedBin ?? ''));
        expect(readFileSync(resolved, 'utf8')).toContain(
          'sdk-owned codex entry',
        );
      },
    );
  });

  it('resolves a hoisted install through the SDK anchor walk-up', () => {
    withTree({ sdk: true, topLevelCodex: true }, (tree) => {
      const resolved = resolveCodexBinPath({
        baseRequire: tree.baseRequire,
        importMetaResolve: undefined,
      });
      expect(resolved).toBe(realpathSync(tree.topLevelBin ?? ''));
    });
  });

  it('falls back to the adapter module scope when the SDK is absent', () => {
    withTree({ topLevelCodex: true }, (tree) => {
      const resolved = resolveCodexBinPath({
        baseRequire: tree.baseRequire,
        importMetaResolve: undefined,
      });
      expect(resolved).toBe(realpathSync(tree.topLevelBin ?? ''));
    });
  });

  it('skips a non-file loader resolution and still resolves via search paths', () => {
    withTree({ sdk: true, sdkOwnedCodex: true }, (tree) => {
      const resolved = resolveCodexBinPath({
        baseRequire: tree.baseRequire,
        importMetaResolve: () => 'node:fs',
      });
      expect(resolved).toBe(realpathSync(tree.sdkOwnedBin ?? ''));
    });
  });

  it('survives a throwing loader resolution', () => {
    withTree({ sdk: true, sdkOwnedCodex: true }, (tree) => {
      const resolved = resolveCodexBinPath({
        baseRequire: tree.baseRequire,
        importMetaResolve: () => {
          throw new Error('loader offline');
        },
      });
      expect(resolved).toBe(realpathSync(tree.sdkOwnedBin ?? ''));
    });
  });

  it('raises the ownership diagnostic naming attempts and repair', () => {
    withTree({}, (tree) => {
      let failure: Error | undefined;
      try {
        resolveCodexBinPath({
          baseRequire: tree.baseRequire,
          importMetaResolve: () => {
            throw new Error('loader cannot find @openai/codex-sdk');
          },
        });
      } catch (error) {
        failure = error as Error;
      }

      expect(failure).toBeDefined();
      const message = failure?.message ?? '';
      expect(message).toContain("'@openai/codex/bin/codex.js'");
      expect(message).toContain("'@openai/codex-sdk'");
      expect(message).toContain('Attempted:');
      expect(message).toContain('loader cannot find @openai/codex-sdk');
      expect(message).toContain('no @openai/codex-sdk package manifest');
      expect(message).toContain('cligent module scope:');
      expect(message).toContain('npm install -g @openai/codex-sdk');
      expect((failure as NodeJS.ErrnoException | undefined)?.code).toBe(
        'MODULE_NOT_FOUND',
      );
    });
  });

  it('does not consult the ambient loader when a base scope is injected', () => {
    withTree({ topLevelCodex: true }, (tree) => {
      const detachedRoot = mkdtempSync(join(tmpdir(), 'cligent-codex-scoped-'));
      try {
        // Injecting only baseRequire must scope resolution to that tree; the
        // repository's own SDK stays out of the result.
        expect(resolveCodexBinPath({ baseRequire: tree.baseRequire })).toBe(
          realpathSync(tree.topLevelBin ?? ''),
        );

        expect(() =>
          resolveCodexBinPath({
            baseRequire: createRequire(join(detachedRoot, 'probe.mjs')),
          }),
        ).toThrow("could not resolve '@openai/codex/bin/codex.js'");
      } finally {
        rmSync(detachedRoot, { recursive: true, force: true });
      }
    });
  });

  it('resolves the repository development tree with default dependencies', () => {
    const resolved = resolveCodexBinPath();
    expect(existsSync(resolved)).toBe(true);
    expect(resolved).toContain(join('@openai', 'codex', 'bin', 'codex.js'));
  });
});

// engine-85: even a structured stream failure may follow prompt execution.
it('does not promote a Codex turn failure to resume rejection', async () => {
  let calls = 0;
  const adapter = new CodexAdapter({
    loadSdk: makeLoader({
      events: [
        {
          type: 'turn.failed',
          error: {
            code: 'SESSION_RESUME_REJECTED',
            message: 'session not found',
            retryable: true,
          },
        },
      ],
      onRun() {
        calls++;
      },
    }),
  });
  const events = await collect(adapter.run('continue', { resume: 'saved' }));
  expect(events.find((event) => event.type === 'error')?.payload).toMatchObject(
    { code: 'SDK_STREAM_ERROR', message: 'session not found' },
  );
  expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  expect(calls).toBe(1);
});
