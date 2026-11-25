/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { runInNewContext } from 'vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWorkspacePreparationLauncher } from '@/process/services/hth/runtime/workspacePreparationLauncher';
import { HTHWorkspacePreparationServer } from '@/process/services/hth/runtime/workspacePreparationServer';
import type { HTHAuthService } from '@/process/services/hth/authService';
import { HTHConfigSyncService } from '@/process/services/hth/configSyncService';
import { HTHCoreIdentityService } from '@/process/services/hth/coreIdentityService';
import { HTHPackageStore } from '@/process/services/hth/packageStore';
import { CRON_RUNTIME_PROXY_SOURCE } from '@/process/services/hth/runtime/cronRuntimeProxy';
import type {
  CronRuntimeConfirmation,
  CronRuntimeOverrides,
} from '@/process/services/hth/runtime/cronRuntimeOverrides';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' } }));

type Connection = { pipe: string; token: string };

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('managed CLI workspace preparation', () => {
  let workspace: string;
  const servers: HTHWorkspacePreparationServer[] = [];
  const children = new Set<ChildProcess>();

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui assistant 配置 '));
  });

  afterEach(async () => {
    for (const child of children) child.kill();
    children.clear();
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await fs.rm(workspace, { force: true, recursive: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function startServer(
    prepare: (request: { conversationId: string; workspace: string }) => Promise<void | CronRuntimeOverrides>,
    confirmRuntime?: ConstructorParameters<typeof HTHWorkspacePreparationServer>[1]
  ): Promise<Connection> {
    const server = new HTHWorkspacePreparationServer(prepare, confirmRuntime);
    servers.push(server);
    return server.start();
  }

  async function runLauncher(
    connection: Connection,
    options: {
      conversationId?: string;
      token?: string;
      native?: boolean;
      cliType?: 'codex' | 'opencode';
      configContent?: string;
      args?: string[];
      workspace?: string;
      script?: string;
      requests?: Array<Record<string, unknown>>;
      pipelineRequests?: boolean;
      onFrame?: (frame: Record<string, unknown>) => void;
      cancelOnConfig?: boolean;
      missingTarget?: boolean;
      keepStdinOpen?: boolean;
    } = {}
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const targetPath = path.join(workspace, 'actual cli.cjs');
    await fs.writeFile(
      targetPath,
      options.script ??
        `const fs = require('node:fs');
fs.writeFileSync('started', 'yes');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    config: fs.existsSync('instructions.md') ? fs.readFileSync('instructions.md', 'utf8') : null,
    args: process.argv.slice(2), input, cwd: process.cwd(),
    pipe: process.env.AIONUI_WORKSPACE_PREPARATION_PIPE || null,
    token: process.env.AIONUI_WORKSPACE_PREPARATION_TOKEN || null,
  }));
  process.stderr.write('cli stderr');
  process.exitCode = 17;
});`
    );
    const launcherPath = path.join(workspace, 'prepare launcher.cjs');
    await fs.writeFile(
      launcherPath,
      buildWorkspacePreparationLauncher({
        targetPath: options.missingTarget
          ? path.join(workspace, 'missing-cli.exe')
          : options.native
            ? process.execPath
            : targetPath,
        nodeExecutable: process.execPath,
        nodeScript: !options.native,
        cliType: options.cliType ?? 'opencode',
      })
    );
    const args = options.native ? [targetPath, ...(options.args ?? [])] : (options.args ?? []);
    const child = spawn(process.execPath, [launcherPath, ...args], {
      cwd: options.workspace ?? workspace,
      env: {
        ...process.env,
        AIONUI_CONVERSATION_ID: options.conversationId ?? 'cron-conversation',
        AIONUI_WORKSPACE_PREPARATION_PIPE: connection.pipe,
        AIONUI_WORKSPACE_PREPARATION_TOKEN: options.token ?? connection.token,
        OPENCODE_CONFIG_CONTENT: options.configContent,
      },
      stdio: 'pipe',
      windowsHide: true,
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    let responseBuffer = '';
    let requestIndex = 0;
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (!options.requests) return;
      responseBuffer += data.toString();
      let newline;
      while ((newline = responseBuffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(responseBuffer.slice(0, newline)) as Record<string, unknown>;
        responseBuffer = responseBuffer.slice(newline + 1);
        options.onFrame?.(frame);
        if (options.cancelOnConfig && frame.method === 'test/config_pending') {
          child.stdin.write(
            JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-1' } }) + '\n'
          );
        }
        if (!frame.method && frame.id === options.requests[requestIndex]?.id) {
          requestIndex++;
          if (requestIndex === options.requests.length) child.stdin.end();
          else if (!options.pipelineRequests) child.stdin.write(JSON.stringify(options.requests[requestIndex]) + '\n');
        }
      }
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.stdin.on('error', () => {});
    if (options.requests?.length) {
      child.stdin.write(
        options.pipelineRequests
          ? options.requests.map((frame) => JSON.stringify(frame) + '\n').join('')
          : JSON.stringify(options.requests[0]) + '\n'
      );
    } else if (!options.keepStdinOpen) child.stdin.end('input for the cli');
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        children.delete(child);
        resolve({ code, stdout, stderr });
      });
    });
  }

  function request(connection: Connection, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(connection.pipe);
      let response = '';
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(payload));
      socket.on('data', (chunk: string) => {
        response += chunk;
      });
      socket.once('error', reject);
      socket.once('end', () => resolve(response));
    });
  }

  it('waits for background preparation before starting the CLI with its project files', async () => {
    const entered = deferred<{ conversationId: string; workspace: string }>();
    const release = deferred();
    const connection = await startServer(async (value) => {
      entered.resolve(value);
      await release.promise;
      await fs.writeFile(path.join(value.workspace, 'instructions.md'), 'administrative assistant');
    });
    const result = runLauncher(connection, { args: ['a b', '中文', '"literal"'] });
    try {
      expect(await entered.promise).toEqual({ conversationId: 'cron-conversation', workspace });
      await expect(fs.access(path.join(workspace, 'started'))).rejects.toThrow();
    } finally {
      release.resolve();
    }
    expect(await result).toEqual({
      code: 17,
      stdout: JSON.stringify({
        config: 'administrative assistant',
        args: ['a b', '中文', '"literal"'],
        input: 'input for the cli',
        cwd: workspace,
        pipe: null,
        token: null,
      }),
      stderr: 'cli stderr',
    });
  });

  it('supports native CLI executables and forwards their exit status', async () => {
    const connection = await startServer(async ({ workspace: target }) => {
      await fs.writeFile(path.join(target, 'instructions.md'), 'native assistant');
    });
    const result = await runLauncher(connection, { native: true, args: ['native argument'] });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 17, stderr: 'cli stderr' });
    expect(JSON.parse(result.stdout)).toMatchObject({ config: 'native assistant', args: ['native argument'] });
  });

  it('adds Codex attribution without replacing existing command arguments', async () => {
    const result = await runLauncher(
      { pipe: 'unused', token: 'unused' },
      {
        conversationId: '',
        cliType: 'codex',
        args: ['app-server', '-c', 'model_reasoning_effort="high"'],
      }
    );
    expect(JSON.parse(result.stdout).args).toEqual([
      'app-server',
      '-c',
      'model_reasoning_effort="high"',
      '-c',
      'model_providers.hth.http_headers.X-Client-App="hqbuddy-codex"',
    ]);
    expect(result.code).toBe(17);
  });

  it.each([
    {
      name: 'empty',
      configContent: undefined,
      expectedConfig: { provider: { hth: { options: { headers: { 'X-Client-App': 'hqbuddy-opencode' } } } } },
    },
    {
      name: 'existing',
      configContent: JSON.stringify({
        model: 'hth/keep-model',
        provider: {
          other: { options: { headers: { 'X-Other': 'keep' } } },
          hth: {
            name: 'Keep HTH',
            options: {
              apiKey: 'dummy-local-key',
              headers: { 'X-Existing': 'keep', 'x-client-app': 'obsolete' },
            },
          },
        },
      }),
      expectedConfig: {
        model: 'hth/keep-model',
        provider: {
          other: { options: { headers: { 'X-Other': 'keep' } } },
          hth: {
            name: 'Keep HTH',
            options: {
              apiKey: 'dummy-local-key',
              headers: { 'X-Existing': 'keep', 'X-Client-App': 'hqbuddy-opencode' },
            },
          },
        },
      },
    },
  ])('adds OpenCode attribution while preserving $name configuration', async ({ configContent, expectedConfig }) => {
    const result = await runLauncher(
      { pipe: 'unused', token: 'unused' },
      {
        conversationId: '',
        configContent,
        args: ['acp', '--port', '12345'],
        script: `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) }));`,
      }
    );
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['acp', '--port', '12345'],
      config: expectedConfig,
    });
    expect(result.code).toBe(0);
  });

  it.each(['invalid JSON', 'null', '{"provider":[]}', '{"provider":{"hth":{"options":{"headers":[]}}}}'])(
    'does not start OpenCode when its existing override is invalid: %s',
    async (configContent) => {
      const result = await runLauncher(
        { pipe: 'unused', token: 'unused' },
        {
          conversationId: '',
          configContent,
        }
      );
      expect(result).toEqual({ code: 1, stdout: '', stderr: 'Workspace preparation failed.\n' });
      await expect(fs.access(path.join(workspace, 'started'))).rejects.toThrow();
    }
  );

  // Shapes are grounded in codex-cli 0.145.0's generated TurnStartParams and
  // @agentclientprotocol/sdk 0.18.2's schema/schema.json. The fake CLI records
  // what actually reaches the child process, including ordering of config RPCs.
  const protocolCli = String.raw`
const readline = require('node:readline');
let model = 'hth/original-model';
let effort = 'low';
const calls = [];
const configOptions = () => [
  { id: 'model-choice', category: 'model', type: 'select', currentValue: model,
    options: [{ value: 'hth/gpt-6.1-sol', name: 'GPT' }, { value: 'hth/original-model', name: 'Original' }] },
  { id: 'reasoning', category: 'thought_level', type: 'select', currentValue: effort,
    options: [{ group: 'efforts', name: 'Effort', options: [{ value: 'high', name: 'High' }, { value: 'low', name: 'Low' }, { value: 'max', name: 'Max' }] }] },
];
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  calls.push(request.method);
  let result = {};
  if (request.method === 'session/new') result = { sessionId: 'session-1', configOptions: configOptions() };
  if (request.method === 'session/set_config_option') {
    const { configId, value } = request.params;
    if (configId === 'model-choice') model = value;
    if (configId === 'reasoning') effort = value;
    result = { configOptions: configOptions() };
  }
  if (request.method === 'session/prompt') result = { stopReason: 'end_turn', observed: { model, effort, calls: [...calls] } };
  if (request.method === 'turn/start') result = { observed: request.params };
  send({ jsonrpc: '2.0', id: request.id, result });
});
`;

  // AionCore v0.2.1 crates/aionui-cron/src/prompt.rs:19: keep the injected
  // template exact so removal cannot accidentally consume the user's task.
  const scheduledContext =
    '[Scheduled Task Context]\nTask: Daily report\nSchedule: Every day\n\nRules:\n1. Execute the task directly — do NOT ask clarifying questions.\n2. Focus on producing useful, actionable output.\n3. If the task requires external data (news, weather, etc.), search for the latest information.';
  const skillSuggestionRule =
    '4. After completing the task above, create a file named "SKILL_SUGGEST.md" in the current working directory (see instructions at the end).';
  const skillSuggestionPostTask =
    '\n\n---\n\n[Post-Task] After you have fully completed the task above, create a file named "SKILL_SUGGEST.md" in the current working directory to help future runs stay consistent. The file should follow this format:\n\n```markdown\n---\nname: <short kebab-case name, e.g. daily-greeting>\ndescription: <one-line description of what this task does>\n---\n\n<Instructions capturing the pattern you used: output format, tone, sources checked, steps taken, quality criteria. Use concrete details from this execution, not placeholders.>\n```\n\nIf you think the task is too simple or one-off to benefit from a skill file, you can skip this step.';
  const originalTask =
    '分析现有 SKILL_SUGGEST.md，不创建新文件。\n[Post-Task] 这一行是用户原始命令，必须保留。\n---\n使用 skills/approved-report 输出日报。';
  const contextBefore = '[Workspace Context]\nKeep the existing workspace instructions.\n\n';
  const contextAfter = '\n\n[Additional Context]\nKeep the attached report as a source.';
  const injectedTask = `${contextBefore}${scheduledContext}\n${skillSuggestionRule}\n[/Scheduled Task Context]\n\n${originalTask}${skillSuggestionPostTask}${contextAfter}`;
  const taskWithoutSuggestion = `${contextBefore}${scheduledContext}\n[/Scheduled Task Context]\n\n${originalTask}${contextAfter}`;
  const promptEchoCli = protocolCli.replace(
    'observed: { model, effort, calls: [...calls] }',
    'observed: request.params'
  );

  it.each(['opencode', 'codex'] as const)(
    'removes only new-task skill-suggestion instructions from %s prompts without selecting a model',
    async (backend) => {
      const connection = await startServer(async () => ({ backend, suppressSkillSuggestion: true }));
      const attachment =
        backend === 'opencode'
          ? { type: 'resource_link', uri: 'file:///report.csv', name: 'report.csv', mimeType: 'text/csv' }
          : { type: 'image', url: 'https://example.invalid/report.png' };
      const assistantRules = `[Assistant Rules]\nKeep this quoted prior task unchanged:\n${injectedTask}\n[/Assistant Rules]\n\n`;
      const content = [
        { type: 'text', text: assistantRules + injectedTask },
        attachment,
        { type: 'text', text: '保留这条独立消息和 SKILL_SUGGEST.md 字样。' },
      ];
      const expectedContent = [{ type: 'text', text: assistantRules + taskWithoutSuggestion }, ...content.slice(1)];
      const params =
        backend === 'opencode'
          ? { sessionId: 'session-1', prompt: content, _meta: { source: 'scheduled-task' } }
          : { threadId: 'thread-1', input: content, model: 'original', effort: 'low' };
      const expectedParams =
        backend === 'opencode' ? { ...params, prompt: expectedContent } : { ...params, input: expectedContent };
      const requests: Array<Record<string, unknown>> = [];
      if (backend === 'opencode') {
        requests.push({ id: 1, method: 'session/new', params: { cwd: workspace, mcpServers: [] } });
      }
      requests.push(
        {
          id: 'preliminary-message',
          method: backend === 'opencode' ? 'session/prompt' : 'turn/start',
          params:
            backend === 'opencode'
              ? { sessionId: 'session-1', prompt: [{ type: 'text', text: 'Generate a title.' }] }
              : { threadId: 'thread-1', input: [{ type: 'text', text: 'Generate a title.' }] },
        },
        { id: 2, method: backend === 'opencode' ? 'session/prompt' : 'turn/start', params },
        { id: 3, method: backend === 'opencode' ? 'session/prompt' : 'turn/start', params }
      );

      const result = await runLauncher(connection, {
        args: [backend === 'opencode' ? 'acp' : 'app-server'],
        script: promptEchoCli,
        requests,
      });
      const replies = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(replies.find((frame) => frame.id === 2).result.observed).toEqual(expectedParams);
      expect(replies.find((frame) => frame.id === 3).result.observed).toEqual(params);
      expect(result.code).toBe(0);
    }
  );

  it.each(['opencode', 'codex'] as const)(
    'keeps skill-suggestion text in %s sessions without the new-task suppression flag',
    async (backend) => {
      const connection = await startServer(async () => ({ backend, thoughtLevel: 'high' }));
      const content = [{ type: 'text', text: injectedTask }];
      const params =
        backend === 'opencode' ? { sessionId: 'session-1', prompt: content } : { threadId: 'thread-1', input: content };
      const requests: Array<Record<string, unknown>> = [];
      if (backend === 'opencode') {
        requests.push({ id: 1, method: 'session/new', params: { cwd: workspace, mcpServers: [] } });
      }
      requests.push({ id: 2, method: backend === 'opencode' ? 'session/prompt' : 'turn/start', params });
      const result = await runLauncher(connection, {
        args: [backend === 'opencode' ? 'acp' : 'app-server'],
        script: promptEchoCli,
        requests,
      });
      const reply = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((frame) => frame.id === 2);
      expect(reply.result.observed).toEqual(backend === 'codex' ? { ...params, effort: 'high' } : params);
      expect(result.code).toBe(0);
    }
  );

  it.each(['saved skill', 'rule only', 'post-task only'] as const)(
    'preserves the first %s prompt and later user messages',
    async (scenario) => {
      const connection = await startServer(async () => ({ backend: 'codex', suppressSkillSuggestion: true }));
      const savedSkillTask =
        '[Scheduled Task Context]\nTask: Saved report\n\nThis is a scheduled task execution. A skill file with detailed instructions has been loaded\ninto your workspace. You MUST read and follow the skill instructions precisely.\n\nRules:\n1. Execute the task directly — do NOT ask clarifying questions.\n2. Follow the output format, tone, sources, and steps defined in the skill.\n3. If the task requires external data (news, weather, etc.), search for the latest information.\n[/Scheduled Task Context]\n\n' +
        originalTask +
        '\n\nQuoted previous task:\n' +
        injectedTask;
      const firstPrompt =
        scenario === 'saved skill'
          ? savedSkillTask
          : scenario === 'rule only'
            ? injectedTask.replace(skillSuggestionPostTask, '')
            : injectedTask.replace(`\n${skillSuggestionRule}`, '');
      const result = await runLauncher(connection, {
        args: ['app-server'],
        script: protocolCli,
        requests: [firstPrompt, injectedTask].map((text, index) => ({
          id: index + 1,
          method: 'turn/start',
          params: { threadId: 'thread-1', input: [{ type: 'text', text }] },
        })),
      });
      const texts = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).result.observed.input[0].text);
      expect(texts).toEqual([firstPrompt, injectedTask]);
      expect(result.code).toBe(0);
    }
  );

  it('applies explicit Codex model and effort to every real child turn without changing other params', async () => {
    const connection = await startServer(async () => ({
      backend: 'codex',
      model: 'gpt-6.1-sol',
      thoughtLevel: 'high',
    }));
    const result = await runLauncher(connection, {
      args: ['app-server'],
      script: protocolCli,
      requests: [1, 2].map((id) => ({
        id,
        method: 'turn/start',
        params: { threadId: 'thread-1', input: [{ type: 'text', text: '任务 中文' }], model: 'old', effort: 'low' },
      })),
    });
    const replies = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(result.code).toBe(0);
    expect(replies).toEqual(
      [1, 2].map((id) => ({
        jsonrpc: '2.0',
        id,
        result: {
          observed: {
            threadId: 'thread-1',
            input: [{ type: 'text', text: '任务 中文' }],
            model: 'gpt-6.1-sol',
            effort: 'high',
          },
        },
      }))
    );
  });

  it('keeps the original Codex model when only task reasoning effort is selected', async () => {
    const connection = await startServer(async () => ({ backend: 'codex', thoughtLevel: 'high' }));
    const result = await runLauncher(connection, {
      args: ['app-server'],
      script: protocolCli,
      requests: [
        { id: 'user-request', method: 'turn/start', params: { threadId: 'thread-1', input: [], model: 'original' } },
      ],
    });
    expect(JSON.parse(result.stdout).result.observed).toEqual({
      threadId: 'thread-1',
      input: [],
      model: 'original',
      effort: 'high',
    });
  });

  // Codex 0.151.0 reports the applied settings in ThreadStart/Resume/ForkResponse,
  // independently of the per-turn overrides sent to TurnStartParams.
  const codexStartupCli = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const failure = process.argv[3];
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: { observed: request.params } });
    return;
  }
  if (['thread/start', 'thread/resume', 'thread/fork'].includes(request.method)) {
    const result = {
      thread: { id: 'thread-1' },
      model: failure === 'actual-defaults' ? 'native-observed-model'
        : failure === 'model-mismatch' ? 'unrequested-model' : request.params.model || 'native-default-model',
      reasoningEffort: failure === 'actual-defaults' ? 'medium'
        : failure === 'effort-mismatch' ? 'low' : request.params.config?.model_reasoning_effort,
      observed: request.params,
    };
    send(failure === 'native-error'
      ? { jsonrpc: '2.0', id: request.id, error: { code: -1, message: 'Native startup failed' } }
      : { jsonrpc: '2.0', id: request.id, result });
    send({ jsonrpc: '2.0', method: 'test/native_startup_replied' });
    return;
  }
  if (request.method === 'turn/start') {
    fs.writeFileSync('turn-started', 'yes');
    send({ jsonrpc: '2.0', id: request.id, result: {
      observed: request.params, reportAcknowledged: fs.existsSync('report-acknowledged'),
    } });
  }
});
`;

  it.each([
    ['thread/start', false],
    ['thread/resume', false],
    ['thread/fork', false],
    ['thread/start', true],
  ] as const)(
    'keeps ordinary Codex %s requests intact when runtime metadata persistence fails: %s',
    async (method, reportFailure) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const confirm = vi.fn(async () => {
        if (reportFailure) throw new Error('secret runtime persistence payload');
      });
      const connection = await startServer(async () => ({ backend: 'codex', observeOnly: true }), confirm);
      const initializeParams = { clientInfo: { name: 'aionui-session', version: '1.0.0' } };
      const startupParams = {
        threadId: 'existing-thread',
        model: 'homepage-seed-model',
        config: { model_reasoning_effort: 'high', unrelated: true },
        cwd: workspace,
      };
      const turnParams = {
        threadId: 'thread-1',
        model: 'turn-model',
        effort: 'low',
        input: [{ type: 'text', text: 'Ordinary conversation' }],
      };
      const result = await runLauncher(connection, {
        args: ['app-server', 'actual-defaults'],
        script: codexStartupCli,
        pipelineRequests: true,
        requests: [
          { id: 0, method: 'initialize', params: initializeParams },
          { id: 1, method, params: startupParams },
          { id: 2, method: 'turn/start', params: turnParams },
        ],
      });
      const responses = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((frame) => !frame.method);
      expect(responses.map((frame) => frame.result.observed)).toEqual([initializeParams, startupParams, turnParams]);
      expect(confirm).toHaveBeenCalledExactlyOnceWith(
        { conversationId: 'cron-conversation', workspace },
        { backend: 'codex', model: 'native-observed-model', thoughtLevel: 'medium' }
      );
      expect({ code: result.code, stderr: result.stderr }).toEqual({
        code: 0,
        stderr: reportFailure ? 'Unable to confirm agent runtime settings.\n' : '',
      });
    }
  );

  it.each(['ordinary', 'scheduled'] as const)(
    'keeps the %s Codex title helper transparent without recording conversation settings',
    async (mode) => {
      const confirm = vi.fn(async () => {});
      const runtime: CronRuntimeOverrides = {
        backend: 'codex',
        browserMcp: { command: process.execPath, args: ['browser control.cjs'] },
        suppressSkillSuggestion: true,
        ...(mode === 'ordinary' ? { observeOnly: true } : { model: 'cron-model', thoughtLevel: 'max' }),
      };
      const connection = await startServer(async () => runtime, confirm);
      const requests = [
        {
          id: 'title-initialize',
          method: 'initialize',
          params: { clientInfo: { name: 'aionui-title', version: '1.0.0' } },
        },
        {
          id: 'title-startup',
          method: 'thread/start',
          params: { model: 'title-model', config: { model_reasoning_effort: 'low' }, cwd: workspace },
        },
        {
          id: 'title-turn',
          method: 'turn/start',
          params: { threadId: 'thread-1', input: [{ type: 'text', text: injectedTask }], effort: 'low' },
        },
      ];
      const result = await runLauncher(connection, {
        args: ['app-server'],
        script: codexStartupCli.replaceAll(
          'observed: request.params',
          'observed: request.params, receivedId: request.id'
        ),
        pipelineRequests: true,
        requests,
      });
      const responses = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((frame) => !frame.method);
      expect(responses.map((frame) => [frame.id, frame.result.receivedId, frame.result.observed])).toEqual(
        requests.map((frame) => [frame.id, frame.id, frame.params])
      );
      expect(confirm).not.toHaveBeenCalled();
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
    }
  );

  it('recovers from failed Codex settings reports in order and ignores empty update acknowledgements', async () => {
    const host = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(),
    });
    const nativeStartup = deferred<Record<string, unknown>>();
    const nativeUpdate = deferred<Record<string, unknown>>();
    const startupForwarded = deferred();
    const updateForwarded = deferred();
    const firstUpdateEntered = deferred();
    const releaseFirstUpdate = deferred();
    const finalUpdateSaved = deferred();
    let persisted: CronRuntimeConfirmation | undefined;
    const confirm = vi.fn(async (confirmation: CronRuntimeConfirmation) => {
      if (confirmation.model === 'first-update') {
        firstUpdateEntered.resolve();
        await releaseFirstUpdate.promise;
        throw new Error('secret update persistence payload');
      }
      persisted = confirmation;
      if (confirmation.model === 'latest-update') finalUpdateSaved.resolve();
    });
    child.stdin.on('data', (chunk: Buffer) => {
      const frame = JSON.parse(chunk.toString()) as Record<string, unknown>;
      if (frame.method === 'thread/start') nativeStartup.resolve(frame);
      if (frame.method === 'thread/settings/update') nativeUpdate.resolve(frame);
    });
    host.stdout.on('data', (chunk: Buffer) => {
      const frame = JSON.parse(chunk.toString()) as Record<string, unknown>;
      if (frame.id === 'startup') startupForwarded.resolve();
      if (frame.id === 'settings-update') updateForwarded.resolve();
    });
    runInNewContext(CRON_RUNTIME_PROXY_SOURCE + '\nstartCronRuntimeProxy(child, runtime, confirm);', {
      require: () => ({ randomUUID }),
      process: host,
      child,
      runtime: { backend: 'codex', observeOnly: true },
      confirm,
      setTimeout,
      clearTimeout,
    });
    try {
      host.stdin.write(JSON.stringify({ id: 'startup', method: 'thread/start', params: {} }) + '\n');
      const startup = await nativeStartup.promise;
      child.stdout.write(
        JSON.stringify({
          id: startup.id,
          result: { thread: { id: 'thread-1' }, model: 'native-model', reasoningEffort: 'low' },
        }) + '\n'
      );
      await startupForwarded.promise;
      host.stdin.write(
        JSON.stringify({
          id: 'settings-update',
          method: 'thread/settings/update',
          params: { threadId: 'thread-1', model: 'requested-model', effort: 'high' },
        }) + '\n'
      );
      const update = await nativeUpdate.promise;
      child.stdout.write(JSON.stringify({ id: update.id, result: {} }) + '\n');
      await updateForwarded.promise;
      expect(confirm.mock.calls.map(([confirmation]) => confirmation)).toEqual([
        { backend: 'codex', model: 'native-model', thoughtLevel: 'low' },
      ]);

      for (const [threadId, model, effort] of [
        ['foreign-thread', 'foreign-model', 'max'],
        ['thread-1', 'first-update', 'medium'],
        ['thread-1', 'latest-update', 'high'],
      ]) {
        child.stdout.write(
          JSON.stringify({
            method: 'thread/settings/updated',
            params: { threadId, threadSettings: { model, effort } },
          }) + '\n'
        );
      }
      await firstUpdateEntered.promise;
      expect(confirm.mock.calls.map(([confirmation]) => confirmation.model)).toEqual(['native-model', 'first-update']);
      releaseFirstUpdate.resolve();
      await finalUpdateSaved.promise;
      expect(persisted).toEqual({ backend: 'codex', model: 'latest-update', thoughtLevel: 'high' });
      expect(child.kill).not.toHaveBeenCalled();
      expect(host.stderr.read()?.toString()).toBe('Unable to confirm agent runtime settings.\n');
    } finally {
      releaseFirstUpdate.resolve();
      child.emit('exit', 0);
      for (const stream of [host.stdin, host.stdout, host.stderr, child.stdin, child.stdout]) stream.destroy();
    }
  });

  it.each(['thread/start', 'thread/resume', 'thread/fork'])(
    'merges the browser MCP into Codex %s without selecting a model or changing unrelated settings',
    async (method) => {
      const browserMcp = { command: process.execPath, args: ['browser control.cjs', '--stdio'] };
      const connection = await startServer(async () => ({ backend: 'codex', browserMcp }));
      const config = {
        model_reasoning_effort: 'low',
        unrelated: { retained: true },
        mcp_servers: {
          documents: { command: 'documents', args: ['--keep'], env: { KEEP: 'yes' } },
          'hq-browser': { command: 'obsolete', args: ['old'], env: { OBSOLETE: 'discard' } },
        },
      };
      const startupParams = { threadId: 'existing-thread', cwd: workspace, config };
      const turnParams = { threadId: 'thread-1', input: [], model: 'native-model', effort: 'low' };
      const result = await runLauncher(connection, {
        args: ['app-server'],
        script: codexStartupCli,
        requests: [
          { id: 1, method, params: startupParams },
          { id: 2, method: 'turn/start', params: turnParams },
        ],
      });
      const responses = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((frame) => !frame.method);
      expect(responses.map((frame) => frame.result.observed)).toEqual([
        {
          ...startupParams,
          config: {
            ...config,
            mcp_servers: {
              ...config.mcp_servers,
              'hq-browser': {
                ...browserMcp,
                env_vars: [
                  'AIONUI_BROWSER_CONTROL_PIPE',
                  'AIONUI_BROWSER_CONTROL_TOKEN',
                  'AIONUI_CDP_ACTIVE_PORT',
                  'AIONUI_CDP_BRIDGE_TOKEN',
                  'AIONUI_CONVERSATION_ID',
                ],
              },
            },
          },
        },
        turnParams,
      ]);
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
    }
  );

  it.each(['session/new', 'session/load'])(
    'merges one browser MCP into OpenCode %s while preserving other servers and the default model',
    async (method) => {
      const browserMcp = { command: process.execPath, args: ['browser control.cjs', '--stdio'] };
      const connection = await startServer(async () => ({ backend: 'opencode', browserMcp }));
      const documents = { name: 'documents', command: 'documents', args: [], env: [{ name: 'KEEP', value: 'yes' }] };
      const remote = { name: 'remote', type: 'http', url: 'https://example.test/mcp', headers: [] };
      const params = {
        cwd: workspace,
        sessionId: 'session-1',
        mcpServers: [
          { name: 'hq-browser', command: 'obsolete', args: [], env: [] },
          documents,
          { name: 'hq-browser', command: 'duplicate', args: [], env: [] },
          remote,
        ],
        custom: { retained: true },
      };
      const script = protocolCli.replace('let result = {};', 'let result = { observed: request.params };');
      const result = await runLauncher(connection, {
        args: ['acp'],
        script: script.replace(
          "if (request.method === 'session/new') result = { sessionId: 'session-1', configOptions: configOptions() };",
          ''
        ),
        requests: [{ id: 1, method, params }],
      });
      expect(JSON.parse(result.stdout).result.observed).toEqual({
        ...params,
        mcpServers: [documents, remote, { name: 'hq-browser', ...browserMcp, env: [] }],
      });
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
    }
  );

  it.each(['thread/start', 'thread/resume', 'thread/fork'])(
    'waits for native Codex %s confirmation and the authenticated report acknowledgement before releasing a queued turn',
    async (method) => {
      const entered = deferred<{
        request: { conversationId: string; workspace: string };
        confirmation: CronRuntimeConfirmation;
      }>();
      const nativeReplied = deferred();
      const release = deferred();
      const prepare = vi.fn(
        async (): Promise<CronRuntimeOverrides> => ({
          backend: 'codex',
          model: 'gpt-6.1-sol',
          thoughtLevel: 'medium',
        })
      );
      const confirm = vi.fn(
        async (
          preparationRequest: { conversationId: string; workspace: string },
          confirmation: CronRuntimeConfirmation
        ) => {
          entered.resolve({ request: preparationRequest, confirmation });
          await release.promise;
          await fs.writeFile(path.join(workspace, 'report-acknowledged'), 'yes');
        }
      );
      const connection = await startServer(prepare, confirm);
      const frames: Array<Record<string, unknown>> = [];
      const startupParams = {
        threadId: 'source-thread',
        model: 'previous-model',
        config: { model_reasoning_effort: 'low', unrelated: { setting: true } },
        cwd: workspace,
        serviceTier: 'fast',
      };
      const turnParams = {
        threadId: 'thread-1',
        input: [{ type: 'text', text: '任务 中文' }],
        model: 'old-model',
        effort: 'high',
        outputSchema: { type: 'string' },
      };
      const pending = runLauncher(connection, {
        args: ['app-server'],
        script: codexStartupCli,
        pipelineRequests: true,
        requests: [
          { id: 'startup', method, params: startupParams },
          { id: 'turn', method: 'turn/start', params: turnParams },
        ],
        onFrame: (frame) => {
          frames.push(frame);
          if (frame.method === 'test/native_startup_replied') nativeReplied.resolve();
        },
      });
      try {
        expect(await entered.promise).toEqual({
          request: { conversationId: 'cron-conversation', workspace },
          confirmation: { backend: 'codex', model: 'gpt-6.1-sol', thoughtLevel: 'medium' },
        });
        await nativeReplied.promise;
        expect(frames.filter((frame) => !frame.method)).toEqual([]);
        await expect(fs.access(path.join(workspace, 'turn-started'))).rejects.toThrow();
      } finally {
        release.resolve();
      }
      const result = await pending;
      const responses = frames.filter((frame) => !frame.method);
      expect(responses).toEqual([
        {
          jsonrpc: '2.0',
          id: 'startup',
          result: {
            thread: { id: 'thread-1' },
            model: 'gpt-6.1-sol',
            reasoningEffort: 'medium',
            observed: {
              ...startupParams,
              model: 'gpt-6.1-sol',
              config: { ...startupParams.config, model_reasoning_effort: 'medium' },
            },
          },
        },
        {
          jsonrpc: '2.0',
          id: 'turn',
          result: {
            observed: { ...turnParams, model: 'gpt-6.1-sol', effort: 'medium' },
            reportAcknowledged: true,
          },
        },
      ]);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
    }
  );

  it.each(['native-error', 'model-mismatch', 'effort-mismatch', 'report-failure'])(
    'rejects Codex startup and its queued turn after %s',
    async (failure) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const confirm = vi.fn(async () => {
        if (failure === 'report-failure') throw new Error('secret runtime persistence payload');
      });
      const connection = await startServer(
        async () => ({ backend: 'codex', model: 'gpt-6.1-sol', thoughtLevel: 'medium' }),
        confirm
      );
      const result = await runLauncher(connection, {
        args: ['app-server', failure],
        script: codexStartupCli,
        pipelineRequests: true,
        requests: [
          { id: 'startup', method: 'thread/start', params: { model: 'old', config: {} } },
          { id: 'turn', method: 'turn/start', params: { threadId: 'thread-1', input: [] } },
        ],
      });
      const responses = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((frame) => !frame.method);
      expect(responses.map((frame) => frame.id)).toEqual(['startup', 'turn']);
      expect(responses[0].error).toEqual(
        failure === 'native-error'
          ? { code: -1, message: 'Native startup failed' }
          : { code: -32000, message: 'Unable to apply scheduled task model settings.' }
      );
      expect(responses[1].error).toEqual({ code: -32000, message: 'Unable to apply scheduled task model settings.' });
      expect(confirm).toHaveBeenCalledTimes(failure === 'report-failure' ? 1 : 0);
      await expect(fs.access(path.join(workspace, 'turn-started'))).rejects.toThrow();
      expect(result.stdout + result.stderr).not.toContain('secret runtime persistence payload');
      expect(result.code).toBe(0);
    }
  );

  it('reports the native Codex model without choosing one when only medium reasoning is requested', async () => {
    const confirm = vi.fn(async () => {});
    const connection = await startServer(async () => ({ backend: 'codex', thoughtLevel: 'medium' }), confirm);
    const result = await runLauncher(connection, {
      args: ['app-server'],
      script: codexStartupCli,
      requests: [
        { id: 1, method: 'thread/start', params: { config: { unrelated: 'keep' }, cwd: workspace } },
        { id: 2, method: 'turn/start', params: { threadId: 'thread-1', input: [] } },
      ],
    });
    const responses = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((frame) => !frame.method);
    expect(responses[0].result.observed).toEqual({
      config: { unrelated: 'keep', model_reasoning_effort: 'medium' },
      cwd: workspace,
    });
    expect(responses[1].result.observed).toEqual({ threadId: 'thread-1', input: [], effort: 'medium' });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      { conversationId: 'cron-conversation', workspace },
      { backend: 'codex', model: 'native-default-model', thoughtLevel: 'medium' }
    );
    expect(result.code).toBe(0);
  });

  it('confirms ACP model and reasoning choices before each prompt and isolates internal response ids', async () => {
    const connection = await startServer(async () => ({
      backend: 'opencode',
      model: 'gpt-6.1-sol',
      thoughtLevel: 'high',
    }));
    const result = await runLauncher(connection, {
      args: ['acp'],
      script: protocolCli,
      requests: [
        { id: 'aionui-cron-1', method: 'session/new', params: { cwd: workspace, mcpServers: [] } },
        {
          id: 2,
          method: 'session/prompt',
          params: { sessionId: 'session-1', prompt: [{ type: 'text', text: '任务' }] },
        },
        { id: 3, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [] } },
      ],
    });
    const replies = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((frame) => !frame.method);
    expect(replies.map((reply) => reply.id)).toEqual(['aionui-cron-1', 2, 3]);
    expect(replies[2].result.observed).toEqual({
      model: 'hth/gpt-6.1-sol',
      effort: 'high',
      calls: [
        'session/new',
        'session/set_config_option',
        'session/set_config_option',
        'session/prompt',
        'session/set_config_option',
        'session/set_config_option',
        'session/prompt',
      ],
    });
    expect(result.code).toBe(0);
  });

  it('reports confirmed MAX reasoning to Core when the ACP agent only replies to configuration RPCs', async () => {
    const connection = await startServer(async () => ({
      backend: 'opencode',
      model: 'hth/gpt-6.1-sol',
      thoughtLevel: 'max',
    }));
    const result = await runLauncher(connection, {
      args: ['acp'],
      script: protocolCli,
      requests: [
        { id: 1, method: 'session/new', params: { cwd: workspace, mcpServers: [] } },
        { id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [] } },
      ],
    });
    const frames = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const confirmation = frames.findIndex(
      (frame) =>
        frame.method === 'session/update' &&
        frame.params.sessionId === 'session-1' &&
        frame.params.update.sessionUpdate === 'config_option_update' &&
        frame.params.update.configOptions.some(
          (option: { id: string; currentValue: string }) => option.id === 'reasoning' && option.currentValue === 'max'
        )
    );
    expect(confirmation).toBeGreaterThan(0);
    expect(frames.slice(confirmation + 1).find((frame) => frame.id === 2)?.result.observed).toMatchObject({
      model: 'hth/gpt-6.1-sol',
      effort: 'max',
    });
    expect(result.code).toBe(0);
  });

  it.each(['reject', 'mismatch', 'unsupported'])(
    'blocks an ACP prompt when requested settings are %s without leaking CLI errors',
    async (failure) => {
      const connection = await startServer(async () => ({
        backend: 'opencode',
        model: 'hth/gpt-6.1-sol',
        thoughtLevel: 'high',
      }));
      let script = protocolCli;
      if (failure === 'reject')
        script = script.replace(
          "if (configId === 'model-choice') model = value;",
          "send({ id: request.id, error: { code: -1, message: 'secret upstream payload' } }); return;"
        );
      if (failure === 'mismatch') script = script.replace("if (configId === 'model-choice') model = value;", '');
      if (failure === 'unsupported') script = script.replace("{ value: 'high', name: 'High' },", '');
      const result = await runLauncher(connection, {
        args: ['acp'],
        script,
        requests: [
          { id: 1, method: 'session/new', params: { cwd: workspace, mcpServers: [] } },
          { id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [] } },
        ],
      });
      const replies = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((frame) => !frame.method);
      expect(replies[1]).toEqual({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32000, message: 'Unable to apply scheduled task model settings.' },
      });
      expect(result.stdout).not.toContain('secret upstream payload');
      expect(result.stdout).not.toContain('"observed"');
    }
  );

  it('forwards cancellation during an ACP settings RPC and never sends the cancelled prompt', async () => {
    const connection = await startServer(async () => ({ backend: 'opencode', model: 'hth/gpt-6.1-sol' }));
    const script = protocolCli
      .replace('const calls = [];', 'const calls = []; let held;')
      .replace(
        'result = { configOptions: configOptions() };',
        `held = request; send({ method: 'test/config_pending' }); return;`
      )
      .replace(
        'calls.push(request.method);',
        `calls.push(request.method);
if (request.method === 'session/cancel') {
  send({ method: 'test/cancelled', params: { calls: [...calls] } });
  send({ jsonrpc: '2.0', id: held.id, result: { configOptions: configOptions() } });
  return;
}`
      );
    const result = await runLauncher(connection, {
      args: ['acp'],
      script,
      cancelOnConfig: true,
      requests: [
        { id: 1, method: 'session/new', params: { cwd: workspace, mcpServers: [] } },
        { id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [] } },
      ],
    });
    const frames = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.find((frame) => frame.method === 'test/cancelled').params.calls).toEqual([
      'session/new',
      'session/set_config_option',
      'session/cancel',
    ]);
    expect(frames.find((frame) => frame.id === 2)).toMatchObject({ error: { code: -32000 } });
    expect(result.stdout).not.toContain('"observed"');
  });

  it('exits on a proxy child spawn failure even when Core keeps its stdin open', async () => {
    const connection = await startServer(async () => ({ backend: 'codex', thoughtLevel: 'high' }));
    const result = await runLauncher(connection, {
      args: ['app-server'],
      native: true,
      missingTarget: true,
      keepStdinOpen: true,
    });
    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Unable to start the configured CLI.\n' });
  });

  it.skipIf(!process.env.AIONUI_CORE_BINARY)(
    'prepares an assistant workspace from the real Core conversation contract before launching the CLI',
    async () => {
      const directories = ['data', 'work', 'logs', 'home', 'appdata', 'localappdata', 'cache'];
      await Promise.all(directories.map((directory) => fs.mkdir(path.join(workspace, directory))));
      const listener = net.createServer();
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('Missing isolated Core port');
      const port = address.port;
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
      const baseUrl = `http://127.0.0.1:${port}`;
      const bootstrapSecret = randomBytes(32).toString('hex');
      const coreEnv = {
        ...process.env,
        AIONCORE_BOOTSTRAP_SECRET: bootstrapSecret,
        AIONUI_WORK_DIR: path.join(workspace, 'work'),
        AIONUI_CACHE_DIR: path.join(workspace, 'cache'),
        AIONUI_LOG_DIR: path.join(workspace, 'logs'),
        HOME: path.join(workspace, 'home'),
        USERPROFILE: path.join(workspace, 'home'),
        APPDATA: path.join(workspace, 'appdata'),
        LOCALAPPDATA: path.join(workspace, 'localappdata'),
        XDG_CONFIG_HOME: path.join(workspace, 'home'),
        XDG_CACHE_HOME: path.join(workspace, 'cache'),
      };
      delete coreEnv.AIONUI_WORKSPACE_PREPARATION_PIPE;
      delete coreEnv.AIONUI_WORKSPACE_PREPARATION_TOKEN;
      const core = spawn(
        process.env.AIONUI_CORE_BINARY!,
        [
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--data-dir',
          path.join(workspace, 'data'),
          '--work-dir',
          path.join(workspace, 'work'),
          '--log-dir',
          path.join(workspace, 'logs'),
          '--identity-mode',
          'aionpro',
          '--managed-resources-mode',
          'bundled',
        ],
        { cwd: workspace, env: coreEnv, stdio: 'ignore', windowsHide: true }
      );
      children.add(core);
      const stopped = new Promise<void>((resolve) => core.once('close', () => resolve()));
      let spawnError: Error | undefined;
      core.on('error', (error) => {
        spawnError = error;
      });
      try {
        const realFetch = globalThis.fetch;
        await vi.waitFor(
          async () => {
            if (spawnError) throw spawnError;
            if (core.exitCode !== null) throw new Error('Isolated Core exited before becoming ready');
            const response = await realFetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
            if (!response.ok) throw new Error('Isolated Core is not ready');
          },
          { timeout: 15_000, interval: 100 }
        );
        // Core HTTP is real. Only the HTH metadata endpoints use offline fixtures.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.origin === baseUrl) return realFetch(input, init);
          if ((init?.method ?? 'GET') !== 'GET') throw new Error('Unexpected external request');
          if (url.href === 'http://hth-contract.invalid/v1/models') {
            return Response.json({ data: [{ id: 'gpt-5.6-terra' }] });
          }
          if (url.href === 'http://hth-contract.invalid/api/aionui/pricing') {
            return Response.json({ data: [] });
          }
          throw new Error('Unexpected external request');
        });
        const access = {
          baseUrl: 'http://hth-contract.invalid',
          token: 'offline-contract-token',
          email: 'contract-check@example.invalid',
          displayName: 'Contract Check',
          personalApiKey: 'offline-contract-api-key',
          personalApiKeyName: 'hth-default-apikey',
        };
        const identity = new HTHCoreIdentityService({
          getBackendPort: () => port,
          getBootstrapSecret: () => bootstrapSecret,
          registerRequestHeadersInterceptor: () => {},
        });
        await identity.establish(access);
        async function coreRequest<T>(apiPath: string, payload?: unknown, method?: string): Promise<T> {
          const response = await identity.fetch(`${baseUrl}${apiPath}`, {
            method: method ?? (payload === undefined ? 'GET' : 'POST'),
            headers: { 'Content-Type': 'application/json' },
            body: payload === undefined ? undefined : JSON.stringify(payload),
          });
          if (!response.ok) throw new Error(`Isolated Core request failed (${response.status})`);
          const parsed = (await response.json()) as T | { data: T };
          return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : (parsed as T);
        }
        const agents = await coreRequest<Array<{ id: string; backend?: string }>>('/api/agents/management');
        const openCode = agents.find((agent) => agent.backend === 'opencode');
        if (!openCode) throw new Error('Isolated Core is missing its OpenCode agent');
        const assistant = await coreRequest<{ id: string; source: string }>('/api/assistants', {
          name: 'Offline contract assistant',
          agent_id: openCode.id,
          enabled_skills: [],
          custom_skill_names: [],
        });
        const job = await coreRequest<{ id: string }>('/api/cron/jobs', {
          name: 'Offline scheduled model contract',
          schedule: { kind: 'at', at_ms: Date.now() + 3_600_000 },
          message: 'Offline fixture task',
          conversation_id: '',
          created_by: 'user',
          execution_mode: 'new_conversation',
          agent_config: {
            name: 'Offline contract assistant',
            assistant_id: assistant.id,
            model_id: 'gpt-6.1-sol',
            config_options: { thought_level: 'high' },
          },
        });
        const created = await coreRequest<{ id: string }>('/api/conversations', {
          name: 'Offline scheduled assistant workspace',
          assistant: { id: assistant.id, locale: 'en-US' },
          extra: { cron_job_id: job.id },
        });
        const detail = await coreRequest<{
          assistant: { id: string; source: string };
          extra: { workspace: string; assistant_id?: string };
        }>(`/api/conversations/${created.id}`);
        expect({ assistant: detail.assistant, extraAssistantId: detail.extra.assistant_id }).toMatchObject({
          assistant: { id: assistant.id, source: 'user' },
          extraAssistantId: undefined,
        });
        const packageStore = new HTHPackageStore(path.join(workspace, 'packages'));
        const extractDir = packageStore.getExtractDir('contract-package', '1.0.0');
        const projectDir = path.join(extractDir, 'project');
        await fs.mkdir(projectDir, { recursive: true });
        await Promise.all([
          fs.writeFile(path.join(projectDir, 'instructions.md'), 'Managed project instructions.\n'),
          fs.writeFile(path.join(projectDir, 'user-context.md'), 'Name: <name>\n'),
          fs.writeFile(
            path.join(projectDir, 'opencode.jsonc'),
            '{"model":"hth/gpt-5.6-terra","provider":{"hth":{"models":{}}}}\n'
          ),
        ]);
        await packageStore.writeManifest({
          packageId: 'contract-package',
          assistantId: assistant.id,
          cliType: 'opencode',
          sourceUrl: 'http://hth-contract.invalid/fixture.zip',
          version: '1.0.0',
          name: 'Offline managed assistant package',
          syncedAt: Date.now(),
          extractDir,
          globalFiles: [],
          projectFiles: ['instructions.md', 'opencode.jsonc', 'user-context.md'],
        });
        const service = new HTHConfigSyncService(
          { getAccess: async () => access } as HTHAuthService,
          packageStore,
          () => path.join(workspace, 'codex-home'),
          () => path.join(workspace, 'opencode-home'),
          identity.fetch.bind(identity)
        );
        vi.stubGlobal('__backendPort', port);
        const connection = await startServer((value) => service.prepareConversationWorkspace(value));
        const result = await runLauncher(connection, {
          conversationId: created.id,
          workspace: detail.extra.workspace,
          script: `const fs = require('node:fs');
process.stdout.write(JSON.stringify({
  instructions: fs.readFileSync('instructions.md', 'utf8'),
  userContext: fs.readFileSync('user-context.md', 'utf8'),
  models: Object.keys(JSON.parse(fs.readFileSync('opencode.jsonc', 'utf8')).provider.hth.models),
}));`,
        });
        expect(result).toEqual({
          code: 0,
          stdout: JSON.stringify({
            instructions: 'Managed project instructions.\n',
            userContext: 'Name: Contract Check\n',
            models: ['gpt-5.6-terra'],
          }),
          stderr: '',
        });
        const snapshot = await coreRequest<{ extra: Record<string, unknown> }>(`/api/conversations/${created.id}`);
        expect(snapshot.extra.aionui_cron_runtime).toEqual({
          version: 1,
          assistant_id: assistant.id,
          job_id: job.id,
          runtime: { backend: 'opencode', model: 'gpt-6.1-sol', thoughtLevel: 'high', suppressSkillSuggestion: true },
        });
        await coreRequest(`/api/cron/jobs/${job.id}`, undefined, 'DELETE');
        const historical = await runLauncher(connection, {
          conversationId: created.id,
          workspace: detail.extra.workspace,
          args: ['acp'],
          script: protocolCli,
          requests: [
            { id: 1, method: 'session/new', params: { cwd: detail.extra.workspace, mcpServers: [] } },
            { id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [] } },
          ],
        });
        const responses = historical.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter((frame) => !frame.method);
        expect(responses[1].result.observed).toMatchObject({ model: 'hth/gpt-6.1-sol', effort: 'high' });
      } finally {
        core.kill();
        await stopped;
        children.delete(core);
      }
    },
    30_000
  );

  it('keeps version probes without a conversation independent of preparation', async () => {
    const result = await runLauncher({ pipe: 'unavailable', token: 'unused' }, { conversationId: '' });
    expect(result.code).toBe(17);
    expect(JSON.parse(result.stdout)).toMatchObject({ config: null, pipe: null, token: null });
  });

  it('does not start the CLI when configuration preparation fails or expose its error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connection = await startServer(async () => {
      throw new Error('secret configuration payload');
    });
    const result = await runLauncher(connection);
    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Workspace preparation was rejected.\n' });
    await expect(fs.access(path.join(workspace, 'started'))).rejects.toThrow();
    expect(console.warn).toHaveBeenCalledWith('[HTHWorkspacePreparation] Project preparation failed', {
      conversationId: 'cron-conversation',
    });
  });

  it('rejects forged launcher credentials before touching any project files', async () => {
    const prepare = vi.fn(async (): Promise<void> => {});
    const connection = await startServer(prepare);
    const result = await runLauncher(connection, { token: '0'.repeat(64) });
    expect(result.code).toBe(1);
    expect(prepare).not.toHaveBeenCalled();
    await expect(fs.access(path.join(workspace, 'started'))).rejects.toThrow();
  });

  it.each(['json', 'oversized', 'unicode-token', 'conversation', 'workspace'])(
    'rejects invalid %s requests without preparing a workspace',
    async (kind) => {
      const prepare = vi.fn(async (): Promise<void> => {});
      const connection = await startServer(prepare);
      const payload = { token: connection.token, conversationId: 'cron-conversation', workspace };
      if (kind === 'unicode-token') payload.token = '密'.repeat(64);
      if (kind === 'conversation') payload.conversationId = '../another';
      if (kind === 'workspace') payload.workspace = 'relative';
      const frame =
        kind === 'json' ? '{\n' : kind === 'oversized' ? 'x'.repeat(16_385) : JSON.stringify(payload) + '\n';
      expect(await request(connection, frame)).toBe('{"ok":false}\n');
      expect(prepare).not.toHaveBeenCalled();
    }
  );

  it.each(['forged-token', 'backend', 'blank-model', 'invalid-effort', 'unconfigured', 'callback-failure'])(
    'rejects an invalid runtime confirmation (%s) without preparing the workspace',
    async (kind) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const prepare = vi.fn(async (): Promise<void> => {});
      const confirm = vi.fn(async () => {
        if (kind === 'callback-failure') throw new Error('secret confirmation state');
      });
      const connection = await startServer(prepare, kind === 'unconfigured' ? undefined : confirm);
      const confirmation: Record<string, unknown> = {
        backend: 'codex',
        model: 'gpt-6.1-sol',
        thoughtLevel: 'medium',
      };
      if (kind === 'backend') confirmation.backend = 'opencode';
      if (kind === 'blank-model') confirmation.model = '  ';
      if (kind === 'invalid-effort') confirmation.thoughtLevel = 3;
      const payload = {
        token: kind === 'forged-token' ? '0'.repeat(64) : connection.token,
        conversationId: 'cron-conversation',
        workspace,
        confirmation,
      };
      expect(await request(connection, JSON.stringify(payload) + '\n')).toBe('{"ok":false}\n');
      expect(prepare).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledTimes(kind === 'callback-failure' ? 1 : 0);
    }
  );

  it('revokes the previous channel credentials when the server restarts', async () => {
    const prepare = vi.fn(async (): Promise<void> => {});
    const server = new HTHWorkspacePreparationServer(prepare);
    servers.push(server);
    const previous = await server.start();
    await server.close();
    const current = await server.start();
    const payload = { token: previous.token, conversationId: 'cron-conversation', workspace };
    expect(await request(current, JSON.stringify(payload) + '\n')).toBe('{"ok":false}\n');
    expect(await request(current, JSON.stringify({ ...payload, token: current.token }) + '\n')).toBe('{"ok":true}\n');
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
