#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EXPECTED_PROTOCOL_VERSIONS,
  EXPECTED_SDK_VERSIONS,
} from './verify-agent-targets.mjs';
import { AGENT_RUNTIME_TARGETS } from '../dist/runtime-targets.js';

const PACKAGE_NAME = '@sublang/cligent';
const NODE_RUNTIME_VERSION = '18.3.0';
const TYPESCRIPT_VERSION = '5.4.5';
const NODE_TYPES_VERSION = '18.19.24';
const EXPECTED_RUNTIME_DEPENDENCIES = Object.freeze({
  '@agentclientprotocol/sdk': '1.4.0',
  yaml: '^2.8.4',
  zod: '4.4.3',
});
// package-26: derived from the shipped descriptor, never restated here. A
// second copy of a floor is exactly the drift this work removes.
const EXPECTED_OPTIONAL_PEERS = Object.freeze(
  Object.fromEntries(
    Object.values(AGENT_RUNTIME_TARGETS)
      .flat()
      .filter((target) => target.kind === 'peer')
      .map((target) => [target.package, `>=${target.supportedFrom}`]),
  ),
);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Canonical, because tmux-play reports the tree it actually resolves from and
// macOS exposes the same temporary directory through both /var and /private/var.
const verificationRoot = realpathSync(
  mkdtempSync(join(tmpdir(), 'cligent-distributable-')),
);
const npmCache = join(verificationRoot, 'npm-cache');
const packDirectory = join(verificationRoot, 'pack');
const consumerDirectory = join(verificationRoot, 'consumer');
const codexGlobalPrefix = join(verificationRoot, 'codex-global');
const codexNestedConsumerDirectory = join(
  verificationRoot,
  'codex-nested-consumer',
);
const CLAUDE_PROBE_FILENAME = 'claude-runtime-authority-probe.mjs';
const CODEX_PROBE_FILENAME = 'codex-resolution-probe.mjs';
const codexProbeHomeDirectory = join(verificationRoot, 'codex-home');
const codexProbeWorkDirectory = join(verificationRoot, 'codex-probe-workdir');
const claudeSdkInstallSpec = `@anthropic-ai/claude-agent-sdk@${EXPECTED_SDK_VERSIONS['@anthropic-ai/claude-agent-sdk']}`;
const codexSdkInstallSpec = `@openai/codex-sdk@${EXPECTED_SDK_VERSIONS['@openai/codex-sdk']}`;
const RUNTIME_DECOY_VERSION = '99.99.99';
const tmuxPlayGlobalPrefix = join(verificationRoot, 'tmux-play-global');
const tmuxPlayHarnessBin = join(verificationRoot, 'tmux-play-harness-bin');
const tmuxPlayConfigHome = join(verificationRoot, 'tmux-play-xdg');
const tmuxPlayHome = join(verificationRoot, 'tmux-play-home');
const tmuxPlayWorkDirectory = join(verificationRoot, 'tmux-play-workdir');
const tmuxPlayTmp = join(verificationRoot, 'tmux-play-tmp');
const tmuxPlayLog = join(verificationRoot, 'tmux-play-tmux.jsonl');
const tmuxPlayHomeConfig = join(tmuxPlayConfigHome, 'tmux-play', 'config.yaml');

function fail(message) {
  throw new Error(`distributable verification: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      npm_config_fund: 'false',
      ...options.env,
    },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const output = `${stdout}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`;

  if (result.error) {
    fail(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} exited ${String(result.status)}${
        output.trim() ? `:\n${output.trim()}` : ''
      }`,
    );
  }

  return { stdout, stderr, output };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    fail(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function assertRuntimeDependencyShape(
  packageName,
  manifest,
  expectedPeerDependencies = {},
) {
  assertDeepEqual(
    manifest.dependencies ?? {},
    {},
    `${packageName} transitive runtime dependencies`,
  );
  assertDeepEqual(
    manifest.optionalDependencies ?? {},
    {},
    `${packageName} optional transitive runtime dependencies`,
  );
  assertDeepEqual(
    manifest.peerDependencies ?? {},
    expectedPeerDependencies,
    `${packageName} runtime peer dependencies`,
  );
  assertDeepEqual(
    manifest.bundleDependencies ?? manifest.bundledDependencies ?? [],
    [],
    `${packageName} bundled transitive runtime dependencies`,
  );
}

function parsePackResult(stdout) {
  const start = stdout.search(/\[\s*\{/);
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) {
    fail(`npm pack did not return JSON metadata:\n${stdout.trim()}`);
  }

  let result;
  try {
    result = JSON.parse(stdout.slice(start, end + 1));
  } catch (error) {
    fail(
      `npm pack returned invalid JSON metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Array.isArray(result) || result.length !== 1) {
    fail('npm pack did not describe exactly one tarball');
  }
  return result[0];
}

function assertManifestPlacement(manifest, label) {
  assertEqual(manifest.name, PACKAGE_NAME, `${label} package name`);
  assertEqual(manifest.engines?.node, '>=18.3.0', `${label} Node floor`);
  assertDeepEqual(
    manifest.dependencies ?? {},
    EXPECTED_RUNTIME_DEPENDENCIES,
    `${label} runtime dependencies`,
  );
  assertDeepEqual(
    manifest.optionalDependencies ?? {},
    {},
    `${label} optional dependencies`,
  );
  assertDeepEqual(
    manifest.bundleDependencies ?? manifest.bundledDependencies ?? [],
    [],
    `${label} bundled dependencies`,
  );
  assertDeepEqual(
    manifest.peerDependencies ?? {},
    EXPECTED_OPTIONAL_PEERS,
    `${label} agent peers`,
  );

  const expectedPeerMeta = Object.fromEntries(
    Object.keys(EXPECTED_OPTIONAL_PEERS).map((packageName) => [
      packageName,
      { optional: true },
    ]),
  );
  assertDeepEqual(
    manifest.peerDependenciesMeta ?? {},
    expectedPeerMeta,
    `${label} optional peer metadata`,
  );

  for (const [packageName, version] of Object.entries(EXPECTED_SDK_VERSIONS)) {
    if (manifest.dependencies?.[packageName] !== undefined) {
      fail(`${label} places ${packageName} in runtime dependencies`);
    }
    if (manifest.optionalDependencies?.[packageName] !== undefined) {
      fail(`${label} places ${packageName} in optionalDependencies`);
    }
    if (label === 'repository') {
      assertEqual(
        manifest.devDependencies?.[packageName],
        version,
        `${label} exact ${packageName} development target`,
      );
    }
  }

  for (const [packageName, version] of Object.entries(
    EXPECTED_PROTOCOL_VERSIONS,
  )) {
    assertEqual(
      manifest.dependencies?.[packageName],
      version,
      `${label} exact ${packageName} runtime target`,
    );
    if (manifest.devDependencies?.[packageName] !== undefined) {
      fail(`${label} duplicates ${packageName} in devDependencies`);
    }
    if (manifest.optionalDependencies?.[packageName] !== undefined) {
      fail(`${label} places ${packageName} in optionalDependencies`);
    }
  }
}

function packagedTargets(manifest) {
  const targets = new Set(['package.json', 'LICENSE', 'README.md']);

  for (const value of [manifest.main, manifest.types]) {
    if (typeof value === 'string') targets.add(value.replace(/^\.\//, ''));
  }
  for (const value of Object.values(manifest.bin ?? {})) {
    if (typeof value === 'string') targets.add(value.replace(/^\.\//, ''));
  }
  for (const conditions of Object.values(manifest.exports ?? {})) {
    if (typeof conditions === 'string') {
      targets.add(conditions.replace(/^\.\//, ''));
      continue;
    }
    for (const value of Object.values(conditions ?? {})) {
      if (typeof value === 'string') targets.add(value.replace(/^\.\//, ''));
    }
  }

  return targets;
}

function assertTarballManifest(packed, manifest) {
  if (!packed || typeof packed.filename !== 'string') {
    fail('npm pack metadata did not include a tarball filename');
  }
  const tarballPath = join(packDirectory, packed.filename);
  if (!existsSync(tarballPath)) {
    fail(`npm pack did not create ${packed.filename}`);
  }

  const packedPaths = new Set(
    Array.isArray(packed.files)
      ? packed.files.map((file) => file?.path).filter(Boolean)
      : [],
  );
  for (const target of packagedTargets(manifest)) {
    if (!packedPaths.has(target)) {
      fail(`tarball omitted public package target ${target}`);
    }
  }
  for (const path of packedPaths) {
    if (
      path.startsWith('src/') ||
      path.startsWith('scripts/') ||
      path.startsWith('node_modules/')
    ) {
      fail(`tarball unexpectedly contains repository-only path ${path}`);
    }
  }

  return tarballPath;
}

function assertAuditClean(label, args) {
  const { stdout } = run(npm, args);
  let audit;
  try {
    audit = JSON.parse(stdout);
  } catch (error) {
    fail(
      `${label} audit did not return JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const vulnerabilities = audit.metadata?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities.total !== 'number') {
    fail(`${label} audit omitted vulnerability metadata`);
  }
  if (vulnerabilities.total !== 0) {
    fail(
      `${label} audit reported vulnerabilities: ${JSON.stringify(vulnerabilities)}`,
    );
  }
}

function writeConsumerFiles() {
  writeFileSync(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'cligent-distributable-consumer',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  writeFileSync(
    join(consumerDirectory, 'runtime-consumer.mjs'),
    `import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

const expectedVersion = 'v${NODE_RUNTIME_VERSION}';
if (process.version !== expectedVersion) {
  throw new Error(\`expected Node \${expectedVersion}, received \${process.version}\`);
}

const nodeModulesRoot = join(process.cwd(), 'node_modules');
// codex-47: the adapter subpath remains importable without its optional peer.
const [root, claude, codex, gemini, kimi, opencode, tmuxPlay, fanout] =
  await Promise.all([
    import('@sublang/cligent'),
    import('@sublang/cligent/adapters/claude-code'),
    import('@sublang/cligent/adapters/codex'),
    import('@sublang/cligent/adapters/gemini'),
    import('@sublang/cligent/adapters/kimi'),
    import('@sublang/cligent/adapters/opencode'),
    import('@sublang/cligent/tmux-play'),
    import('@sublang/cligent/captains/fanout'),
  ]);

for (const [label, value] of [
  ['root Cligent', root.Cligent],
  ['ClaudeCodeAdapter', claude.ClaudeCodeAdapter],
  ['CodexAdapter', codex.CodexAdapter],
  ['GeminiAdapter', gemini.GeminiAdapter],
  ['KimiAdapter', kimi.KimiAdapter],
  ['OpenCodeAdapter', opencode.OpenCodeAdapter],
  ['TmuxPlayRuntime', tmuxPlay.TmuxPlayRuntime],
  ['FanoutCaptain', fanout.FanoutCaptain],
  ['fanout default factory', fanout.default],
  ['getFastModeSupport', root.getFastModeSupport],
  ['isFastModeSupported', root.isFastModeSupported],
  ['assertFastModeSupported', root.assertFastModeSupported],
  ['estimateCost', root.estimateCost],
  ['getDefaultPricingCachePath', root.getDefaultPricingCachePath],
]) {
  if (typeof value !== 'function') throw new Error(\`missing public export \${label}\`);
}
if (root.EFFORT_SUPPORT['claude-code'].values.at(-1) !== 'ultracode') {
  throw new Error('root effort metadata is unavailable or stale');
}
if (root.EFFORT_SUPPORT.codex.values.at(-1) !== 'ultra') {
  throw new Error('Codex effort metadata is unavailable or stale');
}
if (root.EFFORT_SUPPORT.kimi.values.join(',') !== 'off,on') {
  throw new Error('Kimi effort metadata is unavailable or stale');
}
const expectedFastModeSupport = {
  'claude-code': [true, 'init-and-done', true, true],
  codex: [true, 'none', true, true],
  gemini: [false, 'none', false, false],
  kimi: [false, 'none', false, false],
  opencode: [false, 'none', false, false],
};
if (!Object.isFrozen(root.FAST_MODE_SUPPORT)) {
  throw new Error('root fast-mode metadata is mutable');
}
for (const [agent, expected] of Object.entries(expectedFastModeSupport)) {
  const support = root.FAST_MODE_SUPPORT[agent];
  const actual = support && [
    support.requestSupported,
    support.observation,
    support.modelDependent,
    support.accountDependent,
  ];
  if (
    support === undefined ||
    !Object.isFrozen(support) ||
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    typeof support.notes !== 'string' ||
    support.notes.length === 0
  ) {
    throw new Error(\`\${agent} fast-mode metadata is unavailable or stale\`);
  }
}
if (
  root.getFastModeSupport('claude') !==
    root.FAST_MODE_SUPPORT['claude-code'] ||
  !root.isFastModeSupported('codex') ||
  root.isFastModeSupported('gemini')
) {
  throw new Error('root fast-mode helpers are unavailable or stale');
}
root.assertFastModeSupported('codex');

// cost-estimation-15: exercise the installed public API on the Node floor.
const cachePath = root.getDefaultPricingCachePath();
if (typeof cachePath !== 'string' || !isAbsolute(cachePath)) {
  throw new Error('default pricing cache path is not an absolute string');
}
const callerCachePath = join(process.cwd(), 'caller-pricing-must-not-write.json');
const prices = { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3, reasoning: 20 };
const costUsage = {
  toolUses: 2,
  cost: { amount: 7, currency: 'USD', source: 'provider-reported' },
  tokens: {
    coverage: 'partial',
    totals: {
      input: { total: 1_000_000, uncached: 500_000, cacheRead: 250_000, cacheWrite: 250_000 },
      output: { total: 200_000, visible: 100_000, reasoning: 100_000 },
    },
  },
};
const costUsageBefore = JSON.stringify(costUsage);
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('caller prices attempted network access'); };
try {
  const estimatePromise = root.estimateCost(costUsage, { prices, cachePath: callerCachePath });
  if (!(estimatePromise instanceof Promise)) {
    throw new Error('estimateCost did not return a Promise');
  }
  const estimate = await estimatePromise;
  // 0.5M * $2 + 0.25M * $0.50 + 0.25M * $3 + 0.1M * $10 + 0.1M * $20.
  if (
    estimate.status !== 'estimated' ||
    Math.abs(estimate.amount - 4.875) > 1e-12 ||
    estimate.coverage !== 'partial' ||
    estimate.currency !== 'USD' ||
    estimate.source.type !== 'caller' ||
    estimate.records.length !== 1 ||
    Math.abs(estimate.records[0].amount - 4.875) > 1e-12
  ) {
    throw new Error('installed estimator did not preserve inclusive subset arithmetic');
  }
  const zero = await root.estimateCost({
    toolUses: 0,
    tokens: { coverage: 'complete', totals: { input: { total: 0 }, output: { total: 0 } } },
  }, { prices: { input: 0, output: 0 }, cachePath: callerCachePath });
  if (zero.status !== 'estimated' || zero.amount !== 0 || zero.coverage !== 'complete') {
    throw new Error('installed estimator did not preserve authentic zero usage and rates');
  }
  const unavailable = await root.estimateCost({ toolUses: 0 }, { prices });
  if (unavailable.status !== 'unavailable' || unavailable.reason !== 'tokens-unavailable') {
    throw new Error('installed estimator did not distinguish absent tokens');
  }
  if (JSON.stringify(costUsage) !== costUsageBefore || existsSync(callerCachePath)) {
    throw new Error('caller-price estimation mutated usage or created a pricing cache');
  }
} finally {
  globalThis.fetch = originalFetch;
}

const installedBin = join(
  nodeModulesRoot,
  '.bin',
  process.platform === 'win32' ? 'tmux-play.cmd' : 'tmux-play',
);
if (!existsSync(installedBin)) throw new Error('installed tmux-play bin link is missing');

const help = spawnSync(
  installedBin,
  ['--help'],
  {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: [dirname(process.execPath), process.env.PATH]
        .filter(Boolean)
        .join(delimiter),
    },
    shell: process.platform === 'win32',
  },
);
const helpOutput = \`\${help.stdout ?? ''}\n\${help.stderr ?? ''}\`;
if (help.error) throw help.error;
if (help.status !== 0 || !/Usage:\\r?\\n  tmux-play/.test(helpOutput)) {
  throw new Error(\`installed tmux-play --help failed: \${helpOutput.trim()}\`);
}

process.stdout.write(
  'Node 18.3.0 peer-free imports, cost estimation and installed launcher verified.\\n',
);
`,
    'utf8',
  );

  writeFileSync(
    join(consumerDirectory, 'type-consumer.ts'),
    `import {
  Cligent,
  EFFORT_SUPPORT,
  FAST_MODE_SUPPORT,
  assertFastModeSupported,
  getFastModeSupport,
  isFastModeSupported,
  estimateCost,
  getDefaultPricingCachePath,
  type CostEstimationOptions,
  type CostEstimationUnavailableReason,
  type CostEstimateRecord,
  type CostEstimateResult,
  type TokenPrices,
  type ClaudeEffort,
  type CodexEffort,
  type DonePayload,
  type FastModeObservation,
  type FastModeTerminalObservation,
  type GeminiEffort,
  type InitPayload,
  type KimiEffort,
  type OpenCodeEffort,
} from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';
import { GeminiAdapter } from '@sublang/cligent/adapters/gemini';
import { KimiAdapter } from '@sublang/cligent/adapters/kimi';
import { OpenCodeAdapter } from '@sublang/cligent/adapters/opencode';
import type {
  AgentCallSettings,
  Captain,
  CaptainConfig,
  PlayerConfig,
} from '@sublang/cligent/tmux-play';
import createFanoutCaptain, {
  FanoutCaptain,
} from '@sublang/cligent/captains/fanout';

const claude = new Cligent(new ClaudeCodeAdapter(), {
  effort: 'ultracode',
  fastMode: true,
});
const codex = new Cligent(new CodexAdapter(), {
  effort: 'ultra',
  fastMode: false,
});
const gemini = new Cligent(new GeminiAdapter(), { effort: 'max' });
const kimi = new Cligent(new KimiAdapter(), { effort: 'on' });
const opencode = new Cligent(new OpenCodeAdapter(), { effort: 'minimal' });

claude.run('typed consumer', { effort: 'ultracode', fastMode: false });
codex.run('typed consumer', { effort: 'ultra', fastMode: true });
gemini.run('typed consumer', { effort: 'xhigh' });
kimi.run('typed consumer', { effort: 'off' });
opencode.run('typed consumer', { effort: 'high' });
// @ts-expect-error Codex-native effort must not reach Claude.
claude.run('typed consumer', { effort: 'ultra' });
// @ts-expect-error Claude-native effort must not reach Codex.
codex.run('typed consumer', { effort: 'ultracode' });
// @ts-expect-error Gemini accepts only portable effort values.
gemini.run('typed consumer', { effort: 'ultra' });
// @ts-expect-error OpenCode accepts only portable effort values.
opencode.run('typed consumer', { effort: 'ultracode' });
// @ts-expect-error Kimi accepts only its binary native effort values.
kimi.run('typed consumer', { effort: 'high' });
// @ts-expect-error Gemini exposes no native fast-mode request surface.
gemini.run('typed consumer', { fastMode: false });
// @ts-expect-error OpenCode exposes no native fast-mode request surface.
opencode.run('typed consumer', { fastMode: true });
// @ts-expect-error Kimi exposes no native fast-mode request surface.
kimi.run('typed consumer', { fastMode: false });

const claudeValues: readonly ClaudeEffort[] = EFFORT_SUPPORT['claude-code'].values;
const codexValues: readonly CodexEffort[] = EFFORT_SUPPORT.codex.values;
const geminiValues: readonly GeminiEffort[] = EFFORT_SUPPORT.gemini.values;
const kimiValues: readonly KimiEffort[] = EFFORT_SUPPORT.kimi.values;
const opencodeValues: readonly OpenCodeEffort[] = EFFORT_SUPPORT.opencode.values;
const claudeFastModeSupport = getFastModeSupport('claude');
const codexFastModeSupported: boolean = isFastModeSupported('codex');
const claudeFastModeObservation: 'init-and-done' =
  FAST_MODE_SUPPORT['claude-code'].observation;
assertFastModeSupported('codex');

const initFastMode: FastModeObservation = {
  state: 'on',
  disabledReason: 'pending',
};
const doneFastMode: FastModeTerminalObservation = {
  state: 'cooldown',
  responseSpeed: 'standard',
};
const initPayload: InitPayload = {
  model: 'claude-opus-4-8',
  cwd: '.',
  tools: [],
  fastMode: initFastMode,
};
const donePayload: DonePayload = {
  status: 'success',
  usage: { toolUses: 0 },
  durationMs: 0,
  fastMode: doneFastMode,
};
const invalidInitFastMode: FastModeObservation = {
  // @ts-expect-error Response speed is available only on terminal observations.
  responseSpeed: 'fast',
};

// cost-estimation-15: public declarations compile on TypeScript 5.4.
const tokenPrices: TokenPrices = { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3, reasoning: 20 };
const pricingCachePath: string = getDefaultPricingCachePath();
const estimationOptions: CostEstimationOptions = {
  prices: tokenPrices, model: 'caller-model', provider: 'caller-provider',
  cachePath: pricingCachePath, timeoutMs: 1000,
};
const estimatePromise: Promise<CostEstimateResult> = estimateCost(donePayload.usage, estimationOptions);
async function checkEstimateTypes(): Promise<void> {
  const result = await estimatePromise;
  if (result.status === 'estimated') {
    const amount: number = result.amount;
    const currency: 'USD' = result.currency;
    const coverage: 'complete' | 'partial' = result.coverage;
    const records: CostEstimateRecord[] = result.records;
    const assumptions: string[] = result.assumptions;
    const estimatedAt: string = result.estimatedAt;
    if (result.source.type === 'models.dev') {
      const stale: boolean = result.source.stale;
      const fetchedAt: string = result.source.fetchedAt;
      void stale; void fetchedAt;
    } else {
      const callerSource: 'caller' = result.source.type;
      void callerSource;
    }
    // @ts-expect-error An estimate has no unavailability reason.
    result.reason;
    void amount; void currency; void coverage; void records; void assumptions; void estimatedAt;
  } else {
    const reason: CostEstimationUnavailableReason = result.reason;
    const message: string = result.message;
    // @ts-expect-error An unavailable result has no estimated amount.
    result.amount;
    void reason; void message;
  }
}
// @ts-expect-error Required output price must not disappear from the rate card.
const incompletePrices: TokenPrices = { input: 2 };
// @ts-expect-error A token rate is numeric, not a numeric string.
const stringPrices: TokenPrices = { input: '2', output: 10 };
void checkEstimateTypes;
void incompletePrices;
void stringPrices;

const players: PlayerConfig[] = [
  { id: 'claude', adapter: 'claude', effort: 'ultracode', fastMode: true },
  { id: 'codex', adapter: 'codex', effort: 'ultra', fastMode: false },
  { id: 'gemini', adapter: 'gemini', effort: 'max' },
  { id: 'kimi', adapter: 'kimi', effort: 'on' },
  { id: 'opencode', adapter: 'opencode', effort: 'minimal' },
];
// @ts-expect-error Gemini player configuration rejects fast mode.
const invalidGeminiPlayer: PlayerConfig = {
  id: 'gemini-fast', adapter: 'gemini', fastMode: false,
};
// @ts-expect-error OpenCode player configuration rejects fast mode.
const invalidOpenCodePlayer: PlayerConfig = {
  id: 'opencode-fast', adapter: 'opencode', fastMode: true,
};
// @ts-expect-error Kimi player configuration rejects fast mode.
const invalidKimiPlayer: PlayerConfig = {
  id: 'kimi-fast', adapter: 'kimi', fastMode: false,
};
const captains: CaptainConfig[] = [
  {
    adapter: 'claude',
    from: '@sublang/cligent/captains/fanout',
    effort: 'ultracode',
    fastMode: true,
    options: null,
  },
  {
    adapter: 'codex',
    from: '@sublang/cligent/captains/fanout',
    effort: 'ultra',
    fastMode: false,
    options: null,
  },
];
// @ts-expect-error Gemini Captain configuration rejects fast mode.
const invalidGeminiCaptain: CaptainConfig = {
  adapter: 'gemini', from: '@sublang/cligent/captains/fanout', fastMode: true, options: null,
};
// @ts-expect-error OpenCode Captain configuration rejects fast mode.
const invalidOpenCodeCaptain: CaptainConfig = {
  adapter: 'opencode', from: '@sublang/cligent/captains/fanout', fastMode: false, options: null,
};
// @ts-expect-error Kimi Captain configuration rejects fast mode.
const invalidKimiCaptain: CaptainConfig = {
  adapter: 'kimi', from: '@sublang/cligent/captains/fanout', fastMode: true, options: null,
};
const callSettings: AgentCallSettings = {
  model: { kind: 'provider-default' },
  effort: { kind: 'value', value: 'high' },
  fastMode: false,
};
const fanout: Captain = createFanoutCaptain();
const namedFanout: Captain = new FanoutCaptain();

void claudeValues;
void codexValues;
void geminiValues;
void kimiValues;
void opencodeValues;
void claudeFastModeSupport;
void codexFastModeSupported;
void claudeFastModeObservation;
void initFastMode;
void doneFastMode;
void initPayload;
void donePayload;
void invalidInitFastMode;
void players;
void invalidGeminiPlayer;
void invalidOpenCodePlayer;
void invalidKimiPlayer;
void captains;
void invalidGeminiCaptain;
void invalidOpenCodeCaptain;
void invalidKimiCaptain;
void callSettings;
void fanout;
void namedFanout;
`,
    'utf8',
  );

  writeFileSync(
    join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          types: ['node'],
        },
        include: ['type-consumer.ts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

// package-16: Claude compatibility belongs to the SDK that the adapter loads,
// not to an unrelated package with the selected executable's historical name.
// This runs from an installed tarball tree with both packages physically
// present, so a reader that searches cligent's ambient roots is distinguishable
// from one that reports the SDK domain honestly.
function writeClaudeRuntimeAuthorityProbe(directory) {
  const probePath = join(directory, CLAUDE_PROBE_FILENAME);
  writeFileSync(
    probePath,
    `import { realpathSync } from 'node:fs';
import { join } from 'node:path';

const rootSpecifier = process.env.CLAUDE_PROBE_ROOT;
const adapterSpecifier = process.env.CLAUDE_PROBE_ADAPTER;
const expectedVersion = process.env.CLAUDE_PROBE_EXPECTED_VERSION;
const expectedSdkRoot = process.env.CLAUDE_PROBE_SDK_ROOT;

if (!rootSpecifier) throw new Error('CLAUDE_PROBE_ROOT is required');
if (!adapterSpecifier) throw new Error('CLAUDE_PROBE_ADAPTER is required');
if (!expectedVersion) {
  throw new Error('CLAUDE_PROBE_EXPECTED_VERSION is required');
}
if (!expectedSdkRoot) throw new Error('CLAUDE_PROBE_SDK_ROOT is required');
if (
  process.env.CLAUDE_PROBE_REQUIRE_NODE_FLOOR === '1' &&
  process.versions.node !== '${NODE_RUNTIME_VERSION}'
) {
  throw new Error(
    'expected Node ${NODE_RUNTIME_VERSION}, got ' + process.versions.node,
  );
}

const {
  AGENT_RUNTIME_TARGETS,
  classifyRuntime,
  describeRuntimeReadiness,
  readRuntimeVersion,
} = await import(rootSpecifier);
const { ClaudeCodeAdapter } = await import(adapterSpecifier);
const target = AGENT_RUNTIME_TARGETS.claude[0];
if (!target || target.kind !== 'peer') {
  throw new Error('Claude peer runtime target is missing');
}
if ('bundles' in target) {
  throw new Error(
    'Claude target still treats an ambient package as its version authority: ' +
      target.bundles,
  );
}
const runtimeIdentity = target.bundles ?? target.package;
if (runtimeIdentity !== '@anthropic-ai/claude-agent-sdk') {
  throw new Error(
    'Claude runtime identity is ' +
      runtimeIdentity +
      ', expected the SDK',
  );
}

const installed = readRuntimeVersion(target);
if (installed !== expectedVersion) {
  throw new Error(
    'Claude runtime version is ' +
      installed +
      ', expected SDK ' +
      expectedVersion,
  );
}
const available = await new ClaudeCodeAdapter().isAvailable();
if (!available) throw new Error('Claude adapter did not load its installed SDK');
const readiness = classifyRuntime(target, available);
if (readiness.state !== 'satisfied' || readiness.installed !== expectedVersion) {
  throw new Error(
    'Claude readiness did not use SDK ' +
      expectedVersion +
      ': ' +
      JSON.stringify(readiness),
  );
}
const resolvedSdkRoot = readiness.resolvedFrom
  ? realpathSync(
      join(readiness.resolvedFrom, '@anthropic-ai', 'claude-agent-sdk'),
    )
  : undefined;
if (resolvedSdkRoot !== expectedSdkRoot) {
  throw new Error(
    'Claude readiness resolved ' +
      resolvedSdkRoot +
      ', expected ' +
      expectedSdkRoot,
  );
}
const description = describeRuntimeReadiness(readiness);
if (!description.includes('@anthropic-ai/claude-agent-sdk ' + expectedVersion)) {
  throw new Error('Claude readiness names the wrong authority: ' + description);
}
process.stdout.write('claude SDK authority verified: ' + expectedVersion + '\\n');
`,
    'utf8',
  );
  return probePath;
}

// codex-205: the Codex CLI entry must resolve from install layouts that do
// not hoist @openai/codex out of the SDK's own tree (npm global prefixes,
// nested-strategy consumers), and a real permission-managed adapter
// invocation must get past executable resolution. The probe is written into
// the consumer directory it verifies because ESM bare specifiers resolve
// from the importing file's location, not the working directory.
function writeCodexResolutionProbe(directory) {
  const probePath = join(directory, CODEX_PROBE_FILENAME);
  writeFileSync(
    probePath,
    `import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const adapterSpecifier = process.env.CODEX_PROBE_ADAPTER;
const rootSpecifier = process.env.CODEX_PROBE_ROOT;
const expectation = process.env.CODEX_PROBE_EXPECT ?? 'sdk-owned';
const sdkOwnedPrefix = process.env.CODEX_PROBE_SDK_OWNED_PREFIX ?? '';
const expectedVersion = process.env.CODEX_PROBE_EXPECTED_VERSION ?? '';

if (!adapterSpecifier) throw new Error('CODEX_PROBE_ADAPTER is required');
if (!rootSpecifier) throw new Error('CODEX_PROBE_ROOT is required');
if (
  process.env.CODEX_PROBE_REQUIRE_NO_LOADER === '1' &&
  typeof import.meta.resolve === 'function'
) {
  throw new Error(
    \`expected a runtime without import.meta.resolve, got \${process.version}\`,
  );
}

const adapterModule = await import(adapterSpecifier);
const rootModule = await import(rootSpecifier);
const { CodexAdapter, createCodexConfigOverrideWrapper, resolveCodexBinPath } =
  adapterModule;
const {
  AGENT_RUNTIME_TARGETS,
  classifyRuntime,
  describeRuntimeReadiness,
  readRuntimeVersion,
} = rootModule;
for (const [label, value] of [
  ['CodexAdapter', CodexAdapter],
  ['createCodexConfigOverrideWrapper', createCodexConfigOverrideWrapper],
  ['resolveCodexBinPath', resolveCodexBinPath],
]) {
  if (typeof value !== 'function') {
    throw new Error(\`missing adapter export \${label}\`);
  }
}

if (expectation === 'missing') {
  let failure;
  try {
    resolveCodexBinPath();
  } catch (error) {
    failure = error;
  }
  if (!failure) {
    throw new Error(
      'Codex executable resolution unexpectedly succeeded without @openai/codex-sdk',
    );
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  for (const marker of [
    "'@openai/codex/bin/codex.js'",
    "'@openai/codex-sdk'",
    'Attempted:',
    'npm install -g @openai/codex-sdk',
  ]) {
    if (!message.includes(marker)) {
      throw new Error(\`resolution diagnostic lacks \${marker}: \${message}\`);
    }
  }
  process.stdout.write('codex resolution diagnostic verified\\n');
} else {
  const target = AGENT_RUNTIME_TARGETS.codex[0];
  const installed = readRuntimeVersion(target);
  if (!expectedVersion) {
    throw new Error('CODEX_PROBE_EXPECTED_VERSION is required');
  }
  if (installed !== expectedVersion) {
    throw new Error(
      'Codex runtime version is ' +
        installed +
        ', expected SDK-owned ' +
        expectedVersion,
    );
  }
  const runtimeIdentity = target.bundles ?? target.package;
  if (runtimeIdentity !== '@openai/codex') {
    throw new Error(
      'Codex runtime identity is ' +
        runtimeIdentity +
        ', expected @openai/codex',
    );
  }
  const readiness = classifyRuntime(target, true);
  if (readiness.state !== 'satisfied' || readiness.installed !== expectedVersion) {
    throw new Error(
      'Codex readiness did not use SDK-owned ' +
        expectedVersion +
        ': ' +
      JSON.stringify(readiness),
    );
  }
  const description = describeRuntimeReadiness(readiness);
  if (!description.includes('@openai/codex ' + expectedVersion)) {
    throw new Error('Codex readiness names the wrong authority: ' + description);
  }

  const binPath = resolveCodexBinPath();
  if (!existsSync(binPath)) {
    throw new Error(\`resolved Codex entry does not exist: \${binPath}\`);
  }
  if (sdkOwnedPrefix && !binPath.startsWith(sdkOwnedPrefix)) {
    throw new Error(
      \`resolved \${binPath}, expected the SDK-owned entry under \${sdkOwnedPrefix}\`,
    );
  }

  const wrapper = await createCodexConfigOverrideWrapper(
    ['permissions.cligent_probe="resolution"'],
    ['--ignore-user-config'],
  );
  if (!wrapper) throw new Error('config override wrapper was not created');
  try {
    const scriptPath = wrapper.path.endsWith('.cmd')
      ? join(dirname(wrapper.path), 'codex-wrapper.mjs')
      : wrapper.path;
    const script = readFileSync(scriptPath, 'utf8');
    if (!script.includes(JSON.stringify(binPath))) {
      throw new Error(\`wrapper does not embed resolved Codex entry \${binPath}\`);
    }
  } finally {
    await wrapper.cleanup();
  }

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 3000);
  const adapter = new CodexAdapter();
  const events = [];
  let runFailure;
  try {
    for await (const event of adapter.run('cligent codex resolution probe', {
      cwd: process.cwd(),
      permissions: { mode: 'auto' },
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }
  } catch (error) {
    runFailure = error;
  } finally {
    clearTimeout(abortTimer);
  }

  const failureText = runFailure ? \`\${runFailure?.stack ?? runFailure}\` : '';
  if (
    /Cannot find module '@openai\\/codex/.test(failureText) ||
    failureText.includes("could not resolve '@openai/codex/bin/codex.js'")
  ) {
    throw new Error(
      \`adapter run failed at Codex executable resolution: \${failureText}\`,
    );
  }
  // The only run() failure preceding executable resolution; without this the
  // leg would pass without ever reaching the path it claims to verify.
  if (failureText.includes('CodexAdapter requires @openai/codex-sdk')) {
    throw new Error(\`adapter run failed before resolution: \${failureText}\`);
  }
  if (!runFailure && !events.some((event) => event?.type === 'done')) {
    throw new Error(
      \`adapter run yielded no terminal done event: \${events
        .map((event) => event?.type)
        .join(',')}\`,
    );
  }
  process.stdout.write(\`codex resolution verified: \${binPath}\\n\`);
}
`,
    'utf8',
  );
  return probePath;
}

// tmux-play-201: the documented onboarding path (`npm install -g @sublang/cligent`
// then `tmux-play`) has to reach a session whose adapters resolve. Driving the
// installed executable is the only way to see that: the launcher, the config
// it generates, and the adapter runtimes it needs all live behind the bin.
// `tmux` and `glow` are stubbed because the runner has no glow and a real tmux
// session cannot be attached headlessly; the stub log doubles as mock-free
// evidence of whether a session was ever created.
function writeTmuxPlayHarness() {
  mkdirSync(tmuxPlayHarnessBin, { recursive: true });
  mkdirSync(tmuxPlayConfigHome, { recursive: true });
  mkdirSync(tmuxPlayHome, { recursive: true });
  mkdirSync(tmuxPlayWorkDirectory, { recursive: true });
  mkdirSync(tmuxPlayTmp, { recursive: true });

  // A PATH holding only node and the stubs: the CI runner installs the
  // gemini, kimi, and opencode CLIs globally, and any of them on PATH would
  // make an adapter look ready and change the generated roster.
  symlinkSync(realpathSync(process.execPath), join(tmuxPlayHarnessBin, 'node'));

  const fakeTmux = join(tmuxPlayHarnessBin, 'tmux');
  writeFileSync(
    fakeTmux,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args[0] === '-V') {",
      "  console.log('tmux 3.4');",
      '  process.exit(0);',
      '}',
      "fs.appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args) + '\\n');",
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  chmodSync(fakeTmux, 0o755);

  const fakeGlow = join(tmuxPlayHarnessBin, 'glow');
  writeFileSync(
    fakeGlow,
    ['#!/usr/bin/env node', "console.log('glow stub');", 'process.exit(0);', ''].join(
      '\n',
    ),
  );
  chmodSync(fakeGlow, 0o755);
}

function runInstalledTmuxPlay(args) {
  const result = spawnSync(join(tmuxPlayGlobalPrefix, 'bin', 'tmux-play'), args, {
    cwd: tmuxPlayWorkDirectory,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: tmuxPlayHarnessBin,
      HOME: tmuxPlayHome,
      XDG_CONFIG_HOME: tmuxPlayConfigHome,
      FAKE_TMUX_LOG: tmuxPlayLog,
      TMPDIR: tmuxPlayTmp,
    },
  });
  if (result.error) {
    fail(`installed tmux-play could not start: ${result.error.message}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/**
 * The exact repair command tmux-play printed for one package, as argv.
 *
 * The gate is only worth anything if the command the user sees is the command
 * that works, so the test executes this rather than composing its own — a
 * hand-written install can be scoped to a tree the printed one never names.
 */
function extractRepairCommand(output, repairSpec) {
  const line = output
    .split('\n')
    .map((candidate) => candidate.trim())
    .find(
      (candidate) =>
        candidate.startsWith('npm install ') && candidate.endsWith(repairSpec),
    );
  if (!line) {
    fail(
      `tmux-play printed no npm install command for ${repairSpec}:\n${output.trim()}`,
    );
  }
  return line.split(/\s+/);
}

function assertOutputContains(result, expected, label) {
  if (!result.output.includes(expected)) {
    fail(
      `${label}: expected output to contain ${JSON.stringify(expected)}, received:\n${result.output.trim()}`,
    );
  }
}

function tmuxPlaySessionCreated() {
  return existsSync(tmuxPlayLog) && readFileSync(tmuxPlayLog, 'utf8').includes('new-session');
}

function globalNodeModulesRoot(prefix) {
  const candidates = [
    join(prefix, 'lib', 'node_modules'),
    join(prefix, 'node_modules'),
  ];
  const found = candidates.find((candidate) =>
    existsSync(join(candidate, '@sublang', 'cligent')),
  );
  if (!found) {
    fail(`global install created no @sublang/cligent under ${prefix}`);
  }
  return found;
}

function assertSdkOwnedCodexLayout(nodeModulesRoot, label) {
  const hoisted = join(nodeModulesRoot, '@openai', 'codex');
  if (existsSync(hoisted)) {
    fail(`${label} unexpectedly placed @openai/codex at ${hoisted}`);
  }
  const sdkOwnedEntry = join(
    nodeModulesRoot,
    '@openai',
    'codex-sdk',
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );
  if (!existsSync(sdkOwnedEntry)) {
    fail(`${label} did not nest @openai/codex inside the SDK (${sdkOwnedEntry})`);
  }
  return {
    sdkRoot: realpathSync(join(nodeModulesRoot, '@openai', 'codex-sdk')),
    selectedVersion: readJson(
      join(
        nodeModulesRoot,
        '@openai',
        'codex-sdk',
        'node_modules',
        '@openai',
        'codex',
        'package.json',
      ),
    ).version,
  };
}

function writeAmbientPackageDecoy(
  nodeModulesRoot,
  packageName,
  { withCodexEntry = false } = {},
) {
  const packageRoot = join(nodeModulesRoot, ...packageName.split('/'));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: packageName,
        version: RUNTIME_DECOY_VERSION,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  if (withCodexEntry) {
    const binDirectory = join(packageRoot, 'bin');
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(
      join(binDirectory, 'codex.js'),
      "throw new Error('ambient Codex decoy must never execute');\n",
      'utf8',
    );
  }
}

function runCodexResolutionProbe(label, options) {
  const probePath = writeCodexResolutionProbe(options.cwd);
  const probeEnv = {
    CODEX_PROBE_ADAPTER: options.adapterSpecifier,
    CODEX_PROBE_ROOT: options.rootSpecifier,
    CODEX_PROBE_EXPECT: options.expect ?? 'sdk-owned',
    CODEX_PROBE_SDK_OWNED_PREFIX: options.sdkOwnedPrefix ?? '',
    CODEX_PROBE_EXPECTED_VERSION: options.expectedVersion ?? '',
    CODEX_PROBE_REQUIRE_NO_LOADER: options.requireNoLoader ? '1' : '',
    CODEX_HOME: codexProbeHomeDirectory,
  };
  const { stdout } = options.nodeRuntimeFloor
    ? run(
        npm,
        [
          'exec',
          '--yes',
          `--package=node@${NODE_RUNTIME_VERSION}`,
          '--',
          'node',
          probePath,
        ],
        { cwd: options.cwd, env: probeEnv },
      )
    : run(process.execPath, [probePath], {
        cwd: options.cwd,
        env: probeEnv,
      });
  const expectedMarker =
    (options.expect ?? 'sdk-owned') === 'missing'
      ? 'codex resolution diagnostic verified'
      : 'codex resolution verified:';
  if (!stdout.includes(expectedMarker)) {
    fail(`${label} probe did not report "${expectedMarker}":\n${stdout.trim()}`);
  }
}

function runClaudeRuntimeAuthorityProbe(options) {
  const probePath = writeClaudeRuntimeAuthorityProbe(options.cwd);
  const probeEnv = {
    CLAUDE_PROBE_ROOT: options.rootSpecifier,
    CLAUDE_PROBE_ADAPTER: options.adapterSpecifier,
    CLAUDE_PROBE_EXPECTED_VERSION: options.expectedVersion,
    CLAUDE_PROBE_SDK_ROOT: options.sdkRoot,
    CLAUDE_PROBE_REQUIRE_NODE_FLOOR: options.nodeRuntimeFloor ? '1' : '',
  };
  const { stdout } = options.nodeRuntimeFloor
    ? run(
        npm,
        [
          'exec',
          '--yes',
          `--package=node@${NODE_RUNTIME_VERSION}`,
          '--',
          'node',
          probePath,
        ],
        { cwd: options.cwd, env: probeEnv },
      )
    : run(process.execPath, [probePath], {
        cwd: options.cwd,
        env: probeEnv,
      });
  if (!stdout.includes('claude SDK authority verified:')) {
    fail(`Claude authority probe did not report success:\n${stdout.trim()}`);
  }
}

try {
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });

  const repositoryManifest = readJson(join(repoRoot, 'package.json'));
  assertManifestPlacement(repositoryManifest, 'repository');

  assertAuditClean('production', [
    'audit',
    '--omit=dev',
    '--include=prod',
    '--include=optional',
    '--include=peer',
    '--json',
    '--audit-level=low',
  ]);
  assertAuditClean('full graph', [
    'audit',
    '--include=prod',
    '--include=dev',
    '--include=optional',
    '--include=peer',
    '--json',
    '--audit-level=low',
  ]);

  const conformance = run(process.execPath, [
    join(repoRoot, 'scripts', 'verify-agent-targets.mjs'),
  ]);
  if (!conformance.stdout.includes('Agent conformance targets verified.')) {
    fail('agent conformance verifier did not report success');
  }

  const packed = parsePackResult(
    run(npm, ['pack', '--json', '--pack-destination', packDirectory]).stdout,
  );
  const tarballPath = assertTarballManifest(packed, repositoryManifest);

  writeConsumerFiles();
  run(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--save-exact',
      tarballPath,
      `typescript@${TYPESCRIPT_VERSION}`,
      `@types/node@${NODE_TYPES_VERSION}`,
    ],
    { cwd: consumerDirectory },
  );

  const installedManifest = readJson(
    join(
      consumerDirectory,
      'node_modules',
      '@sublang',
      'cligent',
      'package.json',
    ),
  );
  assertManifestPlacement(installedManifest, 'installed tarball');
  assertEqual(
    installedManifest.version,
    repositoryManifest.version,
    'installed tarball version',
  );
  for (const field of ['exports', 'bin', 'main', 'types']) {
    assertDeepEqual(
      installedManifest[field],
      repositoryManifest[field],
      `installed tarball ${field}`,
    );
  }

  for (const packageName of Object.keys(EXPECTED_OPTIONAL_PEERS)) {
    if (
      existsSync(
        join(consumerDirectory, 'node_modules', ...packageName.split('/')),
      )
    ) {
      fail(
        `optional peer ${packageName} was installed in the peer-free consumer`,
      );
    }
  }
  assertRuntimeDependencyShape(
    '@agentclientprotocol/sdk',
    readJson(
      join(
        consumerDirectory,
        'node_modules',
        '@agentclientprotocol',
        'sdk',
        'package.json',
      ),
    ),
    { zod: '^3.25.0 || ^4.0.0' },
  );
  assertRuntimeDependencyShape(
    'yaml',
    readJson(join(consumerDirectory, 'node_modules', 'yaml', 'package.json')),
  );
  assertRuntimeDependencyShape(
    'zod',
    readJson(join(consumerDirectory, 'node_modules', 'zod', 'package.json')),
  );

  const installedNodeTypes = readJson(
    join(consumerDirectory, 'node_modules', '@types', 'node', 'package.json'),
  );
  assertEqual(
    installedNodeTypes.version,
    NODE_TYPES_VERSION,
    'Node declaration consumer version',
  );

  const compiler = join(
    consumerDirectory,
    'node_modules',
    'typescript',
    'bin',
    'tsc',
  );
  assertEqual(
    run(process.execPath, [compiler, '--version'], {
      cwd: consumerDirectory,
    }).stdout.trim(),
    `Version ${TYPESCRIPT_VERSION}`,
    'TypeScript compiler report',
  );
  run(
    process.execPath,
    [compiler, '--project', join(consumerDirectory, 'tsconfig.json')],
    { cwd: consumerDirectory },
  );

  run(
    npm,
    [
      'exec',
      '--yes',
      `--package=node@${NODE_RUNTIME_VERSION}`,
      '--',
      'node',
      join(consumerDirectory, 'runtime-consumer.mjs'),
    ],
    { cwd: consumerDirectory },
  );

  mkdirSync(codexProbeHomeDirectory, { recursive: true });
  mkdirSync(codexProbeWorkDirectory, { recursive: true });

  // Global-style layout: each globally installed package keeps its own
  // dependency tree, so @openai/codex exists only inside the SDK.
  mkdirSync(codexGlobalPrefix, { recursive: true });
  run(npm, [
    'install',
    '--global',
    '--prefix',
    codexGlobalPrefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarballPath,
    claudeSdkInstallSpec,
    codexSdkInstallSpec,
  ]);
  const globalRoot = globalNodeModulesRoot(codexGlobalPrefix);
  const globalCodexLayout = assertSdkOwnedCodexLayout(
    globalRoot,
    'global install',
  );
  const globalClaudeSdkRoot = realpathSync(
    join(globalRoot, '@anthropic-ai', 'claude-agent-sdk'),
  );
  const globalClaudeSdkVersion = readJson(
    join(globalClaudeSdkRoot, 'package.json'),
  ).version;
  writeAmbientPackageDecoy(globalRoot, '@anthropic-ai/claude-code');
  writeAmbientPackageDecoy(globalRoot, '@openai/codex', {
    withCodexEntry: true,
  });
  const globalCligentRoot = join(globalRoot, '@sublang', 'cligent');
  runClaudeRuntimeAuthorityProbe({
    rootSpecifier: pathToFileURL(join(globalCligentRoot, 'dist', 'index.js'))
      .href,
    adapterSpecifier: pathToFileURL(
      join(globalCligentRoot, 'dist', 'adapters', 'claude-code.js'),
    ).href,
    expectedVersion: globalClaudeSdkVersion,
    sdkRoot: globalClaudeSdkRoot,
    cwd: codexProbeWorkDirectory,
  });
  runCodexResolutionProbe('global install', {
    adapterSpecifier: pathToFileURL(
      join(globalCligentRoot, 'dist', 'adapters', 'codex.js'),
    ).href,
    rootSpecifier: pathToFileURL(join(globalCligentRoot, 'dist', 'index.js'))
      .href,
    sdkOwnedPrefix: globalCodexLayout.sdkRoot,
    expectedVersion: globalCodexLayout.selectedVersion,
    cwd: codexProbeWorkDirectory,
  });

  // Non-hoisted consumer layout: nested install strategy keeps every
  // dependency inside its dependent's tree.
  mkdirSync(codexNestedConsumerDirectory, { recursive: true });
  writeFileSync(
    join(codexNestedConsumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'cligent-codex-nested-consumer',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  run(
    npm,
    [
      'install',
      '--install-strategy=nested',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarballPath,
      claudeSdkInstallSpec,
      codexSdkInstallSpec,
    ],
    { cwd: codexNestedConsumerDirectory },
  );
  const nestedRoot = join(codexNestedConsumerDirectory, 'node_modules');
  const nestedCodexLayout = assertSdkOwnedCodexLayout(
    nestedRoot,
    'nested-strategy consumer',
  );
  const nestedClaudeSdkRoot = realpathSync(
    join(nestedRoot, '@anthropic-ai', 'claude-agent-sdk'),
  );
  const nestedClaudeSdkVersion = readJson(
    join(nestedClaudeSdkRoot, 'package.json'),
  ).version;
  writeAmbientPackageDecoy(nestedRoot, '@anthropic-ai/claude-code');
  writeAmbientPackageDecoy(nestedRoot, '@openai/codex', {
    withCodexEntry: true,
  });
  runClaudeRuntimeAuthorityProbe({
    rootSpecifier: '@sublang/cligent',
    adapterSpecifier: '@sublang/cligent/adapters/claude-code',
    expectedVersion: nestedClaudeSdkVersion,
    sdkRoot: nestedClaudeSdkRoot,
    cwd: codexNestedConsumerDirectory,
  });
  runClaudeRuntimeAuthorityProbe({
    rootSpecifier: '@sublang/cligent',
    adapterSpecifier: '@sublang/cligent/adapters/claude-code',
    expectedVersion: nestedClaudeSdkVersion,
    sdkRoot: nestedClaudeSdkRoot,
    cwd: codexNestedConsumerDirectory,
    nodeRuntimeFloor: true,
  });
  runCodexResolutionProbe('nested-strategy consumer', {
    adapterSpecifier: '@sublang/cligent/adapters/codex',
    rootSpecifier: '@sublang/cligent',
    sdkOwnedPrefix: nestedCodexLayout.sdkRoot,
    expectedVersion: nestedCodexLayout.selectedVersion,
    cwd: codexNestedConsumerDirectory,
  });
  // The Node runtime floor has no import.meta.resolve, so this leg proves
  // the search-path anchor alone finds the SDK-owned entry.
  runCodexResolutionProbe('nested-strategy consumer on the Node floor', {
    adapterSpecifier: '@sublang/cligent/adapters/codex',
    rootSpecifier: '@sublang/cligent',
    sdkOwnedPrefix: nestedCodexLayout.sdkRoot,
    expectedVersion: nestedCodexLayout.selectedVersion,
    cwd: codexNestedConsumerDirectory,
    nodeRuntimeFloor: true,
    requireNoLoader: true,
  });

  // The peer-free consumer resolves no @openai/codex from any route, so the
  // adapter must raise the ownership diagnostic with the repair.
  runCodexResolutionProbe('peer-free consumer diagnostic', {
    adapterSpecifier: '@sublang/cligent/adapters/codex',
    rootSpecifier: '@sublang/cligent',
    expect: 'missing',
    cwd: consumerDirectory,
  });

  // tmux-play-201: the documented global install, with no agent SDK beside it.
  mkdirSync(tmuxPlayGlobalPrefix, { recursive: true });
  run(npm, [
    'install',
    '--global',
    '--prefix',
    tmuxPlayGlobalPrefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarballPath,
  ]);
  globalNodeModulesRoot(tmuxPlayGlobalPrefix);
  writeTmuxPlayHarness();

  const installedTmuxPlayBin = join(tmuxPlayGlobalPrefix, 'bin', 'tmux-play');
  if (!existsSync(installedTmuxPlayBin)) {
    fail(`global install created no tmux-play executable at ${installedTmuxPlayBin}`);
  }

  // With nothing but cligent installed, the documented command must refuse:
  // no config naming runtimes it cannot load, no session, and every repair
  // command scoped to the prefix the user actually installed into.
  const emptyLaunch = runInstalledTmuxPlay([]);
  assertEqual(emptyLaunch.status, 1, 'tmux-play launch without any agent runtime');
  assertOutputContains(
    emptyLaunch,
    'found no agent runtime installed',
    'tmux-play launch without any agent runtime',
  );
  // Every peer SDK command names its tree with --prefix; here that tree is a
  // prefix supplied out of band that a bare install would never reach. PATH
  // executables use the descriptor's exact repair spec but stay unpinned to
  // cligent's tree because they belong in the global prefix the shell reads.
  for (const repair of [
    `npm install -g --prefix ${tmuxPlayGlobalPrefix} ${AGENT_RUNTIME_TARGETS.claude[0].repairSpec}`,
    `npm install -g --prefix ${tmuxPlayGlobalPrefix} ${AGENT_RUNTIME_TARGETS.codex[0].repairSpec}`,
    `npm install -g --prefix ${tmuxPlayGlobalPrefix} ${AGENT_RUNTIME_TARGETS.opencode[0].repairSpec}`,
    `npm install -g ${AGENT_RUNTIME_TARGETS.gemini[0].repairSpec}`,
    `npm install -g ${AGENT_RUNTIME_TARGETS.kimi[0].repairSpec}`,
    `npm install -g ${AGENT_RUNTIME_TARGETS.opencode[1].repairSpec}`,
  ]) {
    assertOutputContains(emptyLaunch, repair, 'tmux-play repair commands');
  }
  if (existsSync(tmuxPlayHomeConfig)) {
    fail(
      `tmux-play wrote ${tmuxPlayHomeConfig} with no adapter runtime installed`,
    );
  }
  if (tmuxPlaySessionCreated()) {
    fail('tmux-play created a tmux session before reporting a missing runtime');
  }

  // tmux-play-201: repair by running what the user was actually shown, verbatim.
  // Substituting a hand-written install here is what let a command scoped to
  // the wrong tree pass: this prefix is supplied out of band, so a bare
  // `npm install -g` would resolve against npm's own prefix instead.
  const printedRepair = extractRepairCommand(
    emptyLaunch.output,
    AGENT_RUNTIME_TARGETS.codex[0].repairSpec,
  );
  run(npm, [
    ...printedRepair.slice(1),
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);
  const installedSdk = join(
    globalNodeModulesRoot(tmuxPlayGlobalPrefix),
    '@openai',
    'codex-sdk',
  );
  if (!existsSync(installedSdk)) {
    fail(
      `the printed repair command (${printedRepair.join(' ')}) did not install ` +
        `the SDK into ${installedSdk}, the tree tmux-play reported it resolves from`,
    );
  }

  // One installed runtime is enough for a first session: the generated roster
  // names only that adapter, and the launch reaches tmux.
  const readyLaunch = runInstalledTmuxPlay([]);
  assertEqual(readyLaunch.status, 0, 'tmux-play launch with the Codex SDK installed');
  assertOutputContains(
    readyLaunch,
    `Created tmux-play config at ${tmuxPlayHomeConfig} for installed adapters: codex`,
    'tmux-play first-run notice',
  );
  const generatedConfig = readFileSync(tmuxPlayHomeConfig, 'utf8');
  if (!generatedConfig.includes('adapter: codex')) {
    fail(`generated config named no codex role:\n${generatedConfig}`);
  }
  if (/adapter: (?!codex)/.test(generatedConfig)) {
    fail(
      `generated config named an adapter with no installed runtime:\n${generatedConfig}`,
    );
  }

  if (!tmuxPlaySessionCreated()) {
    fail('tmux-play created no tmux session with every configured adapter ready');
  }
} finally {
  rmSync(verificationRoot, { recursive: true, force: true });
}

process.stdout.write(
  'Distributable tarball, consumers, audits, conformance targets, Claude and ' +
    'Codex runtime-authority layouts, and global tmux-play onboarding verified.\n',
);
