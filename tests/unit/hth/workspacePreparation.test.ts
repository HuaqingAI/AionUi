/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWorkspacePreparationLauncher } from '@/process/services/hth/runtime/workspacePreparationLauncher';
import { HTHWorkspacePreparationServer } from '@/process/services/hth/runtime/workspacePreparationServer';
import type { HTHAuthService } from '@/process/services/hth/authService';
import { HTHConfigSyncService } from '@/process/services/hth/configSyncService';
import { HTHCoreIdentityService } from '@/process/services/hth/coreIdentityService';
import { HTHPackageStore } from '@/process/services/hth/packageStore';

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
    prepare: (request: { conversationId: string; workspace: string }) => Promise<void>
  ): Promise<Connection> {
    const server = new HTHWorkspacePreparationServer(prepare);
    servers.push(server);
    return server.start();
  }

  async function runLauncher(
    connection: Connection,
    options: {
      conversationId?: string;
      token?: string;
      native?: boolean;
      args?: string[];
      workspace?: string;
      script?: string;
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
        targetPath: options.native ? process.execPath : targetPath,
        nodeExecutable: process.execPath,
        nodeScript: !options.native,
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
      },
      stdio: 'pipe',
      windowsHide: true,
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.stdin.on('error', () => {});
    child.stdin.end('input for the cli');
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
        async function coreRequest<T>(apiPath: string, payload?: unknown): Promise<T> {
          const response = await identity.fetch(`${baseUrl}${apiPath}`, {
            method: payload === undefined ? 'GET' : 'POST',
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
        const created = await coreRequest<{ id: string }>('/api/conversations', {
          name: 'Offline scheduled assistant workspace',
          assistant: { id: assistant.id, locale: 'en-US' },
          extra: {},
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
