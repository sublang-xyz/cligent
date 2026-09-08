// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// claude-code-219 / codex-219 / gemini-219 / kimi-219 / opencode-219: real-run verification that `permissions: { mode: 'auto' }`
// reaches each adapter's SDK and actually suppresses approval prompts for a
// file create + update. The mapping-only tests (each adapter's -204 item) prove the knob
// values; they never spawn the SDK, so they cannot catch an auto-mode knob
// that the SDK silently rejects or that still gates either write behind a
// prompt. Filesystem state is the ground-truth check: adapters normalize file
// edits differently (Codex -> `codex:file_change`, OpenCode -> `opencode:file_part`,
// others -> `tool_use`), so a `tool_use`-count assertion would be adapter-specific.

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, inject, it } from 'vitest';
import {
  assertAcceptanceDependencies,
  gateAcceptanceTest,
} from '../__tests__/helpers/acceptance-dependency-gate.js';
import { withKimiAcceptanceEnvironment } from '../__tests__/helpers/kimi-acceptance.js';
import { Cligent } from '../index.js';
import type {
  AgentAdapter,
  CligentEvent,
  DonePayload,
  ErrorPayload,
  ToolResultPayload,
} from '../index.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import {
  CodexAdapter,
  codexWorkspaceExtraWritesProfileConfigOverride,
  createCodexConfigOverrideWrapper,
  resolveCodexBinPath,
} from './codex.js';
import { GeminiAdapter } from './gemini.js';
import { KimiAdapter } from './kimi.js';
import { OpenCodeAdapter } from './opencode.js';

const GEMINI_MODEL = process.env.GEMINI_MODEL;
const OPENCODE_MODEL = process.env.OPENCODE_MODEL ?? 'moonshotai-cn/kimi-k3';
const kimiAcceptance = inject('kimiAcceptance');

const PROBE_TIMEOUT_MS = 300_000;
const MAX_PROBE_ATTEMPTS = 3;

type ProbeAdapter = 'claude' | 'codex' | 'gemini' | 'kimi' | 'opencode';

const TRANSIENT_UPSTREAM_CODES = new Set([
  '429',
  '503',
  '529',
  'HTTP_429',
  'HTTP_503',
  'HTTP_529',
  'OVERLOADED',
  'OVER_CAPACITY',
  'RATE_LIMITED',
  'RATE_LIMIT_EXCEEDED',
  'SERVICE_UNAVAILABLE',
  'TOO_MANY_REQUESTS',
]);

// Keep these markers tied to explicit provider capacity/status language. In
// particular, do not retry a generic stream/parser failure or an arbitrary
// "API Error: Repeated <status>" message.
const TRANSIENT_UPSTREAM_MARKERS = [
  /\b(?:API Error:\s*Repeated|HTTP(?:[ _-]+status)?|status[ _-]+code)[ :=_-]*(?:429|503|529)\b/i,
  /\boverload(?:ed|ing)?\b/i,
  /\bover[ _-]?capacity\b/i,
  /\bservice[ _-]?unavailable\b/i,
  /\brate[ _-]?limit(?:ed|ing|[ _-]?exceeded)?\b/i,
  /\btoo[ _-]?many[ _-]?requests\b/i,
];

const GEMINI_CLI_050_INVALID_STREAM =
  'Invalid stream: The model returned an empty response or malformed tool call.';
const GEMINI_CLI_050_INVALID_STREAM_RECEIVED =
  'Invalid stream received from model';
const GEMINI_CLI_050_INVALID_STREAM_MESSAGES = new Set([
  GEMINI_CLI_050_INVALID_STREAM,
  GEMINI_CLI_050_INVALID_STREAM_RECEIVED,
]);
const GEMINI_RESULT_ERROR_REPLACEMENT =
  'Gemini result error (raw: {"status":"error"})';

// Codex executes shell commands inside an OS sandbox (bubblewrap on Linux);
// some CI runners cannot start it. A sandbox that fails to initialize is an
// environment limitation, not an auto-mode regression — the codex leg skips.
// Markers are narrowed to the actual error-message shape so an unrelated
// mention of "bwrap" in model text cannot mask a real failure.
const SANDBOX_INIT_MARKERS = [
  /bwrap:\s*\S+:\s*Failed/i,
  /RTM_NEWADDR/,
  /sandbox-exec:\s*sandbox_apply:\s*Operation not permitted/i,
];

// Codex resolves its native sandbox binary via @openai/codex's bin launcher,
// which selects the right platform package and prepends its codex-path dirs;
// invoking that launcher's credential-free `sandbox` subcommand preflights
// the exact same sandbox the SDK will use, rather than a different bwrap from
// the parent process's PATH. Only failures whose output matches
// SANDBOX_INIT_MARKERS classify as `sandbox-init` (skip per the codex-219
// spec exception); any other preflight failure classifies as `unknown` and
// fails the codex test, so a broken codex install or drifted CLI surface
// cannot silently hide codex-219.
const codexCliPath = resolveCodexCliPath();
const codexSandboxPreflight = preflightCodexSandbox();

describe('adapter auto-mode real-run acceptance (claude-code-219 / codex-219 / gemini-219 / kimi-219 / opencode-219)', () => {
  const claudeMissing = missingDeps(['ANTHROPIC_API_KEY']);
  gatedIt('claude', claudeMissing)(
    'claude auto mode auto-approves a temp-file create + update',
    async () => {
      assertAcceptanceDependencies('claude', claudeMissing);
      const outcome = await probeWithRetry(
        'claude',
        () => new ClaudeCodeAdapter(),
        undefined,
      );
      expectAutoMode('claude', outcome);
    },
    PROBE_TIMEOUT_MS,
  );

  const codexMissing = missingDeps(['CODEX_API_KEY']);
  gatedIt('codex', codexMissing)(
    'codex auto mode auto-approves a temp-file create + update',
    async (ctx) => {
      assertAcceptanceDependencies('codex', codexMissing);
      if (codexSandboxPreflight.kind === 'sandbox-init') {
        process.stderr.write(
          `codex auto-mode acceptance: skipping — Codex's workspace sandbox ` +
            `cannot initialize on this host: ${codexSandboxPreflight.summary}\n`,
        );
        ctx.skip();
      }
      if (codexSandboxPreflight.kind === 'unknown') {
        throw new Error(
          `codex auto-mode acceptance: refusing to skip — Codex sandbox ` +
            `preflight failed for a non-sandbox-init reason: ` +
            codexSandboxPreflight.summary,
        );
      }
      const userConfigBefore = userCodexConfigStamp();
      const outcome = await probeWithRetry(
        'codex',
        () => new CodexAdapter(),
        undefined,
      );
      // Backstop: catch sandbox-init failures the preflight didn't (e.g. when
      // codex's bundled helper is used because `bwrap` is not on PATH).
      const sandboxFailure = sandboxInitFailure(outcome);
      if (sandboxFailure) {
        process.stderr.write(
          `codex auto-mode acceptance: skipping — sandbox failure surfaced ` +
            `in probe events: ${sandboxFailure}\n`,
        );
        ctx.skip();
      }
      expectAutoMode('codex', outcome);
      expect(
        userConfigStampChanged(userConfigBefore),
        'codex auto mode changed user-level config.toml',
      ).toBe(false);
    },
    PROBE_TIMEOUT_MS,
  );

  // codex-224: live proof that permission-managed Codex runs ignore a
  // conflicting CODEX_HOME/config.toml instead of letting stale user config
  // override the adapter-selected `auto_review + :workspace` profile.
  gatedIt('codex', codexMissing)(
    'codex auto mode ignores a hostile user Codex config',
    async (ctx) => {
      assertAcceptanceDependencies('codex', codexMissing);
      if (codexSandboxPreflight.kind === 'sandbox-init') {
        process.stderr.write(
          `codex user-config isolation acceptance: skipping — Codex's workspace sandbox ` +
            `cannot initialize on this host: ${codexSandboxPreflight.summary}\n`,
        );
        ctx.skip();
      }
      if (codexSandboxPreflight.kind === 'unknown') {
        throw new Error(
          `codex user-config isolation acceptance: refusing to skip — Codex sandbox ` +
            `preflight failed for a non-sandbox-init reason: ` +
            codexSandboxPreflight.summary,
        );
      }
      const previousCodexHome = process.env.CODEX_HOME;
      const outcome = await probeCodexHostileUserConfigWithRetry();
      expect(process.env.CODEX_HOME, 'caller CODEX_HOME is restored').toBe(
        previousCodexHome,
      );
      const sandboxFailure = sandboxInitFailureFromEvents(
        outcome.managed.events,
      );
      if (sandboxFailure) {
        process.stderr.write(
          `codex user-config isolation acceptance: skipping — sandbox failure surfaced ` +
            `in probe events: ${sandboxFailure}\n`,
        );
        ctx.skip();
      }
      expectPhaseUnblocked(
        'codex hostile user config control',
        outcome.control.events,
      );
      expect(
        outcome.controlOutsideCreated,
        `codex: no-policy control did not inherit danger-full-access user config\n${formatEvents(outcome.control.events)}`,
      ).toBe(true);
      expectRunCompletedWithoutAdapterError(
        'codex hostile user config managed',
        outcome.managed.events,
      );
      expect(
        outcome.controlContext,
        'native no-policy permissions',
      ).toMatchObject({
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
      });
      // Auto-review can authorize an explicitly requested outside write, so
      // file existence cannot diagnose whether the user config leaked.
      expect(
        outcome.managedContext,
        'native managed permissions',
      ).toMatchObject({
        approval_policy: 'on-request',
        approvals_reviewer: 'auto_review',
        sandbox_policy: { type: 'workspace-write' },
      });
    },
    PROBE_TIMEOUT_MS,
  );

  // codex-223: credential-free proof that the generated profile definition is
  // delivered to Codex's native sandbox without mutating user/repo config.
  const codexCliMissing = codexCliPath ? [] : ['@openai/codex CLI'];
  gatedIt('codex', codexCliMissing)(
    'codex writablePaths profile config route grants .git writes in the native sandbox',
    async (ctx) => {
      assertAcceptanceDependencies('codex', codexCliMissing);
      const outcome = await runCodexWritablePathsSandboxProbe();
      if (outcome.skipReason) {
        process.stderr.write(
          `codex writablePaths sandbox acceptance: skipping — ${outcome.skipReason}\n`,
        );
        ctx.skip();
      }
      expect(
        outcome.baseWriteSucceeded,
        `codex :workspace unexpectedly wrote inside .git; probe no longer proves protected-path widening\n${outcome.summary}`,
      ).toBe(false);
      expect(
        outcome.extraWriteSucceeded,
        `codex generated profile did not make .git writable\n${outcome.summary}`,
      ).toBe(true);
      expect(outcome.repoConfigCreated).toBe(false);
      expect(outcome.userConfigChanged).toBe(false);
    },
    PROBE_TIMEOUT_MS,
  );

  // codex-223: API-key-gated proof that the same policy works through the
  // SDK adapter path and completes a real git metadata write without approval.
  gatedIt('codex', codexMissing)(
    'codex auto mode with writablePaths writes git metadata without approval',
    async (ctx) => {
      assertAcceptanceDependencies('codex', codexMissing);
      if (codexSandboxPreflight.kind === 'sandbox-init') {
        process.stderr.write(
          `codex writablePaths acceptance: skipping — Codex's workspace sandbox ` +
            `cannot initialize on this host: ${codexSandboxPreflight.summary}\n`,
        );
        ctx.skip();
      }
      if (codexSandboxPreflight.kind === 'unknown') {
        throw new Error(
          `codex writablePaths acceptance: refusing to skip — Codex sandbox ` +
            `preflight failed for a non-sandbox-init reason: ` +
            codexSandboxPreflight.summary,
        );
      }
      const outcome = await probeCodexWritablePathsWithRetry();
      const sandboxFailure = sandboxInitFailure({
        create: outcome,
        update: outcome,
        updateAttempted: true,
        createContentMatches: outcome.gitIndexWritten,
        updateContentMatches: true,
      });
      if (sandboxFailure) {
        process.stderr.write(
          `codex writablePaths acceptance: skipping — sandbox failure surfaced ` +
            `in probe events: ${sandboxFailure}\n`,
        );
        ctx.skip();
      }
      expectPhaseUnblocked('codex writablePaths git add', outcome.events);
      expect(
        outcome.gitIndexWritten,
        `codex: git index was not written under .git\n${formatEvents(outcome.events)}`,
      ).toBe(true);
      expect(outcome.repoConfigCreated).toBe(false);
      expect(outcome.userConfigChanged).toBe(false);
    },
    PROBE_TIMEOUT_MS,
  );

  const geminiMissing = missingDeps(['GEMINI_API_KEY'], ['gemini']);
  gatedIt('gemini', geminiMissing)(
    'gemini auto mode auto-approves writes and reports usage',
    async () => {
      assertAcceptanceDependencies('gemini', geminiMissing);
      const outcome = await probeWithRetry(
        'gemini',
        () => new GeminiAdapter(),
        GEMINI_MODEL,
        withIsolatedGeminiCliHome,
      );
      expectAutoMode('gemini', outcome);
      // gemini-241: the same real headless requests must cross Gemini's
      // run-owned telemetry boundary and survive strict StreamStats
      // reconciliation. Presence here proves the non-injected path works.
      expectGeminiUsage('gemini create', outcome.create.events);
      expectGeminiUsage('gemini update', outcome.update.events);
    },
    PROBE_TIMEOUT_MS,
  );

  // Kimi Code 0.39.1 gates ACP session creation on the OAuth credential written
  // by `kimi login`; an API-key provider alone cannot satisfy that gate. Local
  // runs discover the documented Kimi home, while CI requires an explicit
  // dedicated fixture. The source is never passed to the spawned process.
  // A spent rotating refresh token self-skips even under CI — see
  // `KimiAcceptanceContext.unusable`. An absent fixture still hard-fails there.
  (kimiAcceptance.unusable ? it.skip : gatedIt('kimi', kimiAcceptance.missing))(
    'kimi auto mode auto-approves a temp-file create + update',
    async () => {
      assertAcceptanceDependencies('kimi', kimiAcceptance.missing);
      const outcome = await withKimiAcceptanceEnvironment(kimiAcceptance, () =>
        probeWithRetry('kimi', () => new KimiAdapter(), undefined),
      );
      expectAutoMode('kimi', outcome);
    },
    PROBE_TIMEOUT_MS,
  );

  const opencodeMissing = missingDeps(['MOONSHOT_API_KEY'], ['opencode']);
  gatedIt('opencode', opencodeMissing)(
    'opencode auto mode auto-approves a temp-file create + update',
    async () => {
      assertAcceptanceDependencies('opencode', opencodeMissing);
      const outcome = await probeWithRetry(
        'opencode',
        () => new OpenCodeAdapter(),
        OPENCODE_MODEL,
      );
      expectAutoMode('opencode', outcome);
      // opencode-240: the resumed update run must still prove its own causal
      // boundary against the live server, which is what the dictated message
      // id destroyed. Termination and file state alone would not show it.
      expectOpenCodeUsage('opencode create', outcome.create.events);
      expectOpenCodeUsage('opencode update', outcome.update.events);
    },
    PROBE_TIMEOUT_MS,
  );
});

function expectOpenCodeUsage(
  label: string,
  events: readonly CligentEvent[],
): void {
  const done = events
    .filter((event) => event.type === 'done')
    .map((event) => event.payload as DonePayload);
  expect(done, `${label}: terminal done events`).toHaveLength(1);

  const report = done[0]?.usage.tokens;
  // A live failure here is expensive to reproduce, so every message carries
  // the report that produced it.
  const shown = JSON.stringify(report);
  // Presence is the regression guard the boundary work needs: a run that
  // cannot prove which prompt was its own omits the report entirely rather
  // than bill work it did not do.
  expect(report, `${label}: authentic token report`).toBeDefined();
  // Coverage is deliberately not pinned to 'complete'. opencode-21 degrades
  // it to 'partial' for conditions no adapter change can prevent — a provider
  // retry above all, which upstream capacity errors produce routinely, and a
  // timed-out health query. Pinning it asserted the provider's weather rather
  // than the adapter's behavior: it passed locally and failed in CI on a run
  // whose own log recorded `529 Overloaded` from upstream.
  expect(
    ['complete', 'partial'],
    `${label}: causal coverage ${shown}`,
  ).toContain(report!.coverage);
  expect(
    report!.totals.input.total,
    `${label}: input ${shown}`,
  ).toBeGreaterThan(0);
  expect(
    report!.totals.output.total,
    `${label}: output ${shown}`,
  ).toBeGreaterThan(0);
  const records = report!.records ?? [];
  expect(
    records.length,
    `${label}: per-request records ${shown}`,
  ).toBeGreaterThan(0);
  for (const record of records) {
    expect(
      record.model?.length ?? 0,
      `${label}: record model ${shown}`,
    ).toBeGreaterThan(0);
    expect(record.requests, `${label}: record request count ${shown}`).toBe(1);
  }
  // Records summing to the totals is not asserted here: buildTokenUsageReport
  // attaches records only when their sum already matches, so the check could
  // never fail. The unit suite covers that invariant where it can be violated.
}

describe('auto-mode transient retry policy (claude-code-219 / codex-219 / gemini-219 / kimi-219 / opencode-219)', () => {
  it.each([
    ['capacity status code', 'claude', { code: '429', text: '' }, '429'],
    [
      'textual transient',
      'codex',
      { text: 'upstream service unavailable' },
      'upstream service unavailable',
    ],
    [
      'exact Gemini invalid stream',
      'gemini',
      { text: GEMINI_CLI_050_INVALID_STREAM },
      GEMINI_CLI_050_INVALID_STREAM,
    ],
  ] as const)('accepts a %s', (_rule, adapter, failure, expected) => {
    expect(matchTransientFailure(adapter, failure)).toBe(expected);
  });

  it.each([
    [
      'Gemini invalid stream from a foreign adapter',
      'claude',
      { text: GEMINI_CLI_050_INVALID_STREAM },
    ],
    [
      'variant of a Gemini invalid stream',
      'gemini',
      { text: `${GEMINI_CLI_050_INVALID_STREAM} Additional diagnostics` },
    ],
    [
      'unrelated status failure',
      'claude',
      { text: 'API Error: Repeated 401 Unauthorized errors' },
    ],
  ] as const)('rejects a %s', (_rule, adapter, failure) => {
    expect(matchTransientFailure(adapter, failure)).toBeUndefined();
  });

  it('uses three fresh attempts and keeps the third transient fatal', async () => {
    const attempts: ProbeOutcome[] = [];

    await expect(
      retryExplicitTransients(
        'bounded deterministic probe',
        async () => {
          const outcome = failedProbeOutcome('529 Overloaded');
          attempts.push(outcome);
          return outcome;
        },
        (candidate) => transientFailure(candidate.create.events, 'claude'),
      ),
    ).rejects.toThrow(
      'failed after 3 consecutive transient upstream attempts: 529 Overloaded',
    );
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts).size).toBe(3);
  });

  const transientEvents = [
    failedEvent('529 Overloaded'),
    doneEvent('error', '529 Overloaded'),
  ];

  it.each([
    [
      'mixed transient and fatal phases',
      () =>
        retryableTransientFailure('claude', [
          transientEvents,
          [
            failedEvent('API Error: Repeated 401 Unauthorized errors'),
            doneEvent('error', 'API Error: Repeated 401 Unauthorized errors'),
          ],
        ]),
    ],
    [
      'missing terminal event',
      () => transientFailure([failedEvent('529 Overloaded')], 'claude'),
    ],
    [
      'permission request',
      () =>
        transientFailure(
          [
            failedEvent('529 Overloaded'),
            permissionRequestEvent(),
            doneEvent('error', '529 Overloaded'),
          ],
          'claude',
        ),
    ],
    [
      'denied tool result',
      () =>
        transientFailure(
          [
            failedEvent('529 Overloaded'),
            deniedToolResultEvent(),
            doneEvent('error', '529 Overloaded'),
          ],
          'claude',
        ),
    ],
    [
      'bad terminal status',
      () =>
        transientFailure(
          [failedEvent('529 Overloaded'), doneEvent('interrupted')],
          'claude',
        ),
    ],
    [
      'invalid create phase state',
      () =>
        retryableProbeOutcome('claude', {
          create: { events: [doneEvent('success')] },
          update: { events: transientEvents },
          updateAttempted: true,
          createContentMatches: false,
          updateContentMatches: false,
        }),
    ],
    [
      'Codex repository config mutation',
      () =>
        retryableCodexWritablePathsOutcome({
          events: transientEvents,
          gitIndexWritten: false,
          repoConfigCreated: true,
          userConfigChanged: false,
        }),
    ],
    [
      'Codex user config mutation',
      () =>
        retryableCodexWritablePathsOutcome({
          events: transientEvents,
          gitIndexWritten: false,
          repoConfigCreated: false,
          userConfigChanged: true,
        }),
    ],
  ] as const)('rejects retry for a %s', (_rule, classify) => {
    expect(classify()).toBeUndefined();
  });

  it.each([
    [GEMINI_RESULT_ERROR_REPLACEMENT, GEMINI_CLI_050_INVALID_STREAM],
    ['API key not valid', undefined],
  ] as const)(
    'correlates a Gemini invalid stream with companion %s',
    (companion, expected) => {
      const events = [
        failedEvent(GEMINI_CLI_050_INVALID_STREAM),
        failedEvent(companion, 'GEMINI_RESULT_ERROR'),
        doneEvent('error'),
      ];

      expect(transientFailure(events, 'gemini')).toBe(expected);
    },
  );
});

interface PhaseResult {
  readonly events: readonly CligentEvent[];
}

interface ProbeOutcome {
  readonly create: PhaseResult;
  readonly update: PhaseResult;
  readonly updateAttempted: boolean;
  readonly createContentMatches: boolean;
  readonly updateContentMatches: boolean;
}

function failedProbeOutcome(message: string, code?: string): ProbeOutcome {
  const error = failedEvent(message, code);
  return {
    create: { events: [error, failedDoneEvent(message)] },
    update: { events: [] },
    updateAttempted: false,
    createContentMatches: false,
    updateContentMatches: false,
  };
}

function failedEvent(message: string, code?: string): CligentEvent {
  return {
    type: 'error',
    agent: 'test',
    timestamp: 0,
    sessionId: 'credential-free-retry-test',
    payload: {
      ...(code ? { code } : {}),
      message,
      recoverable: false,
    },
  };
}

function failedDoneEvent(result?: string): CligentEvent {
  return doneEvent('error', result);
}

function doneEvent(
  status: DonePayload['status'],
  result?: string,
): CligentEvent {
  return {
    type: 'done',
    agent: 'test',
    timestamp: 0,
    sessionId: 'credential-free-retry-test',
    payload: {
      status,
      ...(result ? { result } : {}),
      usage: {
        toolUses: 0,
      },
      durationMs: 0,
    },
  };
}

function permissionRequestEvent(): CligentEvent {
  return {
    type: 'permission_request',
    agent: 'test',
    timestamp: 0,
    sessionId: 'credential-free-retry-test',
    payload: {
      toolName: 'bash',
      toolUseId: 'permission-request',
      input: {},
    },
  };
}

function deniedToolResultEvent(): CligentEvent {
  return {
    type: 'tool_result',
    agent: 'test',
    timestamp: 0,
    sessionId: 'credential-free-retry-test',
    payload: {
      toolName: 'bash',
      toolUseId: 'denied-tool',
      status: 'denied',
      output: null,
    },
  };
}

interface CodexWritablePathsOutcome extends PhaseResult {
  readonly gitIndexWritten: boolean;
  readonly repoConfigCreated: boolean;
  readonly userConfigChanged: boolean;
}

interface CodexHostileUserConfigOutcome extends PhaseResult {
  readonly control: PhaseResult;
  readonly managed: PhaseResult;
  readonly controlOutsideCreated: boolean;
  readonly controlContext: CodexNativePermissionContext | undefined;
  readonly managedContext: CodexNativePermissionContext | undefined;
}

interface CodexNativePermissionContext {
  readonly cwd: string;
  readonly approval_policy: string;
  readonly approvals_reviewer: string;
  readonly sandbox_policy: { readonly type: string };
}

interface CodexSandboxWritablePathsOutcome {
  readonly baseWriteSucceeded: boolean;
  readonly extraWriteSucceeded: boolean;
  readonly repoConfigCreated: boolean;
  readonly userConfigChanged: boolean;
  readonly summary: string;
  readonly skipReason?: string;
}

interface CodexSandboxCommandResult {
  readonly ok: boolean;
  readonly summary: string;
}

async function runAutoModeProbe(
  makeAdapter: () => AgentAdapter,
  model: string | undefined,
): Promise<ProbeOutcome> {
  // Use a repo-local workspace so Codex's `:workspace` profile, on Linux hosts
  // where its sandbox can initialize, is not subject to /tmp-related quirks
  // (`sandbox_workspace_write.exclude_slash_tmp` exists for a reason).
  const cwd = mkdtempSync(join(process.cwd(), 'cligent-automode-'));

  try {
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    const fileName = `scratch_${randomUUID().slice(0, 8)}.txt`;
    const filePath = join(cwd, fileName);
    const cligent = new Cligent(makeAdapter(), {
      permissions: { mode: 'auto' },
      cwd,
      ...(model ? { model } : {}),
    });
    const create = await collect(cligent, createPrompt(fileName));
    const createContentMatches =
      existsSync(filePath) && readFileSync(filePath, 'utf8') === 'phase-one\n';

    if (!createContentMatches || phaseHasFailure(create.events)) {
      return {
        create,
        update: { events: [] },
        updateAttempted: false,
        createContentMatches,
        updateContentMatches: false,
      };
    }

    const update = await collect(cligent, updatePrompt(fileName));
    const updateContentMatches =
      existsSync(filePath) && readFileSync(filePath, 'utf8') === 'phase-two\n';

    return {
      create,
      update,
      updateAttempted: true,
      createContentMatches,
      updateContentMatches,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function runCodexWritablePathsGitProbe(): Promise<CodexWritablePathsOutcome> {
  const cwd = mkdtempSync(join(process.cwd(), 'cligent-codex-git-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  const indexPath = join(cwd, '.git', 'index');
  rmSync(indexPath, { force: true });
  const userConfigBefore = userCodexConfigStamp();
  const cligent = new Cligent(new CodexAdapter(), {
    permissions: { mode: 'auto', writablePaths: ['.git'] },
    cwd,
  });

  try {
    const result = await collect(cligent, gitMetadataPrompt());
    return {
      ...result,
      gitIndexWritten: existsSync(indexPath),
      repoConfigCreated: existsSync(join(cwd, '.codex', 'config.toml')),
      userConfigChanged: userConfigStampChanged(userConfigBefore),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function runCodexHostileUserConfigProbe(): Promise<CodexHostileUserConfigOutcome> {
  const root = mkdtempSync(join(process.cwd(), 'cligent-codex-home-'));
  const controlCwd = join(root, 'control-workspace');
  const managedCwd = join(root, 'managed-workspace');
  const codexHome = mkdtempSync(
    join(process.cwd(), 'cligent-codex-home-config-'),
  );
  mkdirSync(controlCwd);
  mkdirSync(managedCwd);
  execFileSync('git', ['init'], { cwd: controlCwd, stdio: 'ignore' });
  execFileSync('git', ['init'], { cwd: managedCwd, stdio: 'ignore' });
  writeFileSync(
    join(codexHome, 'config.toml'),
    [
      '# Must affect no-policy runs and be ignored by permission-managed runs.',
      'sandbox_mode = "danger-full-access"',
      'approval_policy = "never"',
      '',
    ].join('\n'),
    'utf8',
  );

  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const controlFileName = `control_${randomUUID().slice(0, 8)}.txt`;
  const managedFileName = `managed_${randomUUID().slice(0, 8)}.txt`;
  const controlFilePath = join(root, controlFileName);
  const controlCligent = new Cligent(new CodexAdapter(), {
    cwd: controlCwd,
  });
  const managedCligent = new Cligent(new CodexAdapter(), {
    permissions: { mode: 'auto' },
    cwd: managedCwd,
  });

  try {
    const control = await collect(
      controlCligent,
      outsideWorkspaceWritePrompt(`../${controlFileName}`),
    );
    const managed = await collect(
      managedCligent,
      outsideWorkspaceWritePrompt(`../${managedFileName}`),
    );
    return {
      events: managed.events,
      control,
      managed,
      controlOutsideCreated: existsSync(controlFilePath),
      controlContext: await readCodexRootPermissionContext(
        codexHome,
        controlCwd,
        control,
      ),
      managedContext: await readCodexRootPermissionContext(
        codexHome,
        managedCwd,
        managed,
      ),
    };
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(root, { recursive: true, force: true });
    // Native shutdown can finish writing SQLite state and coordination locks
    // after the terminal event, so tolerate that bounded cleanup race.
    rmSync(codexHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

async function readCodexRootPermissionContext(
  codexHome: string,
  cwd: string,
  phase: PhaseResult,
): Promise<CodexNativePermissionContext | undefined> {
  const done = phase.events.find((event) => event.type === 'done')?.payload as
    DonePayload | undefined;
  // Preserve the existing named-transient retry and sandbox-init handling.
  if (done?.status !== 'success') return undefined;
  const threadId = done.resumeToken;
  if (!threadId)
    throw new Error('Codex permission evidence lacks a root thread ID');

  const findRollouts = (directory: string): string[] => {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findRollouts(path);
      return entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)
        ? [path]
        : [];
    });
  };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const paths = findRollouts(join(codexHome, 'sessions'));
    if (paths.length > 1)
      throw new Error('Codex permission evidence has duplicate root rollouts');
    if (paths[0]) {
      let rootIdentified = false;
      // Pinned Codex persists the initial context before execution. Read only
      // this root thread's isolated rollout; reviewer contexts are separate.
      for (const line of readFileSync(paths[0], 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let row: { type?: string; payload?: Record<string, unknown> };
        try {
          row = JSON.parse(line) as typeof row;
        } catch {
          throw new Error('Codex permission evidence contains malformed JSON');
        }
        if (row?.type === 'session_meta') {
          if (row.payload?.id !== threadId)
            throw new Error(
              'Codex permission evidence has mismatched root metadata',
            );
          rootIdentified = true;
        }
        if (row?.type !== 'turn_context') continue;
        const payload = row.payload;
        const sandbox = payload?.sandbox_policy as
          { type?: unknown } | undefined;
        if (
          !rootIdentified ||
          payload?.cwd !== cwd ||
          typeof payload.approval_policy !== 'string' ||
          !payload.approval_policy ||
          typeof payload.approvals_reviewer !== 'string' ||
          !payload.approvals_reviewer ||
          typeof sandbox?.type !== 'string' ||
          !sandbox.type
        ) {
          throw new Error(
            'Codex permission evidence has malformed or mismatched root context',
          );
        }
        // Do not retain or print arbitrary native context, prompts, or config.
        return {
          cwd: payload.cwd,
          approval_policy: payload.approval_policy,
          approvals_reviewer: payload.approvals_reviewer,
          sandbox_policy: { type: sandbox.type },
        };
      }
    }
    if (attempt < 9) await delay(100);
  }
  throw new Error(
    'Codex permission evidence lacks the root thread initial context',
  );
}

async function probeCodexHostileUserConfigWithRetry(): Promise<CodexHostileUserConfigOutcome> {
  return retryExplicitTransients(
    'codex user-config isolation acceptance',
    runCodexHostileUserConfigProbe,
    (outcome) => {
      const controlAssessment = assessPhaseForRetry(
        'codex',
        outcome.control.events,
      );
      if (
        !outcome.controlOutsideCreated &&
        controlAssessment.kind === 'success'
      ) {
        return undefined;
      }
      return retryableTransientFailure('codex', [
        outcome.control.events,
        outcome.managed.events,
      ]);
    },
  );
}

async function probeCodexWritablePathsWithRetry(): Promise<CodexWritablePathsOutcome> {
  return retryExplicitTransients(
    'codex writablePaths acceptance',
    runCodexWritablePathsGitProbe,
    retryableCodexWritablePathsOutcome,
  );
}

function retryableCodexWritablePathsOutcome(
  outcome: CodexWritablePathsOutcome,
): string | undefined {
  if (outcome.repoConfigCreated || outcome.userConfigChanged) {
    return undefined;
  }
  return transientFailure(outcome.events, 'codex');
}

async function runCodexWritablePathsSandboxProbe(): Promise<CodexSandboxWritablePathsOutcome> {
  const cwd = mkdtempSync(join(process.cwd(), 'cligent-codex-sandbox-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  const probePath = join(cwd, '.git', 'cligent-profile-probe');
  const userConfigBefore = userCodexConfigStamp();
  const override = codexWorkspaceExtraWritesProfileConfigOverride(['.git']);
  let cleanupWrapper: (() => Promise<void>) | undefined;

  try {
    const base = runCodexSandboxWriteProbe(cwd, ':workspace', []);
    if (sandboxInitFailureSummary(base.summary)) {
      return {
        baseWriteSucceeded: false,
        extraWriteSucceeded: false,
        repoConfigCreated: existsSync(join(cwd, '.codex', 'config.toml')),
        userConfigChanged: userConfigStampChanged(userConfigBefore),
        summary: base.summary,
        skipReason: `Codex's native sandbox cannot initialize on this host: ${base.summary}`,
      };
    }

    rmSync(probePath, { force: true });
    const wrapper = await createCodexConfigOverrideWrapper([override]);
    if (!wrapper) {
      throw new Error(
        'Codex writablePaths acceptance did not create a wrapper',
      );
    }
    cleanupWrapper = wrapper.cleanup;
    const extra = runCodexSandboxWriteProbeThroughWrapper(
      cwd,
      'cligent-workspace-extra-writes',
      wrapper.path,
    );
    if (sandboxInitFailureSummary(extra.summary)) {
      return {
        baseWriteSucceeded: base.ok,
        extraWriteSucceeded: false,
        repoConfigCreated: existsSync(join(cwd, '.codex', 'config.toml')),
        userConfigChanged: userConfigStampChanged(userConfigBefore),
        summary: extra.summary,
        skipReason: `Codex's native sandbox cannot initialize on this host: ${extra.summary}`,
      };
    }

    return {
      baseWriteSucceeded: base.ok,
      extraWriteSucceeded: extra.ok && existsSync(probePath),
      repoConfigCreated: existsSync(join(cwd, '.codex', 'config.toml')),
      userConfigChanged: userConfigStampChanged(userConfigBefore),
      summary: `base=${base.summary}; extra=${extra.summary}`,
    };
  } finally {
    await cleanupWrapper?.();
    rmSync(cwd, { recursive: true, force: true });
  }
}

function runCodexSandboxWriteProbe(
  cwd: string,
  permissionsProfile: string,
  configOverrides: readonly string[],
): CodexSandboxCommandResult {
  if (!codexCliPath) {
    return { ok: false, summary: '@openai/codex CLI is not installed' };
  }

  const args = [
    codexCliPath,
    'sandbox',
    '--permissions-profile',
    permissionsProfile,
    '-C',
    cwd,
  ];
  for (const override of configOverrides) {
    args.push('-c', override);
  }
  args.push(
    process.execPath,
    '-e',
    'require("node:fs").writeFileSync(".git/cligent-profile-probe", "ok")',
  );

  try {
    execFileSync(process.execPath, args, { stdio: 'pipe', timeout: 30_000 });
    return { ok: true, summary: 'ok' };
  } catch (error) {
    return { ok: false, summary: summarizeExecFailure(error) };
  }
}

function runCodexSandboxWriteProbeThroughWrapper(
  cwd: string,
  permissionsProfile: string,
  wrapperPath: string,
): CodexSandboxCommandResult {
  const args = [
    'sandbox',
    '--permissions-profile',
    permissionsProfile,
    '-C',
    cwd,
    process.execPath,
    '-e',
    'require("node:fs").writeFileSync(".git/cligent-profile-probe", "ok")',
  ];

  try {
    execFileSync(wrapperPath, args, { stdio: 'pipe', timeout: 30_000 });
    return { ok: true, summary: 'ok' };
  } catch (error) {
    return { ok: false, summary: summarizeExecFailure(error) };
  }
}

function createPrompt(fileName: string): string {
  const path = shellQuote(`./${fileName}`);
  return exactShellPrompt(
    `printf '%s\\n' phase-one > ${path}`,
    'created',
  );
}

function updatePrompt(fileName: string): string {
  const path = shellQuote(`./${fileName}`);
  return exactShellPrompt(
    `printf '%s\\n' phase-two > ${path}`,
    'updated',
  );
}

function outsideWorkspaceWritePrompt(relativePath: string): string {
  const path = shellQuote(relativePath);
  return exactShellPrompt(
    `printf '%s\\n' outside > ${path} && test -f ${path}`,
    'outside',
  );
}

function gitMetadataPrompt(): string {
  return exactShellPrompt(
    `printf '%s\\n' tracked > tracked.txt && git add tracked.txt && ` +
      `test -f .git/index`,
    'indexed',
  );
}

function exactShellPrompt(command: string, successWord: string): string {
  return [
    'Run this exact shell command in the current working directory:',
    '```sh',
    command,
    '```',
    `Do not ask for permission or confirmation. After it succeeds, reply only "${successWord}".`,
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function collect(cligent: Cligent, prompt: string): Promise<PhaseResult> {
  const events: CligentEvent[] = [];
  for await (const event of cligent.run(prompt)) {
    events.push(event);
  }
  return { events };
}

async function probeWithRetry(
  adapter: ProbeAdapter,
  makeAdapter: () => AgentAdapter,
  model: string | undefined,
  attemptScope?: (run: () => Promise<ProbeOutcome>) => Promise<ProbeOutcome>,
): Promise<ProbeOutcome> {
  return retryExplicitTransients(
    `${adapter} auto-mode acceptance`,
    () => {
      const run = () => runAutoModeProbe(makeAdapter, model);
      return attemptScope ? attemptScope(run) : run();
    },
    (outcome) => retryableProbeOutcome(adapter, outcome),
  );
}

function retryableProbeOutcome(
  adapter: ProbeAdapter,
  outcome: ProbeOutcome,
): string | undefined {
  if (outcome.updateAttempted && !outcome.createContentMatches) {
    return undefined;
  }
  return retryableTransientFailure(
    adapter,
    outcome.updateAttempted
      ? [outcome.create.events, outcome.update.events]
      : [outcome.create.events],
  );
}

async function retryExplicitTransients<T>(
  label: string,
  runFreshProbe: () => Promise<T>,
  findTransient: (outcome: T) => string | undefined,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_PROBE_ATTEMPTS; attempt++) {
    const outcome = await runFreshProbe();
    const transient = findTransient(outcome);
    if (!transient) return outcome;
    if (attempt === MAX_PROBE_ATTEMPTS) {
      throw new Error(
        `${label} failed after ${MAX_PROBE_ATTEMPTS} consecutive transient ` +
          `upstream attempts: ${transient}`,
      );
    }
    process.stderr.write(
      `${label} attempt ${attempt} hit transient upstream error: ${transient}\n`,
    );
  }
  throw new Error(`${label} exhausted its retry loop unexpectedly`);
}

// Keep competing auth and model routes inactive so workspace .env discovery
// cannot override the explicit API key or the harness-selected model policy.
const GEMINI_ISOLATED_ENV_KEYS = [
  'GEMINI_MODEL',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GEMINI_BASE_URL',
  'GEMINI_CLI_USE_COMPUTE_ADC',
  'CLOUD_SHELL',
] as const;

async function withIsolatedGeminiCliHome<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'cligent-gemini-live-'));
  const previousHome = process.env.GEMINI_CLI_HOME;
  const previousConflicts = new Map<string, string | undefined>(
    GEMINI_ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  process.env.GEMINI_CLI_HOME = home;
  for (const key of GEMINI_ISOLATED_ENV_KEYS) {
    // Keep the key present so Gemini's workspace .env loader cannot restore
    // a competing auth or model route from the repository under test.
    process.env[key] = '';
  }

  try {
    return await run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.GEMINI_CLI_HOME;
    } else {
      process.env.GEMINI_CLI_HOME = previousHome;
    }
    for (const [key, value] of previousConflicts) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function transientFailure(
  events: readonly CligentEvent[],
  adapter: ProbeAdapter,
): string | undefined {
  return retryableTransientFailure(adapter, [events]);
}

function retryableTransientFailure(
  adapter: ProbeAdapter,
  eventGroups: readonly (readonly CligentEvent[])[],
): string | undefined {
  let firstTransient: string | undefined;
  for (const events of eventGroups) {
    const assessment = assessPhaseForRetry(adapter, events);
    if (assessment.kind === 'fatal') return undefined;
    if (assessment.kind === 'transient') {
      firstTransient ??= assessment.summary;
    }
  }
  return firstTransient;
}

function phaseHasFailure(events: readonly CligentEvent[]): boolean {
  const doneEvents = events.filter((event) => event.type === 'done');
  if (doneEvents.length !== 1) return true;
  if ((doneEvents[0]!.payload as DonePayload).status !== 'success') return true;
  return events.some(
    (event) =>
      event.type === 'error' ||
      event.type === 'permission_request' ||
      (event.type === 'tool_result' &&
        (event.payload as ToolResultPayload).status !== 'success'),
  );
}

interface FailureSignal {
  readonly code?: string;
  readonly text: string;
}

type PhaseRetryAssessment =
  | { readonly kind: 'success' }
  | { readonly kind: 'transient'; readonly summary: string }
  | { readonly kind: 'fatal' };

function assessPhaseForRetry(
  adapter: ProbeAdapter,
  events: readonly CligentEvent[],
): PhaseRetryAssessment {
  if (
    events.length === 0 ||
    events.some(
      (event) =>
        event.type === 'permission_request' ||
        (event.type === 'tool_result' &&
          (event.payload as ToolResultPayload).status !== 'success'),
    )
  ) {
    return { kind: 'fatal' };
  }

  const doneEvents = events.filter((event) => event.type === 'done');
  if (doneEvents.length !== 1) return { kind: 'fatal' };
  const done = doneEvents[0]!.payload as DonePayload;
  const rawFailures = events
    .filter((event) => event.type === 'error')
    .map((event) => {
      const payload = event.payload as ErrorPayload;
      return { code: payload.code, text: payload.message };
    });

  if (done.status === 'success') {
    return rawFailures.length === 0 ? { kind: 'success' } : { kind: 'fatal' };
  }
  if (done.status !== 'error') return { kind: 'fatal' };

  const geminiInvalidStream =
    adapter === 'gemini'
      ? rawFailures
          .map((failure) => matchGeminiInvalidStream(failure))
          .find((summary) => summary !== undefined)
      : undefined;
  const transientSummaries = new Set<string>();

  for (const failure of rawFailures) {
    if (
      geminiInvalidStream &&
      failure.code?.trim().toUpperCase() === 'GEMINI_RESULT_ERROR' &&
      failure.text.trim() === GEMINI_RESULT_ERROR_REPLACEMENT
    ) {
      continue;
    }
    const transient = matchTransientFailure(adapter, failure);
    if (!transient) return { kind: 'fatal' };
    transientSummaries.add(transient);
  }

  const doneText = done.result?.trim() ?? '';
  if (
    doneText &&
    !(geminiInvalidStream && doneText === GEMINI_RESULT_ERROR_REPLACEMENT)
  ) {
    const transient = matchTransientFailure(adapter, { text: doneText });
    if (!transient) return { kind: 'fatal' };
    transientSummaries.add(transient);
  }

  if (transientSummaries.size === 0) return { kind: 'fatal' };
  return {
    kind: 'transient',
    summary: geminiInvalidStream ?? [...transientSummaries][0]!,
  };
}

function matchGeminiInvalidStream(failure: FailureSignal): string | undefined {
  const code = failure.code?.trim().toUpperCase();
  const text = failure.text.trim();
  if (
    code === 'INVALID_STREAM' ||
    GEMINI_CLI_050_INVALID_STREAM_MESSAGES.has(text)
  ) {
    return text || code;
  }
  return undefined;
}

function matchTransientFailure(
  adapter: ProbeAdapter,
  failure: FailureSignal,
): string | undefined {
  const code = failure.code?.trim().toUpperCase();
  const text = failure.text.trim();
  const summary = text || code;
  if (!summary) return undefined;

  if (
    (code && TRANSIENT_UPSTREAM_CODES.has(code)) ||
    TRANSIENT_UPSTREAM_MARKERS.some((pattern) => pattern.test(text))
  ) {
    return summary;
  }

  if (adapter === 'gemini') return matchGeminiInvalidStream(failure);

  return undefined;
}

function resolveCodexCliPath(): string | undefined {
  try {
    return resolveCodexBinPath();
  } catch {
    return undefined;
  }
}

type CodexSandboxPreflight =
  | { kind: 'ok' }
  | { kind: 'sandbox-init'; summary: string }
  | { kind: 'unknown'; summary: string };

// Credential-free preflight via Codex's own sandbox subcommand. Classifies
// the outcome so only OS-sandbox-init failures (matching SANDBOX_INIT_MARKERS)
// produce a skip; non-Linux hosts and an unresolvable codex CLI bin classify
// as `ok` (let the test run; the post-flight backstop catches anything the
// preflight missed). Any other preflight failure — CLI surface drift, missing
// platform helper, config parse error, launcher panic, timeout — classifies
// as `unknown`, so it surfaces as a test failure instead of a silent skip.
function preflightCodexSandbox(): CodexSandboxPreflight {
  if (process.platform !== 'linux') return { kind: 'ok' };
  if (!codexCliPath) return { kind: 'ok' };
  try {
    execFileSync(
      process.execPath,
      [
        codexCliPath,
        'sandbox',
        'linux',
        '--permissions-profile',
        ':workspace',
        '-C',
        process.cwd(),
        'true',
      ],
      { stdio: 'pipe', timeout: 10_000 },
    );
    return { kind: 'ok' };
  } catch (error) {
    const summary = summarizeExecFailure(error);
    if (SANDBOX_INIT_MARKERS.some((marker) => marker.test(summary))) {
      return { kind: 'sandbox-init', summary };
    }
    return { kind: 'unknown', summary };
  }
}

function summarizeExecFailure(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string } | null)?.stderr;
  const stderrText = Buffer.isBuffer(stderr)
    ? stderr.toString('utf8')
    : (stderr ?? '');
  const message = (error as { message?: string } | null)?.message ?? '';
  return (stderrText || message || String(error))
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

function sandboxInitFailureSummary(text: string): boolean {
  return SANDBOX_INIT_MARKERS.some((marker) => marker.test(text));
}

// A non-functional Codex OS sandbox (e.g. bubblewrap failing to set up its
// network namespace on a restricted CI runner) surfaces in the event stream
// rather than as an `error` event, so it is detected from the probe outcome.
function sandboxInitFailure(outcome: ProbeOutcome): string | undefined {
  for (const phase of [outcome.create, outcome.update]) {
    const failure = sandboxInitFailureFromEvents(phase.events);
    if (failure) return failure;
  }
  return undefined;
}

function sandboxInitFailureFromEvents(
  events: readonly CligentEvent[],
): string | undefined {
  for (const event of events) {
    const text = JSON.stringify(event.payload);
    if (SANDBOX_INIT_MARKERS.some((marker) => marker.test(text))) {
      return text.replace(/\s+/g, ' ').slice(0, 300);
    }
  }
  return undefined;
}

function userCodexConfigPath(): string {
  return join(
    process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    'config.toml',
  );
}

function userCodexConfigStamp(): string | undefined {
  try {
    const path = userCodexConfigPath();
    const before = statSync(path, { bigint: true });
    const content = readFileSync(path);
    const after = statSync(path, { bigint: true });
    const beforeMetadata = `${before.dev}:${before.ino}:${before.mtimeNs}:${before.size}`;
    const afterMetadata = `${after.dev}:${after.ino}:${after.mtimeNs}:${after.size}`;
    const digest = createHash('sha256').update(content).digest('hex');
    return `${beforeMetadata}:${afterMetadata}:${digest}`;
  } catch {
    return undefined;
  }
}

function userConfigStampChanged(before: string | undefined): boolean {
  return userCodexConfigStamp() !== before;
}

function expectAutoMode(label: string, outcome: ProbeOutcome): void {
  expectPhaseUnblocked(`${label} create`, outcome.create.events);
  expect(
    outcome.createContentMatches,
    `${label}: file did not have the expected phase-one contents after create\n${formatEvents(outcome.create.events)}`,
  ).toBe(true);
  expect(
    outcome.updateAttempted,
    `${label}: update phase was not attempted`,
  ).toBe(true);
  expectPhaseUnblocked(`${label} update`, outcome.update.events);
  expect(
    outcome.updateContentMatches,
    `${label}: file did not have the expected phase-two contents after update\n${formatEvents(outcome.update.events)}`,
  ).toBe(true);
}

function expectGeminiUsage(
  label: string,
  events: readonly CligentEvent[],
): void {
  const donePayloads = events
    .filter((event) => event.type === 'done')
    .map((event) => event.payload as DonePayload);
  expect(donePayloads, `${label}: terminal done events`).toHaveLength(1);

  const report = donePayloads[0]?.usage.tokens;
  expect(
    report,
    `${label}: real Gemini telemetry did not reconcile to StreamStats\n${formatEvents(events)}`,
  ).toBeDefined();
  expect(report!.totals.input.total, `${label}: input tokens`).toBeGreaterThan(
    0,
  );
  expect(
    report!.totals.output.total,
    `${label}: output tokens`,
  ).toBeGreaterThan(0);
  expect(
    report!.records?.length ?? 0,
    `${label}: per-response records`,
  ).toBeGreaterThan(0);

  for (const record of report!.records ?? []) {
    expect(record.model?.length ?? 0, `${label}: record model`).toBeGreaterThan(
      0,
    );
    expect(
      record.provider?.length ?? 0,
      `${label}: record rate-card family`,
    ).toBeGreaterThan(0);
    expect(record.requests, `${label}: record request count`).toBe(1);
  }
}

function formatEvents(events: readonly CligentEvent[]): string {
  return JSON.stringify(
    events.map((event) => ({
      type: event.type,
      payload: event.payload,
    })),
    null,
    2,
  );
}

function expectPhaseUnblocked(
  label: string,
  events: readonly CligentEvent[],
): void {
  const permissionRequests = events.filter(
    (event) => event.type === 'permission_request',
  );
  const deniedTools = events
    .filter((event) => event.type === 'tool_result')
    .map((event) => event.payload as ToolResultPayload)
    .filter((payload) => payload.status === 'denied');
  const errorMessages = events
    .filter((event) => event.type === 'error')
    .map((event) => (event.payload as ErrorPayload).message);
  const done = events.find((event) => event.type === 'done');
  const doneStatus = done ? (done.payload as DonePayload).status : undefined;

  expect(
    permissionRequests,
    `${label}: emitted permission_request — auto mode did not auto-approve`,
  ).toEqual([]);
  expect(
    deniedTools.map((payload) => payload.toolName),
    `${label}: produced denied tool results`,
  ).toEqual([]);
  expect(errorMessages, `${label}: emitted error events`).toEqual([]);
  expect(doneStatus, `${label}: terminal done status`).toBe('success');
}

function expectRunCompletedWithoutAdapterError(
  label: string,
  events: readonly CligentEvent[],
): void {
  const errorMessages = events
    .filter((event) => event.type === 'error')
    .map((event) => (event.payload as ErrorPayload).message);
  const done = events.find((event) => event.type === 'done');
  const doneStatus = done ? (done.payload as DonePayload).status : undefined;

  expect(errorMessages, `${label}: emitted error events`).toEqual([]);
  expect(doneStatus, `${label}: terminal done status`).toBe('success');
}

function missingDeps(
  envKeys: readonly string[],
  commands: readonly string[] = [],
): string[] {
  const missing: string[] = [];
  for (const key of envKeys) {
    if (!process.env[key]) missing.push(key);
  }
  for (const command of commands) {
    try {
      execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 5_000 });
    } catch {
      missing.push(`${command} CLI on PATH`);
    }
  }
  return missing;
}

// Acceptance files are excluded from the standard CI matrix; when the
// acceptance config does load this file, CI hard-fails on a missing dependency
// instead of silently skipping. Locally, a missing dependency skips only the
// affected adapter.
function gatedIt(
  adapter: string,
  missing: readonly string[],
): typeof it | typeof it.skip {
  return gateAcceptanceTest(it, it.skip, adapter, missing);
}
