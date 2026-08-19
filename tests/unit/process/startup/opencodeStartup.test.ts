/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  addCodexGlobalBinToPath,
  addDwsGlobalBinToPath,
  addOfficeCliGlobalBinToPath,
  addOpenCodeGlobalBinToPath,
  addStartupManagedAcpToolBinsToPath,
  addZiniaoOpenGlobalBinToPath,
  checkOpenCodeManagedAgentHealth,
  checkCodexManagedAgentHealth,
  checkDwsManagedAgentHealth,
  checkOfficeCliManagedAgentHealth,
  ensureCodexReady,
  ensureDwsReady,
  ensureOfficeCliReady,
  ensureOpenCodeReady,
  ensureZiniaoOpenReady,
  shouldEnsureCodexOnStartup,
  shouldEnsureDwsOnStartup,
  shouldEnsureOfficeCliOnStartup,
  shouldEnsureOpenCodeOnStartup,
  shouldEnsureZiniaoOpenOnStartup,
} from '@process/startup/opencodeStartup';
import { acpConversation } from '@/common/adapter/ipcBridge';

const originalPath = process.env.PATH;
const originalLegacyPath = process.env.Path;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalLegacyPath === undefined) {
    delete process.env.Path;
  } else {
    process.env.Path = originalLegacyPath;
  }
});

describe('opencode startup bootstrap', () => {
  async function createManagedNodeFixture(): Promise<{
    commandPath: string;
    codexCommandPath: string;
    codexPrefix: string;
    dataPath: string;
    dwsCommandPath: string;
    dwsPrefix: string;
    npmCliPath: string;
    nodeExecutable: string;
    officeCliCommandPath: string;
    officeCliPrefix: string;
    prefix: string;
  }> {
    const dataPath = await mkdtemp(path.join(tmpdir(), 'aionui-opencode-startup-'));
    const nodeRoot = path.join(dataPath, 'runtime', 'node', 'node-v24.11.0-test');
    const nodeExecutable =
      process.platform === 'win32' ? path.join(nodeRoot, 'node.exe') : path.join(nodeRoot, 'bin', 'node');
    const npmCliPath =
      process.platform === 'win32'
        ? path.join(nodeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : path.join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const prefix = path.join(dataPath, 'runtime', 'npm-global', 'opencode');
    const commandPath = path.join(prefix, process.platform === 'win32' ? 'opencode.cmd' : 'bin/opencode');
    const codexPrefix = path.join(dataPath, 'runtime', 'npm-global', 'codex');
    const codexCommandPath = path.join(codexPrefix, process.platform === 'win32' ? 'codex.cmd' : 'bin/codex');
    const dwsPrefix = path.join(dataPath, 'runtime', 'npm-global', 'dws');
    const dwsCommandPath = path.join(dwsPrefix, process.platform === 'win32' ? 'dws.cmd' : 'bin/dws');
    const officeCliPrefix = path.join(dataPath, 'runtime', 'npm-global', 'officecli');
    const officeCliCommandPath = path.join(
      officeCliPrefix,
      process.platform === 'win32' ? 'officecli.cmd' : 'bin/officecli'
    );

    await mkdir(path.dirname(nodeExecutable), { recursive: true });
    await mkdir(path.dirname(npmCliPath), { recursive: true });
    await writeFile(nodeExecutable, '');
    await writeFile(npmCliPath, '');

    return {
      commandPath,
      codexCommandPath,
      codexPrefix,
      dataPath,
      dwsCommandPath,
      dwsPrefix,
      npmCliPath,
      nodeExecutable,
      officeCliCommandPath,
      officeCliPrefix,
      prefix,
    };
  }

  it('uses managed Node npm to install OpenCode instead of system npm or curl', async () => {
    const fixture = await createManagedNodeFixture();
    const calls: string[] = [];
    const ensureNodeRuntime = vi.fn(async () => {
      calls.push('node');
      return { ready: true };
    });
    const commandRunner = vi.fn(async () => {
      calls.push('npm');
      await mkdir(path.dirname(fixture.commandPath), { recursive: true });
      await writeFile(fixture.commandPath, '');
      return {};
    });

    const result = await ensureOpenCodeReady({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus: vi.fn(),
      ensureNodeRuntime,
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect(calls).toEqual(['node', 'npm']);
    expect(ensureNodeRuntime).toHaveBeenCalledWith({
      scope: {
        kind: 'custom_agent',
        id: 'startup-opencode',
      },
    });
    expect(commandRunner).toHaveBeenCalledWith(
      fixture.nodeExecutable,
      [
        fixture.npmCliPath,
        'install',
        '--global',
        'opencode-ai',
        '--prefix',
        fixture.prefix,
        '--registry',
        'https://registry.npmmirror.com',
      ],
      {
        cwd: fixture.dataPath,
        env: expect.objectContaining({
          NPM_CONFIG_PREFIX: fixture.prefix,
          NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com',
          OPENCODE_CONFIG_DIR: path.join(fixture.dataPath, 'runtime', 'opencode-home'),
          npm_config_prefix: fixture.prefix,
          npm_config_registry: 'https://registry.npmmirror.com',
        }),
        timeout: 180000,
      }
    );
    const commandEnv = commandRunner.mock.calls[0]?.[2].env;
    expect(commandEnv?.PATH?.split(path.delimiter)).toContain(path.dirname(fixture.nodeExecutable));
  });

  it('uses the macOS managed Node npm CLI location to install OpenCode', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const dataPath = await mkdtemp(path.join(tmpdir(), 'aionui-opencode-macos-'));
    const nodeRoot = path.join(dataPath, 'runtime', 'node', 'node-v24.11.0-test');
    const nodeExecutable = path.join(nodeRoot, 'bin', 'node');
    const npmCliPath = path.join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const commandPath = path.join(dataPath, 'runtime', 'npm-global', 'opencode', 'bin', 'opencode');

    await mkdir(path.dirname(nodeExecutable), { recursive: true });
    await mkdir(path.dirname(npmCliPath), { recursive: true });
    await writeFile(nodeExecutable, '');
    await writeFile(npmCliPath, '');

    const commandRunner = vi.fn(async () => {
      await mkdir(path.dirname(commandPath), { recursive: true });
      await writeFile(commandPath, '');
      return {};
    });

    const result = await ensureOpenCodeReady({
      commandRunner,
      dataPath,
      emitStatus: vi.fn(),
      ensureNodeRuntime: async () => ({ ready: true }),
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect(commandRunner).toHaveBeenCalledWith(
      nodeExecutable,
      expect.arrayContaining([npmCliPath, 'install', '--global', 'opencode-ai']),
      expect.any(Object)
    );
  });

  it('uses managed Node npm to install Codex into npm-global', async () => {
    const fixture = await createManagedNodeFixture();
    const commandRunner = vi.fn(async () => {
      await mkdir(path.dirname(fixture.codexCommandPath), { recursive: true });
      await writeFile(fixture.codexCommandPath, '');
      return {};
    });

    const result = await ensureCodexReady({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus: vi.fn(),
      ensureNodeRuntime: async () => ({ ready: true }),
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect(commandRunner).toHaveBeenCalledWith(
      fixture.nodeExecutable,
      [
        fixture.npmCliPath,
        'install',
        '--global',
        '@openai/codex',
        '--prefix',
        fixture.codexPrefix,
        '--registry',
        'https://registry.npmmirror.com',
      ],
      {
        cwd: fixture.dataPath,
        env: expect.objectContaining({
          NPM_CONFIG_PREFIX: fixture.codexPrefix,
          NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com',
          npm_config_prefix: fixture.codexPrefix,
          npm_config_registry: 'https://registry.npmmirror.com',
        }),
        timeout: 180000,
      }
    );
  });

  it('uses managed Node npm to install DingTalk DWS into npm-global', async () => {
    const fixture = await createManagedNodeFixture();
    const commandRunner = vi.fn(async () => {
      await mkdir(path.dirname(fixture.dwsCommandPath), { recursive: true });
      await writeFile(fixture.dwsCommandPath, '');
      await mkdir(path.join(fixture.dwsPrefix, 'node_modules', 'dingtalk-workspace-cli', 'vendor'), {
        recursive: true,
      });
      await writeFile(path.join(fixture.dwsPrefix, 'node_modules', 'dingtalk-workspace-cli', 'vendor', 'dws.exe'), '');
      return {};
    });

    const result = await ensureDwsReady({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus: vi.fn(),
      ensureNodeRuntime: async () => ({ ready: true }),
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect(commandRunner).toHaveBeenCalledWith(
      fixture.nodeExecutable,
      [
        fixture.npmCliPath,
        'install',
        '--global',
        'dingtalk-workspace-cli',
        '--prefix',
        fixture.dwsPrefix,
        '--registry',
        'https://registry.npmmirror.com',
        '--ignore-scripts',
      ],
      {
        cwd: fixture.dataPath,
        env: expect.objectContaining({
          NPM_CONFIG_PREFIX: fixture.dwsPrefix,
          NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com',
          npm_config_prefix: fixture.dwsPrefix,
          npm_config_registry: 'https://registry.npmmirror.com',
        }),
        timeout: 180000,
      }
    );
  });

  it.each([
    { arch: 'x64' as const, name: 'Intel' },
    { arch: 'arm64' as const, name: 'Apple Silicon' },
  ])('repairs the macOS $name DWS binary in the npm lib package directory', async ({ arch }) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(process, 'arch', 'get').mockReturnValue(arch);
    const fixture = await createManagedNodeFixture();
    const commandRunner = vi.fn(async () => {
      await mkdir(path.dirname(fixture.dwsCommandPath), { recursive: true });
      await writeFile(fixture.dwsCommandPath, '');
      const packageRoot = path.join(fixture.dwsPrefix, 'lib', 'node_modules', 'dingtalk-workspace-cli');
      await mkdir(path.join(packageRoot, 'vendor'), { recursive: true });
      await writeFile(path.join(packageRoot, 'vendor', 'dws'), '');
      return {};
    });

    const result = await ensureDwsReady({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus: vi.fn(),
      ensureNodeRuntime: async () => ({ ready: true }),
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect(commandRunner).toHaveBeenCalledWith(
      fixture.nodeExecutable,
      expect.arrayContaining([
        fixture.npmCliPath,
        'install',
        '--global',
        'dingtalk-workspace-cli',
        '--prefix',
        fixture.dwsPrefix,
        '--ignore-scripts',
      ]),
      expect.objectContaining({
        cwd: fixture.dataPath,
        timeout: 180000,
      })
    );
  });

  it('uses managed Node npm to install OfficeCLI into npm-global', async () => {
    const fixture = await createManagedNodeFixture();
    const commandRunner = vi.fn(async () => {
      await mkdir(path.dirname(fixture.officeCliCommandPath), { recursive: true });
      await writeFile(fixture.officeCliCommandPath, '');
      return {};
    });

    const result = await ensureOfficeCliReady({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus: vi.fn(),
      ensureNodeRuntime: async () => ({ ready: true }),
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect(commandRunner).toHaveBeenCalledWith(
      fixture.nodeExecutable,
      [
        fixture.npmCliPath,
        'install',
        '--global',
        '@officecli/officecli',
        '--prefix',
        fixture.officeCliPrefix,
        '--registry',
        'https://registry.npmmirror.com',
      ],
      {
        cwd: fixture.dataPath,
        env: expect.objectContaining({
          NPM_CONFIG_PREFIX: fixture.officeCliPrefix,
          NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com',
          npm_config_prefix: fixture.officeCliPrefix,
          npm_config_registry: 'https://registry.npmmirror.com',
        }),
        timeout: 180000,
      }
    );
  });

  it('uses managed Node npm to install Ziniao Open into npm-global', async () => {
    const fixture = await createManagedNodeFixture();
    const prefix = path.join(fixture.dataPath, 'runtime', 'npm-global', 'ziniao-open');
    const commandPath = path.join(prefix, process.platform === 'win32' ? 'ziniao-cli.cmd' : 'bin/ziniao-cli');
    const commandRunner = vi.fn(async () => {
      await mkdir(path.dirname(commandPath), { recursive: true });
      await writeFile(commandPath, '');
      return {};
    });

    const result = await ensureZiniaoOpenReady({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus: vi.fn(),
      ensureNodeRuntime: async () => ({ ready: true }),
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect(commandRunner).toHaveBeenCalledWith(
      fixture.nodeExecutable,
      [
        fixture.npmCliPath,
        'install',
        '--global',
        '@ziniao-open/cli',
        '--prefix',
        prefix,
        '--registry',
        'https://registry.npmmirror.com',
      ],
      expect.objectContaining({
        cwd: fixture.dataPath,
        timeout: 180000,
      })
    );
  });

  it('emits Codex installation status before preparing managed Node', async () => {
    const fixture = await createManagedNodeFixture();
    const calls: string[] = [];
    const emitStatus = vi.fn((event: { phase: string; resource_id?: string }) => {
      calls.push(`${event.resource_id}:${event.phase}`);
    });
    const ensureNodeRuntime = vi.fn(async () => {
      calls.push('node');
      return { ready: true };
    });
    const commandRunner = vi.fn(async () => {
      calls.push('npm');
      await mkdir(path.dirname(fixture.codexCommandPath), { recursive: true });
      await writeFile(fixture.codexCommandPath, '');
      return {};
    });

    const result = await ensureCodexReady({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus,
      ensureNodeRuntime,
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect(calls).toEqual(['codex:downloading', 'node', 'npm', 'codex:ready']);
    expect(emitStatus).toHaveBeenCalledWith({
      resource: 'acp_tool',
      resource_id: 'codex',
      scope: {
        kind: 'custom_agent',
        id: 'startup-codex',
      },
      phase: 'downloading',
      message: 'Installing Codex with managed Node runtime',
    });
  });

  it('does not reinstall OpenCode when the managed command already exists', async () => {
    const fixture = await createManagedNodeFixture();
    await mkdir(path.dirname(fixture.commandPath), { recursive: true });
    await writeFile(fixture.commandPath, '');
    const commandRunner = vi.fn(async () => ({}));

    const result = await ensureOpenCodeReady({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus: vi.fn(),
      ensureNodeRuntime: async () => ({ ready: true }),
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('prepends managed Node when the Codex command already exists', async () => {
    const fixture = await createManagedNodeFixture();
    const oldPath = path.join(fixture.dataPath, 'system-node-bin');
    process.env.PATH = oldPath;
    process.env.Path = oldPath;
    await mkdir(path.dirname(fixture.codexCommandPath), { recursive: true });
    await writeFile(fixture.codexCommandPath, '');
    const commandRunner = vi.fn(async () => ({}));

    const result = await ensureCodexReady({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus: vi.fn(),
      ensureNodeRuntime: async () => ({ ready: true }),
      env: {},
    });

    const entries = process.env.PATH?.split(path.delimiter) ?? [];
    expect(result).toEqual({ status: 'ready' });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(entries.indexOf(path.dirname(fixture.nodeExecutable))).toBeLessThan(entries.indexOf(oldPath));
  });

  it('rewrites an existing macOS Codex launcher to use managed Node directly', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const fixture = await createManagedNodeFixture();
    const packageRoot = path.join(fixture.codexPrefix, 'lib', 'node_modules', '@openai', 'codex');
    const cliPath = path.join(packageRoot, 'bin', 'codex.js');
    await mkdir(path.dirname(fixture.codexCommandPath), { recursive: true });
    await mkdir(path.dirname(cliPath), { recursive: true });
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        bin: {
          codex: 'bin/codex.js',
        },
      })
    );
    await writeFile(cliPath, '#!/usr/bin/env node\nawait Promise.resolve();\n');
    await writeFile(fixture.codexCommandPath, '#!/usr/bin/env node\nawait Promise.resolve();\n');
    const commandRunner = vi.fn(async () => ({}));

    const result = await ensureCodexReady({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus: vi.fn(),
      ensureNodeRuntime: async () => ({ ready: true }),
      env: {},
    });

    const launcher = await readFile(fixture.codexCommandPath, 'utf8');
    expect(result).toEqual({ status: 'ready' });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(launcher).toContain('AionUi managed Node launcher');
    expect(launcher).toContain(fixture.nodeExecutable);
    expect(launcher).toContain(cliPath);
  });

  it('prepends managed Node before existing PATH during startup path setup', async () => {
    const fixture = await createManagedNodeFixture();
    const env: NodeJS.ProcessEnv = {
      PATH: path.join(fixture.dataPath, 'system-node-bin'),
    };

    addStartupManagedAcpToolBinsToPath(fixture.dataPath, env);

    const entries = env.PATH?.split(path.delimiter) ?? [];
    expect(entries).toContain(path.dirname(fixture.nodeExecutable));
    expect(entries.indexOf(path.dirname(fixture.nodeExecutable))).toBeLessThan(
      entries.indexOf(path.join(fixture.dataPath, 'system-node-bin'))
    );
    if (process.platform === 'win32') {
      expect(env.Path).toBe(env.PATH);
    }
  });

  it('repairs the macOS Codex launcher before backend startup', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const fixture = await createManagedNodeFixture();
    const packageRoot = path.join(fixture.codexPrefix, 'lib', 'node_modules', '@openai', 'codex');
    const cliPath = path.join(packageRoot, 'bin', 'codex.js');
    await mkdir(path.dirname(fixture.codexCommandPath), { recursive: true });
    await mkdir(path.dirname(cliPath), { recursive: true });
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        bin: {
          codex: 'bin/codex.js',
        },
      })
    );
    await writeFile(cliPath, '#!/usr/bin/env node\nawait Promise.resolve();\n');
    await writeFile(fixture.codexCommandPath, '#!/usr/bin/env node\nawait Promise.resolve();\n');

    addStartupManagedAcpToolBinsToPath(fixture.dataPath, {
      PATH: path.join(fixture.dataPath, 'system-node-bin'),
    });

    const launcher = await readFile(fixture.codexCommandPath, 'utf8');
    expect(launcher).toContain('AionUi managed Node launcher');
    expect(launcher).toContain(fixture.nodeExecutable);
    expect(launcher).toContain(cliPath);
  });

  it('repairs the macOS OpenCode launcher to execute the native binary directly', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const fixture = await createManagedNodeFixture();
    const packageRoot = path.join(fixture.prefix, 'lib', 'node_modules', 'opencode-ai');
    const nativePath = path.join(packageRoot, 'bin', 'opencode.exe');
    await mkdir(path.dirname(fixture.commandPath), { recursive: true });
    await mkdir(path.dirname(nativePath), { recursive: true });
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        bin: {
          opencode: 'bin/opencode.exe',
        },
      })
    );
    await writeFile(nativePath, Buffer.from([0, 1, 2, 3]));
    await writeFile(fixture.commandPath, '#!/bin/sh\nexec node ./opencode.exe "$@"\n');

    addStartupManagedAcpToolBinsToPath(fixture.dataPath, {
      PATH: path.join(fixture.dataPath, 'system-node-bin'),
    });

    const launcher = await readFile(fixture.commandPath, 'utf8');
    expect(launcher).toContain('AionUi managed direct launcher');
    expect(launcher).toContain(nativePath);
    expect(launcher).not.toContain(fixture.nodeExecutable);
  });

  it('prepends the managed OpenCode bin directory to PATH', async () => {
    const dataPath = await mkdtemp(path.join(tmpdir(), 'aionui-opencode-path-'));
    const env: NodeJS.ProcessEnv = {
      PATH: ['C:\\existing\\bin'].join(path.delimiter),
    };

    const binDir = addOpenCodeGlobalBinToPath(dataPath, env);

    expect(env.PATH?.split(path.delimiter)[0]).toBe(binDir);
    if (process.platform === 'win32') {
      expect(env.Path).toBe(env.PATH);
    }
  });

  it('prepends the managed Codex bin directory to PATH', async () => {
    const dataPath = await mkdtemp(path.join(tmpdir(), 'aionui-codex-path-'));
    const env: NodeJS.ProcessEnv = {
      PATH: ['C:\\existing\\bin'].join(path.delimiter),
    };

    const binDir = addCodexGlobalBinToPath(dataPath, env);

    expect(env.PATH?.split(path.delimiter)[0]).toBe(binDir);
    if (process.platform === 'win32') {
      expect(env.Path).toBe(env.PATH);
    }
  });

  it('prepends the managed DingTalk DWS bin directory to PATH', async () => {
    const dataPath = await mkdtemp(path.join(tmpdir(), 'aionui-dws-path-'));
    const env: NodeJS.ProcessEnv = {
      PATH: ['C:\\existing\\bin'].join(path.delimiter),
    };

    const binDir = addDwsGlobalBinToPath(dataPath, env);

    expect(env.PATH?.split(path.delimiter)[0]).toBe(binDir);
    if (process.platform === 'win32') {
      expect(env.Path).toBe(env.PATH);
    }
  });

  it('prepends the managed OfficeCLI bin directory to PATH', async () => {
    const dataPath = await mkdtemp(path.join(tmpdir(), 'aionui-officecli-path-'));
    const env: NodeJS.ProcessEnv = {
      PATH: ['C:\\existing\\bin'].join(path.delimiter),
    };

    const binDir = addOfficeCliGlobalBinToPath(dataPath, env);

    expect(env.PATH?.split(path.delimiter)[0]).toBe(binDir);
    if (process.platform === 'win32') {
      expect(env.Path).toBe(env.PATH);
    }
  });

  it('prepends the managed Ziniao Open bin directory to PATH', async () => {
    const dataPath = await mkdtemp(path.join(tmpdir(), 'aionui-ziniao-open-path-'));
    const env: NodeJS.ProcessEnv = {
      PATH: ['C:\\existing\\bin'].join(path.delimiter),
    };

    const binDir = addZiniaoOpenGlobalBinToPath(dataPath, env);

    expect(env.PATH?.split(path.delimiter)[0]).toBe(binDir);
    if (process.platform === 'win32') {
      expect(env.Path).toBe(env.PATH);
    }
  });

  it('emits local runtime status while preparing OpenCode', async () => {
    const fixture = await createManagedNodeFixture();
    const emitStatus = vi.fn();
    const commandRunner = vi.fn(async () => {
      await mkdir(path.dirname(fixture.commandPath), { recursive: true });
      await writeFile(fixture.commandPath, '');
      return {};
    });

    await ensureOpenCodeReady({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus,
      ensureNodeRuntime: async () => ({ ready: true }),
      env: {},
    });

    expect(emitStatus).toHaveBeenCalledWith({
      resource: 'acp_tool',
      resource_id: 'opencode',
      scope: {
        kind: 'custom_agent',
        id: 'startup-opencode',
      },
      phase: 'downloading',
      message: 'Installing OpenCode with managed Node runtime',
    });
  });

  it('does not prepare OpenCode tool when managed Node runtime is unavailable', async () => {
    const ensureNodeRuntime = vi.fn(async () => ({ ready: false }));
    const commandRunner = vi.fn(async () => ({}));

    const result = await ensureOpenCodeReady({
      commandRunner,
      emitStatus: vi.fn(),
      ensureNodeRuntime,
      env: {},
    });

    expect(result).toEqual({
      status: 'failed',
      error: 'managed Node runtime is not ready',
    });
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('returns failed when managed Node executable is unavailable', async () => {
    const dataPath = await mkdtemp(path.join(tmpdir(), 'aionui-opencode-missing-node-'));

    const result = await ensureOpenCodeReady({
      commandRunner: async () => ({}),
      dataPath,
      emitStatus: vi.fn(),
      ensureNodeRuntime: async () => ({ ready: true }),
      env: {},
    });

    expect(result).toEqual({
      status: 'failed',
      error: 'managed Node executable was not found',
    });
  });

  it('skips bootstrap in e2e mode or when disabled by env', () => {
    expect(shouldEnsureOpenCodeOnStartup({ AIONUI_E2E_TEST: '1' })).toBe(false);
    expect(shouldEnsureOpenCodeOnStartup({ AIONUI_OPENCODE_BOOTSTRAP: '0' })).toBe(false);
    expect(shouldEnsureOpenCodeOnStartup({})).toBe(true);
    expect(shouldEnsureCodexOnStartup({ AIONUI_E2E_TEST: '1' })).toBe(false);
    expect(shouldEnsureCodexOnStartup({ AIONUI_CODEX_BOOTSTRAP: '0' })).toBe(false);
    expect(shouldEnsureCodexOnStartup({})).toBe(true);
    expect(shouldEnsureDwsOnStartup({ AIONUI_E2E_TEST: '1' })).toBe(false);
    expect(shouldEnsureDwsOnStartup({ AIONUI_DWS_BOOTSTRAP: '0' })).toBe(false);
    expect(shouldEnsureDwsOnStartup({})).toBe(true);
    expect(shouldEnsureOfficeCliOnStartup({ AIONUI_E2E_TEST: '1' })).toBe(false);
    expect(shouldEnsureOfficeCliOnStartup({ AIONUI_OFFICECLI_BOOTSTRAP: '0' })).toBe(false);
    expect(shouldEnsureOfficeCliOnStartup({})).toBe(true);
    expect(shouldEnsureZiniaoOpenOnStartup({ AIONUI_E2E_TEST: '1' })).toBe(false);
    expect(shouldEnsureZiniaoOpenOnStartup({ AIONUI_ZINIAO_OPEN_BOOTSTRAP: '0' })).toBe(false);
    expect(shouldEnsureZiniaoOpenOnStartup({})).toBe(true);
  });

  it('runs backend health-check for the managed opencode agent after runtime is ready', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const getOverrides = vi.spyOn(acpConversation.getAgentOverrides, 'invoke').mockResolvedValue({
      command_override: null,
      env_override: [],
    });
    const setOverrides = vi.spyOn(acpConversation.setAgentOverrides, 'invoke').mockResolvedValue({} as never);
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      if (url.endsWith('/api/agents/management')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'agent-claude', name: 'Claude', backend: 'claude', enabled: true },
              { id: 'agent-opencode', name: 'OpenCode', backend: 'opencode', enabled: true },
            ],
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          }
        );
      }
      if (url.endsWith('/api/agents/agent-opencode/health-check')) {
        return new Response(JSON.stringify({ data: { id: 'agent-opencode', status: 'online' } }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await checkOpenCodeManagedAgentHealth({
      backendPort: 13400,
      bootstrapResult: { status: 'ready' },
      fetchImpl,
    });

    expect(result).toEqual({
      checked: true,
      agentId: 'agent-opencode',
      status: 'online',
    });
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:13400/api/agents/management',
        method: 'GET',
      },
      {
        url: 'http://127.0.0.1:13400/api/agents/agent-opencode/health-check',
        method: 'POST',
      },
    ]);
    expect(getOverrides).toHaveBeenCalledWith({ id: 'agent-opencode' });
    expect(setOverrides).toHaveBeenCalledWith({
      id: 'agent-opencode',
      command_override: null,
      env_override: [
        {
          name: 'OPENCODE_CONFIG_DIR',
          value: expect.stringContaining(path.join('runtime', 'opencode-home')),
        },
      ],
    });
  });

  it('does not run backend health-check when managed runtime is not ready', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

    const result = await checkOpenCodeManagedAgentHealth({
      backendPort: 13400,
      bootstrapResult: { status: 'failed', error: 'managed runtime unavailable' },
      fetchImpl,
    });

    expect(result).toEqual({ checked: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs backend health-check for the managed codex agent after runtime is ready', async () => {
    vi.spyOn(acpConversation.getAgentOverrides, 'invoke').mockResolvedValue({
      command_override: null,
      env_override: [],
    });
    const setOverrides = vi.spyOn(acpConversation.setAgentOverrides, 'invoke').mockResolvedValue({} as never);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/agents/management')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'agent-opencode', name: 'OpenCode', backend: 'opencode', enabled: true },
              { id: 'agent-codex', name: 'Codex', backend: 'codex', enabled: true },
            ],
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          }
        );
      }
      if (url.endsWith('/api/agents/agent-codex/health-check')) {
        return new Response(JSON.stringify({ data: { id: 'agent-codex', status: 'online' } }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await checkCodexManagedAgentHealth({
      backendPort: 13400,
      bootstrapResult: { status: 'ready' },
      fetchImpl,
    });

    expect(result).toEqual({
      checked: true,
      agentId: 'agent-codex',
      status: 'online',
    });
    expect(setOverrides).toHaveBeenCalledWith({
      id: 'agent-codex',
      command_override: null,
      env_override: [
        {
          name: 'CODEX_HOME',
          value: expect.stringContaining(path.join('runtime', 'codex-home')),
        },
      ],
    });
  });

  it('runs backend health-check for the managed MonoSkill/DWS agent after runtime is ready', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/agents/management')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'agent-opencode', name: 'OpenCode', backend: 'opencode', enabled: true },
              { id: 'agent-monoskill', name: 'MonoSkill', backend: 'acp', enabled: true },
            ],
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          }
        );
      }
      if (url.endsWith('/api/agents/agent-monoskill/health-check')) {
        return new Response(JSON.stringify({ data: { id: 'agent-monoskill', status: 'online' } }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await checkDwsManagedAgentHealth({
      backendPort: 13400,
      bootstrapResult: { status: 'ready' },
      fetchImpl,
    });

    expect(result).toEqual({
      checked: true,
      agentId: 'agent-monoskill',
      status: 'online',
    });
  });

  it('runs backend health-check for the managed OfficeCLI agent after runtime is ready', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/agents/management')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'agent-monoskill', name: 'MonoSkill', backend: 'acp', enabled: true },
              { id: 'agent-officecli', name: 'OfficeCLI', backend: 'officecli', enabled: true },
            ],
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          }
        );
      }
      if (url.endsWith('/api/agents/agent-officecli/health-check')) {
        return new Response(JSON.stringify({ data: { id: 'agent-officecli', status: 'online' } }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await checkOfficeCliManagedAgentHealth({
      backendPort: 13400,
      bootstrapResult: { status: 'ready' },
      fetchImpl,
    });

    expect(result).toEqual({
      checked: true,
      agentId: 'agent-officecli',
      status: 'online',
    });
  });
});
