// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
