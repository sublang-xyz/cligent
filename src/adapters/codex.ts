// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { createEvent, generateSessionId } from '../events.js';
import { assertSupportedEffort } from '../effort.js';
import { assertBuiltInFastModeOption } from '../fast-mode.js';
import { mapWritablePathsPermission } from '../permissions.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  CodexEffort,
  DonePayload,
  PermissionPolicy,
  WritablePathsPermissionMapping,
} from '../types.js';
import {
  normalizeCodexWindowsDevicePath,
  trimCodexRustWhitespace,
} from './codex-path.js';
import { doneResumeTokenPayload } from './resume-token.js';
import { ordinaryErrorCode } from './session-resume.js';
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import {
  assertRuntimeSupported,
  isUnsupportedRuntimeError,
} from '../runtime-version.js';
import {
  buildTokenUsage,
  buildTokenUsageReport,
  exclusiveBase,
  isUsageRecord,
  readUsageCounter,
} from './usage.js';

type CodexApprovalPolicy = 'never' | 'untrusted' | 'on-request';
type CodexWorkspaceExtraWritesProfile = 'cligent-workspace-extra-writes';
type CodexDefaultPermissions =
  | ':danger-full-access'
  | ':workspace'
  | ':read-only'
  | CodexWorkspaceExtraWritesProfile;
type CodexModelReasoningEffort =
  'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue };

interface CodexConstructorOptions {
  codexPathOverride?: string;
  config?: {
    [key: string]: CodexConfigValue;
  };
  env?: Record<string, string>;
}

interface CodexItem {
  type?: unknown;
  role?: unknown;
  text?: unknown;
  content?: unknown;
  name?: unknown;
  toolName?: unknown;
  id?: unknown;
  toolUseId?: unknown;
  callId?: unknown;
  tool_call_id?: unknown;
  input?: unknown;
  arguments?: unknown;
  args?: unknown;
  status?: unknown;
  isError?: unknown;
  is_error?: unknown;
  output?: unknown;
  result?: unknown;
  durationMs?: unknown;
  duration_ms?: unknown;
  file?: unknown;
  path?: unknown;
  command?: unknown;
  aggregated_output?: unknown;
  exit_code?: unknown;
  server?: unknown;
  tool?: unknown;
  error?: unknown;
}

interface CodexThreadOptions {
  workingDirectory?: string;
  model?: string;
  modelReasoningEffort?: CodexModelReasoningEffort;
  approvalPolicy?: CodexApprovalPolicy;
  skipGitRepoCheck?: boolean;
}

interface CodexRunOptions {
  signal?: AbortSignal;
}

interface CodexThread {
  runStreamed?: (
    prompt: string,
    options?: CodexRunOptions,
  ) => Promise<{ events: AsyncIterable<unknown> }>;
}

interface CodexClient {
  startThread: (options?: CodexThreadOptions) => CodexThread;
  resumeThread?: (
    threadId: string,
    options?: CodexThreadOptions,
  ) => CodexThread;
}

interface CodexSdk {
  Codex: new (options?: CodexConstructorOptions) => CodexClient;
}

interface CodexAdapterDeps {
  loadSdk?: () => Promise<CodexSdk>;
}

const AGENT = 'codex' as const;
const CODEX_WORKSPACE_EXTRA_WRITES_PROFILE: CodexWorkspaceExtraWritesProfile =
  'cligent-workspace-extra-writes';
const requireFromHere = createRequire(import.meta.url);

const DEFAULT_DONE_USAGE: DonePayload['usage'] = {
  toolUses: 0,
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) {
      result.push(item);
      continue;
    }
    if (typeof item === 'object' && item !== null) {
      const named = asString((item as { name?: unknown }).name);
      if (named) result.push(named);
    }
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asErrorRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (Object.keys(record).length > 0) {
    return record;
  }

  const text = asString(value)?.trim();
  if (!text?.startsWith('{')) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function codexErrorMessage(value: unknown, depth = 0): string | undefined {
  const text = asString(value);
  if (text) {
    if (depth >= 3) {
      return text;
    }

    const parsed = asErrorRecord(text);
    if (Object.keys(parsed).length > 0) {
      return codexErrorMessage(parsed, depth + 1) ?? text;
    }
    return text;
  }

  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }

  return (
    codexErrorMessage(record.detail, depth + 1) ??
    codexErrorMessage(record.message, depth + 1) ??
    codexErrorMessage(record.error_description, depth + 1) ??
    codexErrorMessage(record.error, depth + 1)
  );
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export interface CodexPermissionOptions {
  approvalPolicy?: CodexApprovalPolicy;
  codexOptions?: CodexConstructorOptions;
  codexCliExecArgs?: string[];
  codexCliConfigOverrides?: string[];
  writablePaths?: WritablePathsPermissionMapping;
}

function codexDefaultPermissions(
  policy: PermissionPolicy,
): CodexDefaultPermissions {
  if (policy.mode === 'bypass') {
    return ':danger-full-access';
  }

  if (
    policy.fileWrite === 'allow' &&
    policy.shellExecute === 'allow' &&
    policy.networkAccess === 'allow'
  ) {
    return ':danger-full-access';
  }

  if (policy.fileWrite === 'deny' || policy.shellExecute === 'deny') {
    return ':read-only';
  }

  return ':workspace';
}

function codexApprovalPolicy(policy: PermissionPolicy): CodexApprovalPolicy {
  if (policy.mode === 'auto') {
    return 'on-request';
  }
  if (policy.mode === 'bypass') {
    return 'never';
  }

  if (
    policy.fileWrite === 'allow' &&
    policy.shellExecute === 'allow' &&
    policy.networkAccess === 'allow'
  ) {
    return 'never';
  }

  if (
    policy.fileWrite === 'ask' ||
    policy.shellExecute === 'ask' ||
    policy.networkAccess === 'ask'
  ) {
    return 'untrusted';
  }

  return 'on-request';
}

function codexTomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexWorkspaceExtraWritesProfileConfigOverride(
  paths: readonly string[],
): string {
  const rules = paths
    .map((path) => `${codexTomlString(path)}=${codexTomlString('write')}`)
    .join(', ');
  return (
    `permissions.${CODEX_WORKSPACE_EXTRA_WRITES_PROFILE}=` +
    `{extends=${codexTomlString(':workspace')}, ` +
    `filesystem={${codexTomlString(':workspace_roots')}={${rules}}}}`
  );
}

function codexProjectTrustConfigOverride(cwd: string): string {
  const projectRoot = codexProjectRoot(cwd);
  // Codex 0.144.1's CLI override parser splits keys on every dot without
  // parsing quoted segments. A dotted key such as projects."/path" therefore
  // retains the quotes in the map key and does not match the active project.
  // Supplying the whole projects table keeps the path as a TOML string key.
  return (
    `projects={` +
    `${codexTomlString(projectRoot)}={` +
    `trust_level=${codexTomlString('trusted')}}}`
  );
}

function codexProjectRoot(cwd: string): string {
  // Codex keeps the lexical absolute cwd on non-Windows platforms. Preserve
  // aliases here so the override matches its exact-cwd/repository-root lookup.
  const workspace = resolve(
    process.platform === 'win32' ? normalizeCodexWindowsDevicePath(cwd) : cwd,
  );
  let current = workspace;

  while (true) {
    const dotGit = join(current, '.git');
    if (existsSync(dotGit)) {
      try {
        if (statSync(dotGit).isDirectory()) return current;

        const gitDirValue = trimCodexRustWhitespace(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            readFileSync(dotGit),
          ),
        );
        const gitDir = gitDirValue.startsWith('gitdir:')
          ? trimCodexRustWhitespace(gitDirValue.slice('gitdir:'.length))
          : '';
        if (!gitDir) return workspace;

        const worktreesDir = dirname(
          resolve(
            current,
            process.platform === 'win32'
              ? normalizeCodexWindowsDevicePath(gitDir)
              : gitDir,
          ),
        );
        if (basename(worktreesDir) !== 'worktrees') return workspace;

        const commonGitDir = dirname(worktreesDir);
        return dirname(commonGitDir);
      } catch {
        return workspace;
      }
    }
    const parent = dirname(current);
    if (parent === current) return workspace;
    current = parent;
  }
}

export function mapPermissionsToCodexOptions(
  policy: PermissionPolicy | undefined,
): CodexPermissionOptions {
  if (!policy) {
    return {};
  }

  const defaultPermissions = codexDefaultPermissions(policy);
  const writablePaths = mapWritablePathsPermission(
    policy,
    defaultPermissions === ':danger-full-access' ? 'ambient' : 'profile',
  );

  if (writablePaths && defaultPermissions === ':read-only') {
    throw new Error(
      'Codex permission policy cannot combine non-empty writablePaths with read-only local access',
    );
  }

  const config: NonNullable<CodexConstructorOptions['config']> = {
    default_permissions:
      writablePaths && defaultPermissions === ':workspace'
        ? CODEX_WORKSPACE_EXTRA_WRITES_PROFILE
        : defaultPermissions,
    ...(policy.mode === 'auto' ? { approvals_reviewer: 'auto_review' } : {}),
  };

  const codexCliConfigOverrides =
    writablePaths && defaultPermissions === ':workspace'
      ? [codexWorkspaceExtraWritesProfileConfigOverride(writablePaths.paths)]
      : undefined;

  return {
    approvalPolicy: codexApprovalPolicy(policy),
    codexOptions: { config },
    codexCliExecArgs: ['--ignore-user-config'],
    ...(codexCliConfigOverrides ? { codexCliConfigOverrides } : {}),
    ...(writablePaths ? { writablePaths } : {}),
  };
}

function mapDoneStatus(rawStatus: string | undefined): DonePayload['status'] {
  if (!rawStatus) return 'success';

  const status = rawStatus.toLowerCase();
  if (status === 'success' || status === 'completed' || status === 'ok') {
    return 'success';
  }
  if (
    status === 'interrupted' ||
    status === 'cancelled' ||
    status === 'aborted'
  ) {
    return 'interrupted';
  }
  if (status === 'max_turns' || status === 'maxturns') {
    return 'max_turns';
  }
  if (
    status === 'max_budget' ||
    status === 'maxbudget' ||
    status === 'budget_exceeded'
  ) {
    return 'max_budget';
  }
  if (status === 'error' || status === 'failed') {
    return 'error';
  }

  return 'success';
}

/** Cumulative thread counters as Codex reports them on `turn.completed`. */
interface CodexUsageSnapshot {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface CodexUsageReading {
  values: CodexUsageSnapshot;
  present: Set<keyof CodexUsageSnapshot>;
}

type CodexUsageCounters = Pick<
  CodexUsageSnapshot,
  'inputTokens' | 'outputTokens'
> &
  Partial<CodexUsageSnapshot>;

type CodexUsageReason =
  | 'reported'
  | 'missing-usage'
  | 'invalid-usage'
  | 'missing-baseline'
  | 'counter-shape-changed'
  | 'counter-decreased'
  | 'invalid-token-subsets';

interface CodexUsageDiagnostic {
  status: 'reported' | 'omitted';
  reason: CodexUsageReason;
  resumed: boolean;
  threadId?: string;
  snapshot?: CodexUsageCounters;
  baseline?: CodexUsageCounters;
  delta?: CodexUsageCounters;
}

interface CodexTurnUsage {
  usage: DonePayload['usage'];
  diagnostic: CodexUsageDiagnostic;
}

const CODEX_USAGE_ALIASES: ReadonlyArray<
  readonly [keyof CodexUsageSnapshot, readonly string[], boolean]
> = [
  ['inputTokens', ['inputTokens', 'input_tokens'], true],
  ['cachedInputTokens', ['cachedInputTokens', 'cached_input_tokens'], false],
  [
    'cacheWriteInputTokens',
    ['cacheWriteInputTokens', 'cache_write_input_tokens'],
    false,
  ],
  ['outputTokens', ['outputTokens', 'output_tokens'], true],
  [
    'reasoningOutputTokens',
    ['reasoningOutputTokens', 'reasoning_output_tokens'],
    false,
  ],
];

/**
 * Read the cumulative snapshot Codex attaches to `turn.completed`. Returns
 * undefined when a required counter is missing under codex-53 or a consumed
 * counter violates engine-56, which keeps the caller on engine-58's
 * omitted-token path instead of differencing against a partial snapshot.
 */
function readCodexUsageSnapshot(
  rawUsage: unknown,
): CodexUsageReading | undefined {
  if (!isUsageRecord(rawUsage)) return undefined;

  const values: CodexUsageSnapshot = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  const present = new Set<keyof CodexUsageSnapshot>();

  for (const [field, aliases, required] of CODEX_USAGE_ALIASES) {
    const reading = readUsageCounter(rawUsage, aliases, required);
    if (!reading.valid) return undefined;
    values[field] = reading.value;
    if (reading.present) present.add(field);
  }

  return { values, present };
}

// Diagnostics only expose validated counters that the runtime actually sent.
// Copy them so a consumer cannot mutate the retained baseline through an event.
function codexUsageCounters(reading: CodexUsageReading): CodexUsageCounters {
  const counters: CodexUsageCounters = {
    inputTokens: reading.values.inputTokens,
    outputTokens: reading.values.outputTokens,
  };
  for (const field of reading.present) {
    counters[field] = reading.values[field];
  }
  return counters;
}

function hasMatchingOptionalUsageShape(
  current: CodexUsageReading,
  baseline: CodexUsageReading,
): boolean {
  return CODEX_USAGE_ALIASES.every(
    ([field, , required]) =>
      required || current.present.has(field) === baseline.present.has(field),
  );
}

/**
 * codex-15: subtract the previous cumulative snapshot to obtain this turn's
 * usage. Decreased counters break the cumulative boundary; the final snapshot
 * alone cannot identify the reset's position within this turn. Fail closed
 * rather than assign an unproved post-reset total to the invocation.
 */
function codexTurnDelta(
  snapshot: CodexUsageSnapshot,
  baseline: CodexUsageSnapshot | undefined,
): CodexUsageSnapshot | undefined {
  if (!baseline) return snapshot;

  const delta: CodexUsageSnapshot = { ...snapshot };
  for (const [field] of CODEX_USAGE_ALIASES) {
    const difference = snapshot[field] - baseline[field];
    if (difference < 0) return undefined;
    delta[field] = difference;
  }

  return delta;
}

// The SDK usage object carries token counts only; toolUses is derived from
// the unique tool item ids observed during the run (codex-29), so the
// caller supplies it rather than this parser reading a usage field.
function mapUsage(rawUsage: unknown, toolUses: number): DonePayload['usage'] {
  if (!isUsageRecord(rawUsage)) {
    return { ...DEFAULT_DONE_USAGE, toolUses };
  }

  const baseInput = readUsageCounter(
    rawUsage,
    ['inputTokens', 'input_tokens'],
    true,
  );
  // Codex input_tokens already includes cache hits and writes. Validate the
  // canonical cache subset counters, but do not add them a second time.
  const cachedInput = readUsageCounter(
    rawUsage,
    ['cachedInputTokens', 'cached_input_tokens'],
    false,
  );
  const cacheWriteInput = readUsageCounter(
    rawUsage,
    ['cacheWriteInputTokens', 'cache_write_input_tokens'],
    false,
  );
  const outputTokens = readUsageCounter(
    rawUsage,
    ['outputTokens', 'output_tokens'],
    true,
  );
  const reasoningOutput = readUsageCounter(
    rawUsage,
    ['reasoningOutputTokens', 'reasoning_output_tokens'],
    false,
  );

  const reported =
    baseInput.valid &&
    cachedInput.valid &&
    cacheWriteInput.valid &&
    outputTokens.valid &&
    reasoningOutput.valid;

  // The exec SDK exposes only the current thread. Even a numerically exact
  // delta is partial invocation coverage because Codex may create descendant
  // threads whose usage is not included in this stream.
  const inputDetails =
    cachedInput.present && cacheWriteInput.present
      ? {
          uncached: exclusiveBase(
            baseInput.value,
            cachedInput.value,
            cacheWriteInput.value,
          ),
          cacheRead: cachedInput.value,
          cacheWrite: cacheWriteInput.value,
        }
      : {
          ...(cachedInput.present ? { cacheRead: cachedInput.value } : {}),
          ...(cacheWriteInput.present
            ? { cacheWrite: cacheWriteInput.value }
            : {}),
        };
  const totals = reported
    ? buildTokenUsage(
        { total: baseInput.value, ...inputDetails },
        {
          total: outputTokens.value,
          ...(reasoningOutput.present
            ? {
                visible: exclusiveBase(
                  outputTokens.value,
                  reasoningOutput.value,
                ),
                reasoning: reasoningOutput.value,
              }
            : {}),
        },
      )
    : undefined;
  const tokens = totals ? buildTokenUsageReport('partial', totals) : undefined;

  return {
    toolUses,
    ...(tokens ? { tokens } : {}),
  };
}

interface MappedCodexOptions {
  codexOptions?: CodexConstructorOptions;
  codexCliExecArgs?: string[];
  codexCliConfigOverrides?: string[];
  threadOptions: CodexThreadOptions;
  runOptions: CodexRunOptions;
  cleanupAbort: () => void;
}

function assertCodexToolRestrictionsSupported(
  options:
    | Pick<AgentOptions<CodexEffort>, 'allowedTools' | 'disallowedTools'>
    | undefined,
): void {
  if (
    options?.allowedTools === undefined &&
    options?.disallowedTools === undefined
  ) {
    return;
  }

  throw new Error(
    'CodexAdapter cannot enforce explicit allowedTools or disallowedTools ' +
      'with the supported Codex SDK; omit both tool-list options or select ' +
      'an adapter with a provider-enforced tool restriction surface.',
  );
}

export function mapEffortToCodexEffort(
  effort: AgentOptions<CodexEffort>['effort'],
): CodexEffort | undefined {
  if (effort === undefined) return undefined;
  assertSupportedEffort(AGENT, effort);
  return effort;
}

export function mapAgentOptionsToCodexOptions(
  options: AgentOptions<CodexEffort, boolean> | undefined,
): MappedCodexOptions {
  assertBuiltInFastModeOption(AGENT, options?.fastMode);
  assertCodexToolRestrictionsSupported(options);
  const permissions = mapPermissionsToCodexOptions(options?.permissions);
  const effort = mapEffortToCodexEffort(options?.effort);

  let cleanupAbort = () => {};
  let abortController: AbortController | undefined;

  if (options?.abortSignal) {
    abortController = new AbortController();
    const onAbort = () => abortController?.abort();

    if (options.abortSignal.aborted) {
      onAbort();
    } else {
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
      cleanupAbort = () =>
        options.abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  const signal = abortController?.signal;

  const configEffort =
    effort === 'max' || effort === 'ultra' ? effort : undefined;
  const permissionConfig = permissions.codexOptions?.config;
  const fastModeConfig =
    options?.fastMode === undefined
      ? undefined
      : {
          service_tier: options.fastMode ? 'fast' : 'default',
          features: { fast_mode: true },
        };
  const codexConfig =
    permissionConfig || configEffort || fastModeConfig
      ? {
          ...(permissionConfig ?? {}),
          ...(configEffort ? { model_reasoning_effort: configEffort } : {}),
          ...(fastModeConfig ?? {}),
        }
      : undefined;
  const codexOptions =
    permissions.codexOptions || codexConfig
      ? {
          ...(permissions.codexOptions ?? {}),
          ...(codexConfig ? { config: codexConfig } : {}),
        }
      : undefined;
  const projectTrustOverride =
    options?.permissions !== undefined &&
    options.cwd &&
    codexDefaultPermissions(options.permissions) !== ':read-only'
      ? codexProjectTrustConfigOverride(options.cwd)
      : undefined;
  const codexCliConfigOverrides = projectTrustOverride
    ? [projectTrustOverride, ...(permissions.codexCliConfigOverrides ?? [])]
    : permissions.codexCliConfigOverrides;

  const threadOptions: CodexThreadOptions = {
    workingDirectory: options?.cwd,
    model: options?.model,
    ...(effort !== undefined && effort !== 'max' && effort !== 'ultra'
      ? { modelReasoningEffort: effort }
      : {}),
    // The CLI's git-repo gate is an interactive-user safety net; programmatic
    // callers (tmux-play, scripts, tests) choose workingDirectory deliberately
    // and frequently target tmpdirs that are not git repos.
    skipGitRepoCheck: true,
  };

  if (permissions.approvalPolicy) {
    threadOptions.approvalPolicy = permissions.approvalPolicy;
  }

  return {
    codexOptions,
    ...(permissions.codexCliExecArgs
      ? { codexCliExecArgs: permissions.codexCliExecArgs }
      : {}),
    ...(codexCliConfigOverrides ? { codexCliConfigOverrides } : {}),
    threadOptions,
    runOptions: {
      signal,
    },
    cleanupAbort,
  };
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return toToolInputRecord(parsed, value);
    } catch {
      return { raw: value };
    }
  }
  return toToolInputRecord(value, value);
}

// Non-record argument payloads (arrays, primitives) are preserved under a
// `raw` key rather than dropped, because ToolUsePayload.input is a record.
function toToolInputRecord(
  value: unknown,
  raw: unknown,
): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { raw };
}

function loadSessionId(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const candidate = message as {
    sessionId?: unknown;
    session_id?: unknown;
    threadId?: unknown;
    thread_id?: unknown;
    session?: { id?: unknown };
    thread?: { id?: unknown };
  };

  return (
    asString(candidate.sessionId) ??
    asString(candidate.session_id) ??
    asString(candidate.threadId) ??
    asString(candidate.thread_id) ??
    asString(candidate.session?.id) ??
    asString(candidate.thread?.id)
  );
}

interface NormalizedToolUse {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

interface NormalizedToolResult {
  toolName: string;
  toolUseId: string;
  status: 'success' | 'error' | 'denied';
  output: unknown;
  durationMs?: number;
}

type NormalizedItemEvent =
  | { type: 'text'; payload: { content: string } }
  | { type: 'tool_use'; payload: NormalizedToolUse }
  | { type: 'tool_result'; payload: NormalizedToolResult }
  | { type: 'codex:file_change'; payload: unknown };

// The SDK's canonical tool items: shell commands and MCP tool invocations
// evolve across item.started / item.updated / item.completed and correlate
// by item id (codex-54).
type CodexToolLifecycleType = 'command_execution' | 'mcp_tool_call';

function codexToolLifecycleType(
  item: CodexItem,
): CodexToolLifecycleType | undefined {
  const itemType = asString(item.type);
  return itemType === 'command_execution' || itemType === 'mcp_tool_call'
    ? itemType
    : undefined;
}

function codexLifecycleToolUse(
  lifecycleType: CodexToolLifecycleType,
  item: CodexItem,
  toolUseId: string,
): NormalizedToolUse {
  if (lifecycleType === 'command_execution') {
    return {
      toolName: 'command_execution',
      toolUseId,
      input: { command: asString(item.command) ?? '' },
    };
  }

  const server = asString(item.server);
  const tool = asString(item.tool);
  return {
    toolName: server && tool ? `${server}.${tool}` : (tool ?? 'mcp_tool_call'),
    toolUseId,
    input: parseToolInput(item.arguments),
  };
}

function codexLifecycleToolResult(
  lifecycleType: CodexToolLifecycleType,
  item: CodexItem,
  toolUse: NormalizedToolUse,
): NormalizedToolResult {
  const failed = asString(item.status)?.toLowerCase() === 'failed';
  const status: NormalizedToolResult['status'] = failed ? 'error' : 'success';

  if (lifecycleType === 'command_execution') {
    const exitCode = asNumber(item.exit_code);
    return {
      toolName: toolUse.toolName,
      toolUseId: toolUse.toolUseId,
      status,
      output: {
        aggregated_output: asString(item.aggregated_output) ?? '',
        ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
      },
    };
  }

  return {
    toolName: toolUse.toolName,
    toolUseId: toolUse.toolUseId,
    status,
    output:
      (failed ? (item.error ?? item.result) : (item.result ?? item.error)) ??
      null,
  };
}

function parseItemCompleted(itemRaw: unknown): NormalizedItemEvent[] {
  const events: NormalizedItemEvent[] = [];

  const item = asRecord(itemRaw) as CodexItem;
  const itemType = asString(item.type);
  const content = Array.isArray(item.content) ? item.content : [];
  const topText = asString(item.text);

  const pushToolUse = (
    source: CodexItem,
    target: NormalizedItemEvent[],
  ): void => {
    const toolName =
      asString(source.toolName) ?? asString(source.name) ?? 'unknown_tool';

    const toolUseId =
      asString(source.toolUseId) ??
      asString(source.callId) ??
      asString(source.tool_call_id) ??
      asString(source.id) ??
      generateSessionId();

    target.push({
      type: 'tool_use',
      payload: {
        toolName,
        toolUseId,
        input: parseToolInput(source.input ?? source.arguments ?? source.args),
      },
    });
  };

  const pushToolResult = (
    source: CodexItem,
    target: NormalizedItemEvent[],
  ): void => {
    const statusText = asString(source.status)?.toLowerCase();
    const status: 'success' | 'error' | 'denied' =
      statusText === 'denied'
        ? 'denied'
        : source.isError === true ||
            source.is_error === true ||
            statusText === 'error' ||
            statusText === 'failed'
          ? 'error'
          : 'success';

    target.push({
      type: 'tool_result',
      payload: {
        toolName:
          asString(source.toolName) ?? asString(source.name) ?? 'unknown_tool',
        toolUseId:
          asString(source.toolUseId) ??
          asString(source.callId) ??
          asString(source.tool_call_id) ??
          asString(source.id) ??
          generateSessionId(),
        status,
        output: source.output ?? source.result ?? source.content ?? null,
        durationMs: asNumber(source.durationMs) ?? asNumber(source.duration_ms),
      },
    });
  };

  const isTopLevelToolResult =
    itemType === 'tool_result' ||
    itemType === 'function_call_result' ||
    itemType === 'tool_output';
  const hasContentBlocks = content.length > 0;

  if (!hasContentBlocks) {
    if (topText) {
      events.push({ type: 'text', payload: { content: topText } });
    }

    if (
      itemType === 'tool_call' ||
      itemType === 'function_call' ||
      itemType === 'tool_use'
    ) {
      pushToolUse(item, events);
    }

    if (itemType === 'file_change' || itemType === 'file.changed') {
      events.push({ type: 'codex:file_change', payload: item.file ?? item });
    }
  } else {
    const contentEvents: NormalizedItemEvent[] = [];
    let hasContentTextBlock = false;

    for (const blockRaw of content) {
      const block = asRecord(blockRaw) as CodexItem;
      const blockType = asString(block.type);

      if (
        blockType === 'text' ||
        blockType === 'output_text' ||
        blockType === 'message_text'
      ) {
        const text = asString(block.text);
        if (text) {
          hasContentTextBlock = true;
          contentEvents.push({ type: 'text', payload: { content: text } });
        }
        continue;
      }

      if (
        blockType === 'tool_call' ||
        blockType === 'function_call' ||
        blockType === 'tool_use'
      ) {
        pushToolUse(block, contentEvents);
        continue;
      }

      if (
        blockType === 'tool_result' ||
        blockType === 'function_call_result' ||
        blockType === 'tool_output'
      ) {
        pushToolResult(block, contentEvents);
        continue;
      }

      if (blockType === 'file_change' || blockType === 'file.changed') {
        contentEvents.push({
          type: 'codex:file_change',
          payload: block.file ?? block,
        });
        continue;
      }
    }

    if (topText && !hasContentTextBlock) {
      events.push({ type: 'text', payload: { content: topText } });
    }
    events.push(...contentEvents);
  }

  if (isTopLevelToolResult) {
    pushToolResult(item, events);
  }

  return events;
}

function toErrorPayload(message: unknown): {
  code?: string;
  message: string;
  recoverable: boolean;
} {
  const top = asRecord(message);
  const nested = asErrorRecord(top.error);
  const messageRecord = asErrorRecord(top.message);
  const records = [top, nested, messageRecord];

  const code =
    firstString(records, ['code', 'error_code']) ??
    firstString([nested, messageRecord], ['type']);

  const text =
    codexErrorMessage(top.message) ??
    codexErrorMessage(top.detail) ??
    codexErrorMessage(top.error) ??
    'Codex SDK error';

  const recoverable = records.some(
    (record) => record.recoverable === true || record.retryable === true,
  );

  return {
    ...(code ? { code: ordinaryErrorCode(code, 'SDK_STREAM_ERROR') } : {}),
    message: text,
    recoverable,
  };
}

function firstString(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = asString(record[key]);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

interface CodexConfigOverrideWrapper {
  path: string;
  cleanup: () => Promise<void>;
}

const CODEX_SDK_PACKAGE = '@openai/codex-sdk';
const CODEX_BIN_SPECIFIER = '@openai/codex/bin/codex.js';

export interface CodexBinPathResolutionDeps {
  // Loader-provided ESM resolution; pass undefined to model runtimes that
  // predate import.meta.resolve (Node < 18.19).
  importMetaResolve?: ((specifier: string) => string) | undefined;
  // Module scope whose search paths anchor the lookup and whose resolution
  // serves as the final fallback.
  baseRequire?: Pick<NodeJS.Require, 'resolve'>;
}

interface CodexSdkAnchor {
  anchor: string;
  route: string;
}

function firstErrorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n', 1)[0] ?? text;
}

function toRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// @openai/codex is a dependency of @openai/codex-sdk, not of cligent, so
// anchors must sit inside the installed SDK tree for layouts that do not
// hoist it (npm global prefixes, nested-strategy consumers). Anchors are
// realpath-canonicalized so pnpm-style symlinked layouts resolve from the
// SDK's physical tree, matching how Node resolves the SDK's own imports.
function codexSdkAnchors(
  importMetaResolve: ((specifier: string) => string) | undefined,
  baseRequire: Pick<NodeJS.Require, 'resolve'>,
  failures: string[],
): CodexSdkAnchor[] {
  const anchors: CodexSdkAnchor[] = [];

  if (importMetaResolve) {
    try {
      const resolvedUrl = new URL(importMetaResolve(CODEX_SDK_PACKAGE));
      if (resolvedUrl.protocol === 'file:') {
        anchors.push({
          anchor: toRealPath(fileURLToPath(resolvedUrl)),
          route: `loader-resolved ${CODEX_SDK_PACKAGE}`,
        });
      } else {
        failures.push(
          `loader resolved ${CODEX_SDK_PACKAGE} to a non-file URL ${resolvedUrl.href}`,
        );
      }
    } catch (error) {
      failures.push(
        `loader resolution of ${CODEX_SDK_PACKAGE} failed: ${firstErrorLine(error)}`,
      );
    }
  }

  const searchPaths = baseRequire.resolve.paths(CODEX_SDK_PACKAGE) ?? [];
  const manifest = searchPaths
    .map((searchPath) =>
      join(searchPath, ...CODEX_SDK_PACKAGE.split('/'), 'package.json'),
    )
    .find((candidate) => existsSync(candidate));
  if (manifest) {
    anchors.push({
      anchor: toRealPath(manifest),
      route: `search-path ${CODEX_SDK_PACKAGE} manifest`,
    });
  } else {
    failures.push(
      `no ${CODEX_SDK_PACKAGE} package manifest on module search paths ` +
        `(${searchPaths.join(', ')})`,
    );
  }

  return anchors;
}

export function resolveCodexBinPath(
  deps: CodexBinPathResolutionDeps = {},
): string {
  const baseRequire = deps.baseRequire ?? requireFromHere;
  // An injected baseRequire scopes resolution to a caller-chosen tree, so the
  // ambient loader is only auto-detected when no scope was injected; letting
  // it through would silently resolve against this module's own tree instead.
  const importMetaResolve =
    'importMetaResolve' in deps
      ? deps.importMetaResolve
      : deps.baseRequire === undefined &&
          typeof import.meta.resolve === 'function'
        ? (specifier: string) => import.meta.resolve(specifier)
        : undefined;

  const failures: string[] = [];
  for (const { anchor, route } of codexSdkAnchors(
    importMetaResolve,
    baseRequire,
    failures,
  )) {
    try {
      return createRequire(anchor).resolve(CODEX_BIN_SPECIFIER);
    } catch (error) {
      failures.push(`${route} (${anchor}): ${firstErrorLine(error)}`);
    }
  }

  try {
    return baseRequire.resolve(CODEX_BIN_SPECIFIER);
  } catch (error) {
    failures.push(`cligent module scope: ${firstErrorLine(error)}`);
  }

  // Keep Node's module-resolution code so callers that degrade on a missing
  // optional CLI by testing error.code keep matching.
  throw Object.assign(
    new Error(
      `CodexAdapter could not resolve '${CODEX_BIN_SPECIFIER}', the Codex CLI ` +
        `entry owned by the '${CODEX_SDK_PACKAGE}' peer dependency.\n` +
        `Attempted:\n${failures.map((failure) => `  - ${failure}`).join('\n')}\n` +
        `Install '${CODEX_SDK_PACKAGE}' where '@sublang/cligent' can resolve ` +
        `it (for a global cligent install: npm install -g ${CODEX_SDK_PACKAGE}).`,
    ),
    { code: 'MODULE_NOT_FOUND' },
  );
}

function codexWrapperScript(
  codexBinPath: string,
  configOverrides: readonly string[],
  execArgs: readonly string[],
): string {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';

const codexBinPath = ${JSON.stringify(codexBinPath)};
const configOverrides = ${JSON.stringify(configOverrides)};
const execArgs = ${JSON.stringify(execArgs)};
const [subcommand, ...rest] = process.argv.slice(2);
const injectedExecArgs = subcommand === 'exec' ? execArgs : [];
const injected = configOverrides.flatMap((override) => ['--config', override]);
const args = subcommand
  ? [codexBinPath, subcommand, ...injectedExecArgs, ...injected, ...rest]
  : [codexBinPath, ...injected];
const child = spawn(process.execPath, args, {
  env: process.env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
`;
}

export async function createCodexConfigOverrideWrapper(
  configOverrides: readonly string[],
  execArgs: readonly string[] = [],
): Promise<CodexConfigOverrideWrapper | undefined> {
  if (configOverrides.length === 0 && execArgs.length === 0) {
    return undefined;
  }

  const codexBinPath = resolveCodexBinPath();
  const dir = await mkdtemp(join(tmpdir(), 'cligent-codex-config-'));
  const scriptPath = join(dir, 'codex-wrapper.mjs');
  const wrapperPath =
    process.platform === 'win32' ? join(dir, 'codex-wrapper.cmd') : scriptPath;

  await writeFile(
    scriptPath,
    codexWrapperScript(codexBinPath, configOverrides, execArgs),
    'utf8',
  );

  if (process.platform === 'win32') {
    await writeFile(
      wrapperPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      'utf8',
    );
  } else {
    await chmod(scriptPath, 0o700);
  }

  return {
    path: wrapperPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function loadCodexSdk(): Promise<CodexSdk> {
  const mod = (await import('@openai/codex-sdk')) as {
    Codex?: unknown;
  };

  if (typeof mod.Codex !== 'function') {
    throw new Error('@openai/codex-sdk does not export Codex');
  }

  // engine-25: the SDK imported, which says nothing about whether the Codex
  // executable it selects is new enough to serve the caller's model. Check
  // here, inside the loader isAvailable() and run() share.
  assertRuntimeSupported(
    AGENT_RUNTIME_TARGETS.codex[0]!,
    `npm install @openai/codex-sdk@${AGENT_RUNTIME_TARGETS.codex[0]!.tested}`,
  );

  return {
    Codex: mod.Codex as CodexSdk['Codex'],
  };
}

export class CodexAdapter implements AgentAdapter<CodexEffort, boolean> {
  readonly agent = AGENT;

  private readonly loadSdk: () => Promise<CodexSdk>;

  /**
   * codex-15: `turn.completed.usage` reports the thread's cumulative total,
   * so the turn's own usage is the delta against the previous snapshot. The
   * baseline is keyed by backend thread identity, not by run, because a
   * later run resumes the same thread. engine-37 permits exactly this state.
   */
  private readonly threadUsageBaselines = new Map<string, CodexUsageReading>();

  /**
   * engine-38: two concurrent turns on one resumed thread would race its one
   * cumulative counter and make either delta depend on event arrival order.
   * Queue only equal inbound resume identities; fresh and unrelated sessions
   * retain the adapter's normal concurrency.
   */
  private readonly resumeSessionTails = new Map<string, Promise<void>>();

  constructor(deps: CodexAdapterDeps = {}) {
    this.loadSdk = deps.loadSdk ?? loadCodexSdk;
  }

  private async acquireResumeSession(sessionId: string): Promise<() => void> {
    const predecessor =
      this.resumeSessionTails.get(sessionId) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    const tail = predecessor.then(() => current);
    this.resumeSessionTails.set(sessionId, tail);

    await predecessor;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveCurrent();
      if (this.resumeSessionTails.get(sessionId) === tail) {
        this.resumeSessionTails.delete(sessionId);
      }
    };
  }

  /**
   * codex-15: turn the cumulative `turn.completed` snapshot into this turn's
   * usage. A fresh thread starts from zero, so its first snapshot is already
   * the turn. A resumed thread this adapter never observed has no baseline to
   * subtract, and reporting the thread total as the turn's would overstate it
   * by every earlier turn, so token accounting is omitted instead.
   */
  private resolveTurnUsage(
    rawUsage: unknown,
    toolUses: number,
    threadId: string | undefined,
    resumed: boolean,
  ): CodexTurnUsage {
    const snapshot = readCodexUsageSnapshot(rawUsage);
    const baseline = threadId
      ? this.threadUsageBaselines.get(threadId)
      : undefined;
    const diagnostic: CodexUsageDiagnostic = {
      status: 'omitted',
      reason: 'invalid-usage',
      resumed,
      ...(threadId ? { threadId } : {}),
      ...(snapshot ? { snapshot: codexUsageCounters(snapshot) } : {}),
      ...(baseline ? { baseline: codexUsageCounters(baseline) } : {}),
    };
    const omitted = (reason: CodexUsageReason): CodexTurnUsage => ({
      usage: { ...DEFAULT_DONE_USAGE, toolUses },
      diagnostic: { ...diagnostic, reason },
    });

    if (!snapshot) {
      // A missing snapshot breaks the attribution boundary for the next turn.
      if (threadId) this.threadUsageBaselines.delete(threadId);
      return omitted(rawUsage == null ? 'missing-usage' : 'invalid-usage');
    }

    // Always advance the baseline, so a thread recovers on its next turn even
    // when this one could not be attributed.
    if (threadId) this.threadUsageBaselines.set(threadId, snapshot);

    if (threadId && !baseline && resumed) {
      return omitted('missing-baseline');
    }

    // A newly appearing cumulative subset may contain spend from older turns,
    // while a disappearing one destroys the base needed to difference it.
    if (baseline && !hasMatchingOptionalUsageShape(snapshot, baseline)) {
      return omitted('counter-shape-changed');
    }

    const delta = codexTurnDelta(snapshot.values, baseline?.values);
    if (!delta) return omitted('counter-decreased');
    diagnostic.delta = codexUsageCounters({ ...snapshot, values: delta });

    // Rebuild only counters the snapshot carried, preserving absent vs zero.
    const differenced: Record<string, unknown> = {};
    for (const [field, aliases] of CODEX_USAGE_ALIASES) {
      if (snapshot.present.has(field)) differenced[aliases[0]!] = delta[field];
    }
    const usage = mapUsage(differenced, toolUses);
    return {
      usage,
      diagnostic: {
        ...diagnostic,
        status: usage.tokens ? 'reported' : 'omitted',
        reason: usage.tokens ? 'reported' : 'invalid-token-subsets',
      },
    };
  }

  /**
   * The exec stream reports one current-thread aggregate rather than one entry
   * per upstream request. Publish it as one unidentified-count record only
   * when the runtime itself names the model; a requested model is not evidence
   * that the provider did not reroute the request.
   */
  private withTurnRecord(
    usage: DonePayload['usage'],
    model: string | undefined,
  ): DonePayload['usage'] {
    if (!model || !usage.tokens) return usage;

    const tokens = buildTokenUsageReport(
      usage.tokens.coverage,
      usage.tokens.totals,
      [{ model, tokens: usage.tokens.totals }],
    );
    return tokens ? { ...usage, tokens } : usage;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.loadSdk();
      return true;
    } catch {
      return false;
    }
  }

  async *run(
    prompt: string,
    options?: AgentOptions<CodexEffort, boolean>,
  ): AsyncGenerator<AgentEvent, void, void> {
    assertBuiltInFastModeOption(AGENT, options?.fastMode);
    assertCodexToolRestrictionsSupported(options);
    const resumeSessionId = asString(options?.resume);

    let sdk: CodexSdk;
    try {
      sdk = await this.loadSdk();
    } catch (error) {
      // A version refusal already names the installed version, the required
      // version, the tree, and the repair. Replacing it with "install it"
      // would tell the user to install something already present.
      if (isUnsupportedRuntimeError(error)) throw error;
      throw new Error(
        'CodexAdapter requires @openai/codex-sdk. Install it to use this adapter.',
      );
    }

    const {
      codexOptions,
      codexCliExecArgs,
      codexCliConfigOverrides,
      threadOptions,
      runOptions,
      cleanupAbort,
    } = mapAgentOptionsToCodexOptions(options);

    let codexConfigWrapper: CodexConfigOverrideWrapper | undefined;
    try {
      codexConfigWrapper = await createCodexConfigOverrideWrapper(
        codexCliConfigOverrides ?? [],
        codexCliExecArgs ?? [],
      );
    } catch (err) {
      // Executable resolution and wrapper setup run before any event, so
      // release the abort listener registered for this run before rethrowing.
      cleanupAbort();
      throw err;
    }
    const effectiveCodexOptions = codexConfigWrapper
      ? {
          ...codexOptions,
          codexPathOverride: codexConfigWrapper.path,
        }
      : codexOptions;
    let cleanedUp = false;
    const cleanupCodexRun = async (): Promise<void> => {
      if (cleanedUp) return;
      cleanedUp = true;
      cleanupAbort();
      await codexConfigWrapper?.cleanup();
    };

    let codex: CodexClient;
    try {
      codex = new sdk.Codex(effectiveCodexOptions);
    } catch (err) {
      await cleanupCodexRun();
      throw new Error(
        `CodexAdapter failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const releaseResumeSession = resumeSessionId
      ? await this.acquireResumeSession(resumeSessionId)
      : () => {};
    const finishCodexRun = async (): Promise<void> => {
      try {
        await cleanupCodexRun();
      } finally {
        releaseResumeSession();
      }
    };

    let thread: CodexThread;
    let streamRequested = false;
    let streamResult:
      { events: AsyncIterable<unknown> } | AsyncIterable<unknown> | undefined;
    try {
      if (resumeSessionId) {
        if (typeof codex.resumeThread !== 'function') {
          throw new Error(
            'Codex SDK does not support resumeThread() in this version',
          );
        }
        thread = codex.resumeThread(resumeSessionId, threadOptions);
      } else {
        thread = codex.startThread(threadOptions);
      }

      streamRequested = typeof thread.runStreamed === 'function';
      streamResult = await (thread.runStreamed?.(prompt, runOptions) as
        | Promise<{ events: AsyncIterable<unknown> } | AsyncIterable<unknown>>
        | undefined);
    } catch (err) {
      if (streamRequested && resumeSessionId) {
        this.threadUsageBaselines.delete(resumeSessionId);
      }
      await finishCodexRun();
      throw err;
    }

    if (!streamResult) {
      if (streamRequested && resumeSessionId) {
        this.threadUsageBaselines.delete(resumeSessionId);
      }
      await finishCodexRun();
      throw new Error(
        'Codex SDK does not support runStreamed() in this version',
      );
    }

    // The SDK normally returns { events: AsyncGenerator }. Prefer .events
    // but fall back to iterating the result directly if the shape differs
    // (e.g. due to transpilation or a non-standard SDK version).
    const streamObj = streamResult as Record<string, unknown>;
    const runStream = (streamObj.events ??
      streamResult) as AsyncIterable<unknown>;

    let sessionId = resumeSessionId ?? generateSessionId();
    let backendProvidedSessionId = false;
    const startTime = Date.now();
    let doneYielded = false;
    let terminalUsageObserved = false;
    let initYielded = false;
    // Tool lifecycle correlation (codex-19): ids that already produced a
    // tool_use, ids that already produced their terminal tool_result, and
    // every unique tool-call id observed for codex-29's toolUses count.
    const announcedToolUseIds = new Set<string>();
    const completedToolUseIds = new Set<string>();
    const observedToolUseIds = new Set<string>();

    // A requested model is not an observed rate-card key: the backend may
    // reroute it. Retain a model only when this run's event stream names one.
    let rateCardModel: string | undefined;

    const buildInitPayload = (
      sourceEvent?: Record<string, unknown>,
    ): {
      model: string;
      cwd: string;
      tools: string[];
      capabilities: Record<string, unknown>;
    } => {
      const hasConfiguredAllowedTools =
        Array.isArray(options?.allowedTools) && options.allowedTools.length > 0;
      const configuredAllowedTools = hasConfiguredAllowedTools
        ? (options?.allowedTools ?? [])
        : [];

      const sourceSession = asRecord(sourceEvent?.session);
      const sourceTurn = asRecord(sourceEvent?.turn);

      const eventTools = asStringArray(sourceEvent?.tools);
      const sessionTools = asStringArray(sourceSession.tools);
      const turnTools = asStringArray(sourceTurn.tools);

      const inferredTools =
        eventTools.length > 0
          ? eventTools
          : sessionTools.length > 0
            ? sessionTools
            : turnTools;

      const tools = hasConfiguredAllowedTools
        ? configuredAllowedTools
        : inferredTools.length > 0
          ? inferredTools
          : [];

      rateCardModel ??= asString(sourceEvent?.model);

      return {
        model: options?.model ?? asString(sourceEvent?.model) ?? 'unknown',
        cwd: options?.cwd ?? asString(sourceEvent?.cwd) ?? process.cwd(),
        tools,
        capabilities: {
          toolsKnown: hasConfiguredAllowedTools || inferredTools.length > 0,
          toolsSource: hasConfiguredAllowedTools
            ? 'allowedTools'
            : inferredTools.length > 0
              ? 'sdk'
              : 'unavailable',
        },
      };
    };

    try {
      for await (const rawEvent of runStream) {
        const loadedId = loadSessionId(rawEvent);
        if (loadedId) {
          sessionId = loadedId;
          backendProvidedSessionId = true;
        }

        const event = asRecord(rawEvent);
        rateCardModel ??= asString(event.model);
        if (!initYielded) {
          yield createEvent('init', AGENT, buildInitPayload(event), sessionId);
          initYielded = true;
        }

        const eventType = asString(event.type);
        if (!eventType) continue;

        if (eventType === 'item.started' || eventType === 'item.updated') {
          const item = asRecord(event.item) as CodexItem;
          const lifecycleType = codexToolLifecycleType(item);
          const id = asString(item.id);

          // First observation of a command/MCP item announces the call;
          // later item.updated events for the same id emit nothing, so
          // update streams never duplicate the unified lifecycle.
          if (lifecycleType && id && !announcedToolUseIds.has(id)) {
            announcedToolUseIds.add(id);
            observedToolUseIds.add(id);
            yield createEvent(
              'tool_use',
              AGENT,
              codexLifecycleToolUse(lifecycleType, item, id),
              sessionId,
            );
          }
          continue;
        }

        if (eventType === 'item.completed') {
          const item = asRecord(event.item) as CodexItem;
          const lifecycleType = codexToolLifecycleType(item);

          if (lifecycleType) {
            // Items without an id cannot correlate across lifecycle events;
            // completion still yields a self-consistent call/result pair
            // under one generated id.
            const id = asString(item.id) ?? generateSessionId();
            if (completedToolUseIds.has(id)) continue;
            completedToolUseIds.add(id);
            observedToolUseIds.add(id);

            const toolUse = codexLifecycleToolUse(lifecycleType, item, id);
            if (!announcedToolUseIds.has(id)) {
              announcedToolUseIds.add(id);
              yield createEvent('tool_use', AGENT, toolUse, sessionId);
            }
            yield createEvent(
              'tool_result',
              AGENT,
              codexLifecycleToolResult(lifecycleType, item, toolUse),
              sessionId,
            );
            continue;
          }

          const itemEvents = parseItemCompleted(event.item);

          for (const itemEvent of itemEvents) {
            if (itemEvent.type === 'text') {
              yield createEvent('text', AGENT, itemEvent.payload, sessionId);
              continue;
            }

            if (itemEvent.type === 'tool_use') {
              observedToolUseIds.add(itemEvent.payload.toolUseId);
              yield createEvent(
                'tool_use',
                AGENT,
                itemEvent.payload,
                sessionId,
              );
              continue;
            }

            if (itemEvent.type === 'tool_result') {
              observedToolUseIds.add(itemEvent.payload.toolUseId);
              yield createEvent(
                'tool_result',
                AGENT,
                itemEvent.payload,
                sessionId,
              );
              continue;
            }

            if (itemEvent.type === 'codex:file_change') {
              yield createEvent(
                'codex:file_change',
                AGENT,
                itemEvent.payload,
                sessionId,
              );
              continue;
            }
          }

          continue;
        }

        if (
          eventType === 'file_change' ||
          eventType === 'file.changed' ||
          eventType === 'item.file_change'
        ) {
          const payload = event.file ?? event.change ?? event.item ?? event;
          yield createEvent('codex:file_change', AGENT, payload, sessionId);
          continue;
        }

        if (eventType === 'error') {
          yield createEvent('error', AGENT, toErrorPayload(event), sessionId);
          continue;
        }

        if (eventType === 'turn.failed') {
          // Codex emits turn.failed when a turn cannot complete (model
          // mismatch, server-side rejection, etc.) and then exits with a
          // non-zero code. Yield the structured error and a terminal done
          // so the underlying message reaches the caller before the SDK's
          // exec wrapper raises a generic "Codex Exec exited" exception.
          const payload = toErrorPayload(event);
          const accounting = this.resolveTurnUsage(
            event.usage,
            observedToolUseIds.size,
            backendProvidedSessionId ? sessionId : resumeSessionId,
            resumeSessionId !== undefined,
          );
          terminalUsageObserved = true;
          yield createEvent('error', AGENT, payload, sessionId);
          yield createEvent(
            'codex:usage',
            AGENT,
            accounting.diagnostic,
            sessionId,
          );
          yield createEvent(
            'done',
            AGENT,
            {
              status: 'error',
              ...doneResumeTokenPayload(
                'error',
                backendProvidedSessionId,
                sessionId,
                resumeSessionId,
              ),
              usage: this.withTurnRecord(accounting.usage, rateCardModel),
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
          doneYielded = true;
          return;
        }

        if (eventType === 'turn.completed') {
          const turn = asRecord(event.turn);
          const status = mapDoneStatus(
            asString(turn.status) ?? asString(event.status),
          );

          const durationMs =
            asNumber(turn.durationMs) ??
            asNumber(turn.duration_ms) ??
            asNumber(event.durationMs) ??
            asNumber(event.duration_ms) ??
            Date.now() - startTime;

          const accounting = this.resolveTurnUsage(
            turn.usage ?? event.usage,
            observedToolUseIds.size,
            // A resumed turn need not repeat thread.started.
            backendProvidedSessionId ? sessionId : resumeSessionId,
            resumeSessionId !== undefined,
          );
          terminalUsageObserved = true;
          yield createEvent(
            'codex:usage',
            AGENT,
            accounting.diagnostic,
            sessionId,
          );
          yield createEvent(
            'done',
            AGENT,
            {
              status,
              result: asString(turn.result) ?? asString(event.result),
              ...doneResumeTokenPayload(
                status,
                backendProvidedSessionId,
                sessionId,
                resumeSessionId,
              ),
              usage: this.withTurnRecord(accounting.usage, rateCardModel),
              durationMs,
            },
            sessionId,
          );
          doneYielded = true;
          return;
        }
      }

      if (!initYielded) {
        yield createEvent('init', AGENT, buildInitPayload(), sessionId);
        initYielded = true;
      }

      if (!doneYielded) {
        if (options?.abortSignal?.aborted || runOptions.signal?.aborted) {
          yield createEvent(
            'done',
            AGENT,
            {
              status: 'interrupted',
              ...doneResumeTokenPayload(
                'interrupted',
                backendProvidedSessionId,
                sessionId,
                resumeSessionId,
              ),
              usage: {
                ...DEFAULT_DONE_USAGE,
                toolUses: observedToolUseIds.size,
              },
              durationMs: Date.now() - startTime,
            },
            sessionId,
          );
          return;
        }

        yield createEvent(
          'error',
          AGENT,
          {
            code: 'MISSING_TURN_DONE',
            message:
              'Protocol violation: Codex stream ended without turn.completed',
            recoverable: false,
          },
          sessionId,
        );
        yield createEvent(
          'done',
          AGENT,
          {
            status: 'error',
            ...doneResumeTokenPayload(
              'error',
              backendProvidedSessionId,
              sessionId,
              resumeSessionId,
            ),
            usage: { ...DEFAULT_DONE_USAGE, toolUses: observedToolUseIds.size },
            durationMs: Date.now() - startTime,
          },
          sessionId,
        );
      }
    } catch (error) {
      if (!initYielded) {
        yield createEvent('init', AGENT, buildInitPayload(), sessionId);
        initYielded = true;
      }

      if (options?.abortSignal?.aborted || runOptions.signal?.aborted) {
        yield createEvent(
          'done',
          AGENT,
          {
            status: 'interrupted',
            ...doneResumeTokenPayload(
              'interrupted',
              backendProvidedSessionId,
              sessionId,
              resumeSessionId,
            ),
            usage: { ...DEFAULT_DONE_USAGE, toolUses: observedToolUseIds.size },
            durationMs: Date.now() - startTime,
          },
          sessionId,
        );
        return;
      }

      yield createEvent(
        'error',
        AGENT,
        {
          code: 'SDK_STREAM_ERROR',
          message:
            error instanceof Error
              ? (codexErrorMessage(error.message) ?? error.message)
              : 'Codex adapter failed during stream',
          recoverable: false,
        },
        sessionId,
      );
      yield createEvent(
        'done',
        AGENT,
        {
          status: 'error',
          ...doneResumeTokenPayload(
            'error',
            backendProvidedSessionId,
            sessionId,
            resumeSessionId,
          ),
          usage: { ...DEFAULT_DONE_USAGE, toolUses: observedToolUseIds.size },
          durationMs: Date.now() - startTime,
        },
        sessionId,
      );
    } finally {
      if (!terminalUsageObserved) {
        // An interrupted or broken stream can have billed work with no final
        // snapshot. Never charge that unobserved work to the next resumed turn.
        const usageThreadId = backendProvidedSessionId
          ? sessionId
          : resumeSessionId;
        if (usageThreadId) this.threadUsageBaselines.delete(usageThreadId);
      }
      await finishCodexRun();
    }
  }
}
