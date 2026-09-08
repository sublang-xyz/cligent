// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getEffortSupport } from './effort.js';
import {
  AGENT_RUNTIME_TARGETS,
  type AgentRuntimeName,
} from './runtime-targets.js';
import { assertRuntimeSupported } from './runtime-version.js';

export interface DiscoveredModel {
  readonly id: string;
  readonly name: string;
  /** Canonical model behind a provider alias, when reported. */
  readonly resolvedModel?: string;
  /** Known model choices this adapter transports; absent means unknown. */
  readonly effortValues?: readonly string[];
  readonly defaultEffort?: string;
  /** Model capability only; account entitlement can still differ. */
  readonly fastModeSupported?: boolean;
}

export type ModelDiscovery =
  | {
      readonly status: 'available';
      readonly models: readonly DiscoveredModel[];
    }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface ModelDiscoveryOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  /** Whole discovery deadline, default 10 seconds. */
  readonly timeoutMs?: number;
}

type ModelAdapter = AgentRuntimeName | 'claude-code';
type Row = Record<string, unknown>;
type Command = { executable: string; args: string[]; nodeEntry?: boolean };
interface ClaudeQuery {
  supportedModels?(): Promise<unknown>;
  close(): void;
}
interface DiscoveryDeps {
  checkRuntime?: (adapter: AgentRuntimeName) => void;
  claudeQuery?: (options: unknown) => ClaudeQuery | Promise<ClaudeQuery>;
  command?: (adapter: AgentRuntimeName) => Command | Promise<Command>;
}
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Provider-owned catalog; never validates or replaces a configured model. */
export function discoverAgentModels(
  adapter: ModelAdapter,
  options: ModelDiscoveryOptions = {},
): Promise<ModelDiscovery> {
  return discoverAgentModelsWithDeps(adapter, options);
}

/** Internal transport seams for hermetic integration coverage. */
export async function discoverAgentModelsWithDeps(
  input: ModelAdapter,
  options: ModelDiscoveryOptions = {},
  deps: DiscoveryDeps = {},
): Promise<ModelDiscovery> {
  const adapter = input === 'claude-code' ? 'claude' : input;
  if (!Object.hasOwn(AGENT_RUNTIME_TARGETS, adapter)) {
    return unavailable('Model discovery is unavailable for this adapter.');
  }
  if (adapter === 'gemini') {
    return unavailable(
      'Gemini CLI has no supported non-session model listing. Enter a model ID.',
    );
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return unavailable('Model discovery timeout must be positive.');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Model discovery cancelled.'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new Error('Model discovery timed out.')),
    timeoutMs,
  );
  const context = { ...options, signal: controller.signal };
  try {
    checkAbort(controller.signal);
    (deps.checkRuntime ?? checkRuntime)(adapter);
    let models: DiscoveredModel[];
    if (adapter === 'claude') {
      models = await discoverClaude(context, controller, deps);
    } else {
      const command = await abortable(
        Promise.resolve((deps.command ?? commandFor)(adapter)),
        controller.signal,
      );
      const process = new DiscoveryProcess(command, context);
      try {
        if (adapter === 'codex') {
          models = await discoverCodex(process, controller.signal);
        } else {
          const output = await process.output();
          models =
            adapter === 'kimi' ? kimiModels(output) : opencodeModels(output);
        }
      } finally {
        await process.close();
      }
    }
    checkAbort(controller.signal);
    return { status: 'available', models: uniqueModels(models) };
  } catch (error) {
    const cause = controller.signal.aborted ? controller.signal.reason : error;
    return unavailable(
      cause instanceof Error ? cause.message : 'Model discovery failed.',
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

function unavailable(reason: string): ModelDiscovery {
  return { status: 'unavailable', reason };
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
function row(value: unknown): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Malformed model catalog.');
  }
  return value as Row;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Malformed model catalog.');
  return value;
}
function uniqueModels(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Set<string>();
  return models.filter(({ id }) => !seen.has(id) && !!seen.add(id));
}
function efforts(adapter: ModelAdapter, values: unknown): string[] {
  const reported = list(values);
  if (reported.some((value) => typeof value !== 'string'))
    throw new Error('Malformed model effort choices.');
  const accepted = getEffortSupport(adapter)?.values ?? [];
  // Claude's minimal is its existing low alias, not a new provider tier.
  return accepted.filter((value) =>
    reported.includes(
      adapter === 'claude' && value === 'minimal' ? 'low' : value,
    ),
  );
}
function checkRuntime(adapter: AgentRuntimeName): void {
  // CLI-only listings report their own availability and honor the caller's PATH.
  if (adapter !== 'claude' && adapter !== 'codex') return;
  for (const target of AGENT_RUNTIME_TARGETS[adapter]) {
    assertRuntimeSupported(
      target,
      `npm install ${target.kind === 'cli' ? '-g ' : ''}${target.repairSpec}`,
    );
  }
}
async function commandFor(adapter: AgentRuntimeName): Promise<Command> {
  if (adapter === 'codex') {
    const { resolveCodexBinPath } = await import('./adapters/codex.js');
    return {
      executable: process.execPath,
      args: [resolveCodexBinPath(), 'app-server'],
      nodeEntry: true,
    };
  }
  return adapter === 'kimi'
    ? { executable: 'kimi', args: ['provider', 'list', '--json'] }
    : { executable: 'opencode', args: ['models'] };
}

async function discoverClaude(
  options: ModelDiscoveryOptions & { signal: AbortSignal },
  controller: AbortController,
  deps: DiscoveryDeps,
): Promise<DiscoveredModel[]> {
  let query: ClaudeQuery | undefined;
  let finishInput!: () => void;
  const inputFinished = new Promise<void>((resolve) => {
    finishInput = resolve;
  });
  // Keep stdin open for initialization but never deliver a user message.
  async function* input(): AsyncGenerator<never> {
    await inputFinished;
  }
  try {
    const createQuery =
      deps.claudeQuery ??
      (async (input: unknown) => {
        const sdk = await import('@anthropic-ai/claude-agent-sdk');
        checkAbort(options.signal);
        return sdk.query(
          input as Parameters<typeof sdk.query>[0],
        ) as unknown as ClaudeQuery;
      });
    // Do not race creation: a late SDK import must not leave an unowned query.
    const opening = Promise.resolve(
      createQuery({
        prompt: input(),
        options: {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          abortController: controller,
          persistSession: false,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          settings: { disableAllHooks: true },
          permissionMode: 'dontAsk',
        },
      }),
    );
    opening.then(
      (value) => {
        if (options.signal.aborted) value.close();
      },
      () => {},
    );
    query = await abortable(opening, options.signal);
    checkAbort(options.signal);
    if (typeof query.supportedModels !== 'function') {
      throw new Error('This Claude Agent SDK does not expose model discovery.');
    }
    const models = list(
      await abortable(query.supportedModels(), options.signal),
    );
    return models.map((value) => {
      const model = row(value);
      const id = text(model.value);
      if (!id) throw new Error('Malformed Claude model identifier.');
      const levels =
        model.supportsEffort === false
          ? []
          : model.supportedEffortLevels === undefined
            ? undefined
            : efforts('claude', model.supportedEffortLevels);
      return {
        id,
        name: text(model.displayName) ?? id,
        ...(text(model.resolvedModel)
          ? { resolvedModel: text(model.resolvedModel) }
          : {}),
        ...(levels === undefined ? {} : { effortValues: levels }),
        ...(typeof model.supportsFastMode === 'boolean'
          ? { fastModeSupported: model.supportsFastMode }
          : {}),
      };
    });
  } finally {
    finishInput();
    query?.close();
  }
}

async function discoverCodex(
  child: DiscoveryProcess,
  signal: AbortSignal,
): Promise<DiscoveredModel[]> {
  await child.request('initialize', {
    clientInfo: { name: 'cligent-models', version: '1' },
  });
  child.notify('initialized');
  const models: DiscoveredModel[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    checkAbort(signal);
    const result = row(
      await child.request('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      }),
    );
    for (const value of list(result.data)) {
      const model = row(value);
      if (model.hidden === true) continue;
      const id = text(model.model) ?? text(model.id);
      if (!id) throw new Error('Malformed Codex model identifier.');
      const levels =
        model.supportedReasoningEfforts === undefined
          ? undefined
          : efforts(
              'codex',
              list(model.supportedReasoningEfforts).map(
                (value) => row(value).reasoningEffort,
              ),
            );
      const speedTiers =
        model.additionalSpeedTiers === undefined
          ? undefined
          : list(model.additionalSpeedTiers);
      if (speedTiers?.some((value) => typeof value !== 'string')) {
        throw new Error('Malformed Codex speed tiers.');
      }
      const defaultEffort = text(model.defaultReasoningEffort);
      models.push({
        id,
        name: text(model.displayName) ?? id,
        ...(levels === undefined ? {} : { effortValues: levels }),
        ...(defaultEffort && levels?.includes(defaultEffort)
          ? { defaultEffort }
          : {}),
        ...(speedTiers === undefined
          ? {}
          : { fastModeSupported: speedTiers.includes('fast') }),
      });
    }
    cursor =
      result.nextCursor === null || result.nextCursor === undefined
        ? undefined
        : text(result.nextCursor);
    if (
      result.nextCursor !== null &&
      result.nextCursor !== undefined &&
      cursor === undefined
    )
      throw new Error('Malformed model catalog cursor.');
    if (cursor && (seenCursors.has(cursor) || seenCursors.size >= 100))
      throw new Error('Model catalog pagination did not finish.');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return models;
}
function kimiModels(output: string): DiscoveredModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // JSON syntax errors can quote credential-bearing provider output.
    throw new Error('Malformed Kimi model listing.');
  }
  const models = row(row(parsed).models);
  return Object.keys(models).map((id) => {
    if (!id.trim()) throw new Error('Malformed Kimi model identifier.');
    // providers contains credentials; only model alias keys leave this function.
    return { id, name: id };
  });
}
function opencodeModels(output: string): DiscoveredModel[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((id) => {
      if (!/^[^\s/]+\/\S+$/.test(id))
        throw new Error('Malformed OpenCode model listing.');
      return { id, name: id };
    });
}

/** One owned read-only metadata process, drained and retired on every outcome. */
class DiscoveryProcess {
  private child: ChildProcessWithoutNullStreams;
  private finished: Promise<void>;
  private finish!: () => void;
  private failure: Error | undefined;
  private stdout = '';
  private buffered = '';
  private bytes = 0;
  private id = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private abort: () => void;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private cleanupFailure: Error | undefined;
  private exited = false;

  constructor(
    command: Command,
    private options: ModelDiscoveryOptions & { signal: AbortSignal },
  ) {
    checkAbort(options.signal);
    this.child = spawn(command.executable, command.args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        // Electron's process.execPath needs Node mode for the SDK's JS entry.
        ...(command.nodeEntry ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.finished = new Promise((resolve) => {
      this.finish = resolve;
      this.child.on('error', (error) => {
        this.fail(error);
      });
      this.child.on('close', (code) => {
        this.exited = true;
        if (code !== 0 && !this.failure)
          this.fail(
            new Error(`Model listing process exited with code ${code}.`),
          );
        this.rejectPending(
          new Error('Model listing process closed before responding.'),
        );
        resolve();
      });
    });
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > MAX_OUTPUT_BYTES) {
        this.fail(new Error('Model catalog exceeded the output limit.'));
        return;
      }
      this.stdout += chunk;
      this.buffered += chunk;
      if (this.pending.size) this.parseReplies();
    });
    // Never include provider stderr/config output in a public error.
    this.child.stderr.resume();
    this.abort = () =>
      this.fail(
        options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error('Model discovery cancelled.'),
      );
    options.signal.addEventListener('abort', this.abort, { once: true });
    if (options.signal.aborted) this.abort();
  }
  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ method })}\n`);
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.exited)
      return Promise.reject(new Error('Model listing process is closed.'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      this.parseReplies();
    });
  }
  private parseReplies(): void {
    try {
      while (this.buffered.includes('\n')) {
        const end = this.buffered.indexOf('\n');
        const line = this.buffered.slice(0, end);
        this.buffered = this.buffered.slice(end + 1);
        if (!line.trim()) continue;
        const message = row(JSON.parse(line));
        const pending =
          typeof message.id === 'number'
            ? this.pending.get(message.id)
            : undefined;
        if (!pending) continue;
        this.pending.delete(message.id as number);
        if (message.error !== undefined)
          pending.reject(
            new Error('The installed Codex runtime refused model discovery.'),
          );
        else if (!Object.hasOwn(message, 'result'))
          pending.reject(new Error('Malformed Codex model response.'));
        else pending.resolve(message.result);
      }
    } catch {
      this.fail(new Error('Malformed Codex model response.'));
    }
  }
  async output(): Promise<string> {
    this.child.stdin.end();
    await this.finished;
    if (this.failure) throw this.failure;
    return this.stdout;
  }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private fail(error: Error): void {
    this.failure ??= error;
    this.rejectPending(this.failure);
    this.stop();
  }
  private signal(signal: NodeJS.Signals): void {
    if (this.exited || this.child.pid === undefined) return;
    try {
      if (process.platform !== 'win32') process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch {
      /* close/error owns the final outcome. */
    }
  }
  private stop(): void {
    if (this.exited || this.killTimer) return;
    this.child.stdin.end();
    this.signal('SIGTERM');
    this.killTimer = setTimeout(() => this.signal('SIGKILL'), 250);
    // A descendant can keep inherited pipes open after its launcher exits.
    // Bound both close() and output(), which await this same transport lifetime.
    this.cleanupTimer = setTimeout(() => {
      this.cleanupFailure = new Error('Model listing cleanup timed out.');
      this.failure ??= this.cleanupFailure;
      this.rejectPending(this.failure);
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.child.unref();
      this.finish();
    }, 500);
  }
  async close(): Promise<void> {
    this.stop();
    await this.finished;
    clearTimeout(this.killTimer);
    clearTimeout(this.cleanupTimer);
    this.options.signal.removeEventListener('abort', this.abort);
    if (this.cleanupFailure) throw this.cleanupFailure;
  }
}
