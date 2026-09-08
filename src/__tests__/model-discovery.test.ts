// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as codexAdapter from '../adapters/codex.js';
import * as runtimeVersion from '../runtime-version.js';
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import { discoverAgentModels } from '../index.js';
import { discoverAgentModelsWithDeps } from '../model-discovery.js';

const checkRuntime = () => {};

async function withCommand(
  source: string,
  run: (
    command: { executable: string; args: string[] },
    dir: string,
  ) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'cligent-models-'));
  const file = join(dir, 'provider.mjs');
  try {
    await writeFile(file, source);
    await run({ executable: process.execPath, args: [file] }, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const catalogServer = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({ input: process.stdin })) {
 const message = JSON.parse(line);
 appendFileSync(process.env.MODEL_TEST_LOG, JSON.stringify(message)+'\\n');
 if (message.method === 'initialized') continue;
 if (message.method === 'initialize') {
   process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n'); continue;
 }
 if (message.method !== 'model/list') throw new Error('unexpected model work');
 const result = message.params.cursor
   ? {data:[{id:'second-picker',model:'model-two',displayName:'Second',supportedReasoningEfforts:[],additionalSpeedTiers:[]},{model:'model-unknown'}],nextCursor:null}
   : {data:[{id:'picker',model:'model-one',displayName:'First',additionalSpeedTiers:['fast'],supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'max'},{reasoningEffort:'persistent'}],defaultReasoningEffort:'low'}],nextCursor:'page-two'};
 process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
}
`;

describe('engine-86: provider model discovery', () => {
  it('uses Claude initialization without a prompt, tools, hooks or persistence', async () => {
    let closed = false;
    let next: Promise<IteratorResult<never>> | undefined;
    const result = await discoverAgentModelsWithDeps(
      'claude-code',
      {},
      {
        checkRuntime,
        claudeQuery(input) {
          const query = input as {
            prompt: AsyncGenerator<never>;
            options: Record<string, unknown>;
          };
          expect(query.options).toMatchObject({
            persistSession: false,
            tools: [],
            mcpServers: {},
            strictMcpConfig: true,
            settingSources: [],
            settings: { disableAllHooks: true },
            permissionMode: 'dontAsk',
          });
          next = query.prompt.next();
          return {
            supportedModels: async () => [
              {
                value: 'alias',
                resolvedModel: 'canonical',
                displayName: 'Preferred',
                supportedEffortLevels: ['low', 'high', 'future'],
                supportsFastMode: true,
              },
              { value: 'none', supportsEffort: false, supportsFastMode: false },
              { value: 'unknown' },
            ],
            close() {
              closed = true;
            },
          };
        },
      },
    );
    expect(result).toEqual({
      status: 'available',
      unreportedEffortValues: ['ultracode'],
      models: [
        {
          id: 'alias',
          name: 'Preferred',
          resolvedModel: 'canonical',
          effortValues: ['minimal', 'low', 'high'],
          fastModeSupported: true,
        },
        {
          id: 'none',
          name: 'none',
          effortValues: [],
          fastModeSupported: false,
        },
        { id: 'unknown', name: 'unknown' },
      ],
    });
    expect(closed).toBe(true);
    expect(await next).toEqual({ done: true, value: undefined });
  });

  it('closes Claude discovery on deadline without manufacturing a model', async () => {
    let closed = false;
    const result = await discoverAgentModelsWithDeps(
      'claude',
      { timeoutMs: 10 },
      {
        checkRuntime,
        claudeQuery: () => ({
          supportedModels: () => new Promise(() => {}),
          close: () => {
            closed = true;
          },
        }),
      },
    );
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'Model discovery timed out.',
    });
    expect(closed).toBe(true);
  });

  it('reports an older Claude interface and malformed catalog honestly', async () => {
    for (const supportedModels of [undefined, async () => [{ value: 7 }]]) {
      let closed = false;
      const result = await discoverAgentModelsWithDeps(
        'claude',
        {},
        {
          checkRuntime,
          claudeQuery: () => ({
            supportedModels,
            close: () => {
              closed = true;
            },
          }),
        },
      );
      expect(result.status).toBe('unavailable');
      expect(closed).toBe(true);
    }
  });

  it('follows Codex pagination using only initialize and model/list', async () => {
    await withCommand(catalogServer, async (command, dir) => {
      const log = join(dir, 'requests.jsonl');
      const result = await discoverAgentModelsWithDeps(
        'codex',
        { cwd: dir, env: { MODEL_TEST_LOG: log } },
        { checkRuntime, command: () => command },
      );
      expect(result).toEqual({
        status: 'available',
        models: [
          {
            id: 'model-one',
            name: 'First',
            effortValues: ['low', 'max'],
            defaultEffort: 'low',
            fastModeSupported: true,
          },
          {
            id: 'model-two',
            name: 'Second',
            effortValues: [],
            fastModeSupported: false,
          },
          { id: 'model-unknown', name: 'model-unknown' },
        ],
      });
      const requests = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(requests.map((request) => request.method)).toEqual([
        'initialize',
        'initialized',
        'model/list',
        'model/list',
      ]);
      expect(requests.at(-1).params).toEqual({
        limit: 100,
        includeHidden: false,
        cursor: 'page-two',
      });
    });
  });

  it.each([undefined, '0'])(
    'runs a JavaScript entry in Node mode despite caller flag %s',
    async (flag) => {
      const original = process.env.ELECTRON_RUN_AS_NODE;
      await withCommand(
        `import { writeFileSync } from 'node:fs';
         writeFileSync(process.env.MODEL_TEST_ENV, JSON.stringify({
           mode: process.env.ELECTRON_RUN_AS_NODE,
           kept: process.env.MODEL_TEST_KEEP,
           cwd: process.cwd(),
         }));
` + catalogServer,
        async (command, dir) => {
          const envFile = join(dir, 'environment.json');
          const env = {
            ELECTRON_RUN_AS_NODE: flag,
            MODEL_TEST_KEEP: 'caller-value',
            MODEL_TEST_ENV: envFile,
            MODEL_TEST_LOG: join(dir, 'requests.jsonl'),
          };
          const result = await discoverAgentModelsWithDeps(
            'codex',
            { cwd: dir, env },
            { checkRuntime, command: () => ({ ...command, nodeEntry: true }) },
          );
          expect(result.status).toBe('available');
          expect(JSON.parse(await readFile(envFile, 'utf8'))).toEqual({
            mode: '1',
            kept: 'caller-value',
            cwd: await realpath(dir),
          });
          expect(env.ELECTRON_RUN_AS_NODE).toBe(flag);
          expect(process.env.ELECTRON_RUN_AS_NODE).toBe(original);
        },
      );
    },
  );

  it('preserves the caller mode flag for native listing commands', async () => {
    await withCommand(
      `if (process.env.ELECTRON_RUN_AS_NODE !== '0') process.exit(2);
       console.log('provider/model');`,
      async (command) => {
        expect(
          await discoverAgentModelsWithDeps(
            'opencode',
            { env: { ELECTRON_RUN_AS_NODE: '0' } },
            { checkRuntime, command: () => command },
          ),
        ).toEqual({
          status: 'available',
          models: [{ id: 'provider/model', name: 'provider/model' }],
        });
      },
    );
  });

  it.skipIf(process.platform === 'win32').each(['kimi', 'opencode'] as const)(
    'uses the public %s command from the caller PATH',
    async (adapter) => {
      await withCommand('', async (_command, dir) => {
        const executable = join(dir, adapter);
        const log = join(dir, 'native.json');
        await writeFile(
          executable,
          `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.MODEL_TEST_LOG, JSON.stringify(process.argv.slice(2)));
console.log(${JSON.stringify(adapter === 'kimi' ? JSON.stringify({ models: { alias: { model: 'wire' } } }) : 'provider/model')});
`,
        );
        await chmod(executable, 0o700);
        const result = await discoverAgentModels(adapter, {
          cwd: dir,
          env: { PATH: dir, MODEL_TEST_LOG: log },
        });
        expect(result).toEqual({
          status: 'available',
          models: [
            adapter === 'kimi'
              ? { id: 'alias', name: 'alias' }
              : { id: 'provider/model', name: 'provider/model' },
          ],
        });
        expect(JSON.parse(await readFile(log, 'utf8'))).toEqual(
          adapter === 'kimi' ? ['provider', 'list', '--json'] : ['models'],
        );
      });
    },
  );

  it('checks the Codex runtime and launches its resolved entry through the public API', async () => {
    await withCommand(
      `if (JSON.stringify(process.argv.slice(2)) !== '["app-server"]') throw new Error('wrong Codex command');
` + catalogServer,
      async (command, dir) => {
        const gate = vi.spyOn(runtimeVersion, 'assertRuntimeSupported');
        const binary = vi
          .spyOn(codexAdapter, 'resolveCodexBinPath')
          .mockReturnValue(command.args[0]!);
        try {
          const result = await discoverAgentModels('codex', {
            env: { MODEL_TEST_LOG: join(dir, 'requests') },
          });
          expect(result.status).toBe('available');
          const target = AGENT_RUNTIME_TARGETS.codex[0]!;
          expect(gate).toHaveBeenCalledExactlyOnceWith(
            target,
            `npm install ${target.repairSpec}`,
          );
          expect(binary).toHaveBeenCalledOnce();
        } finally {
          gate.mockRestore();
          binary.mockRestore();
        }
      },
    );
  });

  it('retains the first row for each exact model ID in provider order', async () => {
    expect(
      await discoverAgentModelsWithDeps(
        'claude',
        {},
        {
          checkRuntime,
          claudeQuery: () => ({
            supportedModels: async () => [
              { value: 'model', displayName: 'First', supportsFastMode: true },
              { value: 'MODEL', displayName: 'Distinct' },
              {
                value: 'model',
                displayName: 'Duplicate',
                supportsFastMode: false,
              },
            ],
            close() {},
          }),
        },
      ),
    ).toEqual({
      status: 'available',
      unreportedEffortValues: ['ultracode'],
      models: [
        { id: 'model', name: 'First', fastModeSupported: true },
        { id: 'MODEL', name: 'Distinct' },
      ],
    });
  });

  it('checks the Claude runtime before opening its catalog query', async () => {
    const gate = vi.spyOn(runtimeVersion, 'assertRuntimeSupported');
    try {
      const result = await discoverAgentModelsWithDeps(
        'claude',
        {},
        {
          claudeQuery: () => ({ supportedModels: async () => [], close() {} }),
        },
      );
      expect(result).toEqual({
        status: 'available',
        models: [],
        unreportedEffortValues: ['ultracode'],
      });
      const target = AGENT_RUNTIME_TARGETS.claude[0]!;
      expect(gate).toHaveBeenCalledExactlyOnceWith(
        target,
        `npm install ${target.repairSpec}`,
      );
    } finally {
      gate.mockRestore();
    }
  });

  it('preserves an empty catalog as successful discovery', async () => {
    await withCommand(
      catalogServer.replace(
        /const result = message.params.cursor[\s\S]*?process.stdout.write\(JSON.stringify\(\{id:message.id,result\}\)/,
        `const result = {data:[],nextCursor:null}; process.stdout.write(JSON.stringify({id:message.id,result})`,
      ),
      async (command, dir) => {
        const result = await discoverAgentModelsWithDeps(
          'codex',
          { env: { MODEL_TEST_LOG: join(dir, 'requests') } },
          { checkRuntime, command: () => command },
        );
        expect(result).toEqual({ status: 'available', models: [] });
      },
    );
  });

  it('rejects malformed and refused Codex responses and retires the process', async () => {
    for (const output of [
      'not json',
      JSON.stringify({
        id: 1,
        error: { message: 'sensitive provider detail' },
      }),
    ]) {
      await withCommand(
        `process.stdout.write(${JSON.stringify(output + '\n')}); setInterval(()=>{},1000);`,
        async (command) => {
          const result = await discoverAgentModelsWithDeps(
            'codex',
            {},
            { checkRuntime, command: () => command },
          );
          expect(result.status).toBe('unavailable');
          expect(JSON.stringify(result)).not.toContain(
            'sensitive provider detail',
          );
        },
      );
    }
  });

  it('terminates an unresponsive listing process on cancellation', async () => {
    await withCommand(
      `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.MODEL_TEST_PID,String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`,
      async (command, dir) => {
        const controller = new AbortController();
        const pidFile = join(dir, 'pid');
        const result = discoverAgentModelsWithDeps(
          'codex',
          {
            signal: controller.signal,
            env: { MODEL_TEST_PID: pidFile },
            timeoutMs: 2000,
          },
          { checkRuntime, command: () => command },
        );
        // Wait on the explicit child-ready marker, not an assumed startup delay.
        let pid: number | undefined;
        await expect
          .poll(async () => {
            try {
              pid = Number(await readFile(pidFile, 'utf8'));
              return true;
            } catch {
              return false;
            }
          })
          .toBe(true);
        controller.abort();
        expect(await result).toEqual({
          status: 'unavailable',
          reason: 'Model discovery cancelled.',
        });
        expect(() => process.kill(pid!, 0)).toThrow();
      },
    );
  });

  it.each([
    'codex',
    'opencode',
    'completed codex',
    'malformed codex',
    'invalid catalog',
    'refused codex',
    'cancelled cleanup',
  ] as const)(
    'settles %s discovery when a descendant retains the output pipes',
    async (kind) => {
      const completed =
        kind === 'completed codex' || kind === 'cancelled cleanup';
      const cancelled = kind === 'codex' || kind === 'opencode';
      const response = completed
        ? catalogServer
        : kind === 'malformed codex'
          ? "process.stdout.write('not json\\n');"
          : kind === 'invalid catalog'
            ? catalogServer.replace(
                'const result = message.params.cursor',
                'const result = true ? { data: 7 } : message.params.cursor',
              )
            : kind === 'refused codex'
              ? "process.stdout.write(JSON.stringify({id:1,error:{message:'provider refusal'}})+'\\n');"
              : 'process.exit(0);';
      const source = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const descendant = spawn(process.execPath, ['-e', 'process.send(process.pid); setInterval(() => {}, 1000);'], {
  detached: true, stdio: ['ignore', process.stdout, process.stderr, 'ipc'],
});
await new Promise(resolve => descendant.once('message', pid => {
  writeFileSync(process.env.MODEL_TEST_PID, String(pid)); resolve();
}));
process.on('SIGTERM', () => {
  writeFileSync(process.env.MODEL_TEST_CLOSING, 'closing');
  process.exit(0);
});
${response}
`;
      await withCommand(source, async (command, dir) => {
        const controller = new AbortController();
        const pidFile = join(dir, 'descendant.pid');
        let pid: number | undefined;
        let guard: ReturnType<typeof setTimeout> | undefined;
        const result = discoverAgentModelsWithDeps(
          kind === 'opencode' ? 'opencode' : 'codex',
          {
            signal: controller.signal,
            timeoutMs: 3000,
            env: {
              MODEL_TEST_PID: pidFile,
              MODEL_TEST_LOG: join(dir, 'requests'),
              MODEL_TEST_CLOSING: join(dir, 'closing'),
            },
          },
          { checkRuntime, command: () => command },
        );
        try {
          await expect
            .poll(async () => {
              try {
                pid = Number(await readFile(pidFile, 'utf8'));
                return true;
              } catch {
                return false;
              }
            })
            .toBe(true);
          if (cancelled) controller.abort();
          if (kind === 'cancelled cleanup') {
            // SIGTERM is sent only after the complete catalog is consumed.
            await expect
              .poll(async () => {
                try {
                  return await readFile(join(dir, 'closing'), 'utf8');
                } catch {
                  return '';
                }
              })
              .toBe('closing');
            controller.abort();
          }
          const bounded = new Promise<never>((_resolve, reject) => {
            guard = setTimeout(
              () => reject(new Error('discovery did not settle')),
              2000,
            );
          });
          const actual = await Promise.race([result, bounded]);
          if (completed) {
            expect(actual.status).toBe('available');
            if (actual.status === 'available') {
              expect(actual.models.map(({ id }) => id)).toEqual([
                'model-one',
                'model-two',
                'model-unknown',
              ]);
            }
          } else {
            expect(actual).toEqual({
              status: 'unavailable',
              reason: cancelled
                ? 'Model discovery cancelled.'
                : kind === 'malformed codex'
                  ? 'Malformed Codex model response.'
                  : kind === 'invalid catalog'
                    ? 'Malformed model catalog.'
                    : 'The installed Codex runtime refused model discovery.',
            });
          }
        } finally {
          clearTimeout(guard);
          controller.abort();
          if (pid !== undefined) {
            try {
              process.kill(
                process.platform === 'win32' ? pid : -pid,
                'SIGKILL',
              );
            } catch {
              /* Fixture descendant already exited. */
            }
          }
          await result;
        }
      });
    },
  );

  it('does not start discovery for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const result = await discoverAgentModelsWithDeps(
      'codex',
      { signal: controller.signal },
      {
        checkRuntime,
        command: () => {
          called = true;
          throw new Error('should not run');
        },
      },
    );
    expect(result.status).toBe('unavailable');
    expect(called).toBe(false);
  });

  it('projects Kimi model aliases without returning provider credentials', async () => {
    await withCommand(
      `console.log(JSON.stringify({ providers:{private:{api_key:'secret-fixture-key'}},models:{'custom/one':{model:'wire-one'},local:{model:'wire-two'}}}));`,
      async (command) => {
        const result = await discoverAgentModelsWithDeps(
          'kimi',
          {},
          { checkRuntime, command: () => command },
        );
        expect(result).toEqual({
          status: 'available',
          models: [
            { id: 'custom/one', name: 'custom/one' },
            { id: 'local', name: 'local' },
          ],
        });
      },
    );
  });

  it('does not disclose credentials from malformed Kimi output', async () => {
    await withCommand(
      `console.log('secret-provider-api-key malformed json');`,
      async (command) => {
        const result = await discoverAgentModelsWithDeps(
          'kimi',
          {},
          { checkRuntime, command: () => command },
        );
        expect(result).toEqual({
          status: 'unavailable',
          reason: 'Malformed Kimi model listing.',
        });
        expect(JSON.stringify(result)).not.toContain('secret-provider-api-key');
      },
    );
  });

  it('reads OpenCode IDs without guessing model effort or fast support', async () => {
    await withCommand(
      `console.log('provider/model-a\\nprovider/model-b\\nprovider/model-a');`,
      async (command) => {
        const result = await discoverAgentModelsWithDeps(
          'opencode',
          {},
          { checkRuntime, command: () => command },
        );
        expect(result).toEqual({
          status: 'available',
          models: [
            { id: 'provider/model-a', name: 'provider/model-a' },
            { id: 'provider/model-b', name: 'provider/model-b' },
          ],
        });
      },
    );
  });

  it('reports unsupported discovery without invented defaults', async () => {
    expect(await discoverAgentModels('gemini')).toEqual({
      status: 'unavailable',
      reason:
        'Gemini CLI has no supported non-session model listing. Enter a model ID.',
    });
  });

  it('returns missing process and runtime refusals as unavailable', async () => {
    expect(
      (
        await discoverAgentModelsWithDeps(
          'codex',
          {},
          {
            checkRuntime: () => {
              throw new Error('Runtime is too old; repair its resolved tree.');
            },
          },
        )
      ).status,
    ).toBe('unavailable');
    expect(
      (
        await discoverAgentModelsWithDeps(
          'kimi',
          {},
          {
            checkRuntime,
            command: () => ({
              executable: '/missing/cligent-model-listing',
              args: [],
            }),
          },
        )
      ).status,
    ).toBe('unavailable');
  });
});
