/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeDiagnosticsService } from '@process/services/runtime-diagnostics';
import {
  getManagedPythonInstallDirectoryForDiagnostics,
  getUvExecutablePathForDiagnostics,
} from '@process/startup/uvStartup';
import type { DiagnosticCommandRunner } from '@process/services/runtime-diagnostics';
import {
  getManagedStartupToolCommandPathForDiagnostics,
  getManagedStartupToolPackageRootForDiagnostics,
  type ManagedStartupToolId,
} from '@process/startup/opencodeStartup';
import { ProcessConfig } from '@process/utils/initStorage';
import type { IConfigStorageRefer, ILegacyConfigStorageRefer } from '@/common/config/storage';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RuntimeDiagnosticsService', () => {
  let savedBootstrap: IConfigStorageRefer['runtime.cliBootstrap'];

  beforeEach(() => {
    savedBootstrap = undefined;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
    vi.spyOn(ProcessConfig, 'getSync').mockImplementation(
      <K extends keyof ILegacyConfigStorageRefer>(key: K): ILegacyConfigStorageRefer[K] =>
        (key === 'runtime.cliBootstrap' ? savedBootstrap : undefined) as ILegacyConfigStorageRefer[K]
    );
    vi.spyOn(ProcessConfig, 'set').mockImplementation(async (_key, value) => {
      savedBootstrap = value as IConfigStorageRefer['runtime.cliBootstrap'];
      return value;
    });
  });

  async function createDataPath(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), 'aionui-runtime-diagnostics-'));
  }

  async function createManagedUvCommands(dataPath: string): Promise<void> {
    const uvPath = getUvExecutablePathForDiagnostics(dataPath);
    const uvxPath = getUvExecutablePathForDiagnostics(dataPath, 'uvx');
    await mkdir(path.dirname(uvPath), { recursive: true });
    await Promise.all([writeFile(uvPath, 'uv'), writeFile(uvxPath, 'uvx')]);
  }

  async function createManagedNodeCommands(dataPath: string): Promise<void> {
    const nodeDirectory = path.join(dataPath, 'runtime', 'node', 'node-v24.11.0-test');
    const npmRoot = path.join(nodeDirectory, 'node_modules', 'npm');
    await Promise.all([
      mkdir(path.join(npmRoot, 'bin'), { recursive: true }),
      mkdir(path.join(npmRoot, 'lib'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(nodeDirectory, 'node.exe'), ''),
      writeFile(path.join(npmRoot, 'package.json'), '{}'),
      writeFile(path.join(npmRoot, 'bin', 'npm-cli.js'), ''),
      writeFile(path.join(npmRoot, 'lib', 'cli.js'), ''),
    ]);
  }

  async function createManagedCli(dataPath: string, toolId: ManagedStartupToolId, version: string): Promise<void> {
    const commandPath = getManagedStartupToolCommandPathForDiagnostics(toolId, dataPath);
    const packageRoot = getManagedStartupToolPackageRootForDiagnostics(toolId, dataPath)!;
    await Promise.all([mkdir(path.dirname(commandPath), { recursive: true }), mkdir(packageRoot, { recursive: true })]);
    await Promise.all([
      writeFile(commandPath, ''),
      writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ version })),
    ]);
  }

  it('lists the managed uv, Python, and nine startup CLI components', async () => {
    const service = new RuntimeDiagnosticsService({ dataPath: await createDataPath() });

    expect(service.list().map((item) => item.id)).toEqual([
      'uv',
      'python',
      'beisen-cli',
      'codex',
      'dws',
      'googleworkspace-cli',
      'noxinfluencer-cli',
      'officecli',
      'opencode',
      'shopify-cli',
      'ziniao-open',
    ]);
    expect(service.list().filter((item) => item.bootstrapEnabled === true)).toHaveLength(8);
    expect(service.list().find((item) => item.id === 'officecli')?.bootstrapEnabled).toBe(false);
    expect(service.list().filter((item) => item.id === 'uv' || item.id === 'python')).toEqual([
      expect.not.objectContaining({ bootstrapEnabled: expect.anything() }),
      expect.not.objectContaining({ bootstrapEnabled: expect.anything() }),
    ]);
  });

  it('saves a CLI toggle without probing and restores it in a new diagnostics service', async () => {
    const dataPath = await createDataPath();
    const commandRunner = vi.fn<DiagnosticCommandRunner>(async () => ({ stdout: 'must not run' }));
    const emitDiagnosticsStatus = vi.fn();
    const service = new RuntimeDiagnosticsService({ commandRunner, dataPath, emitDiagnosticsStatus });
    await service.probe(['codex']);

    const item = await service.setBootstrap('codex', false);

    expect(item).toEqual(expect.objectContaining({ id: 'codex', bootstrapEnabled: false, status: 'missing' }));
    expect(commandRunner).not.toHaveBeenCalled();
    expect(emitDiagnosticsStatus).toHaveBeenLastCalledWith(item);
    expect(new RuntimeDiagnosticsService({ dataPath }).list().find((entry) => entry.id === 'codex')).toEqual(
      expect.objectContaining({ bootstrapEnabled: false })
    );
  });

  it.each([
    { id: 'uv', enabled: true },
    { id: 'python', enabled: false },
    { id: 'toString', enabled: true },
    { id: '__proto__', enabled: true },
    { id: undefined, enabled: true },
    { id: 'codex', enabled: 'false' },
    { id: 'codex', enabled: undefined },
  ])('rejects unsupported bootstrap setting $id/$enabled without saving', async ({ id, enabled }) => {
    const service = new RuntimeDiagnosticsService({ dataPath: await createDataPath() });

    await expect(service.setBootstrap(id, enabled)).rejects.toThrow('Invalid managed CLI bootstrap setting');
    expect(ProcessConfig.set).not.toHaveBeenCalled();
  });

  it('keeps the current toggle in a probe result and status event after an in-flight toggle change', async () => {
    const dataPath = await createDataPath();
    const commandPath = getManagedStartupToolCommandPathForDiagnostics('beisen-cli', dataPath);
    const nodeExecutable = path.join(dataPath, 'runtime', 'node', 'node-v24.11.0-test', 'node.exe');
    await mkdir(path.dirname(commandPath), { recursive: true });
    await mkdir(path.dirname(nodeExecutable), { recursive: true });
    await Promise.all([writeFile(commandPath, ''), writeFile(nodeExecutable, '')]);
    let releaseCommand!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    const commandRunner = vi.fn<DiagnosticCommandRunner>(async () => {
      commandStarted();
      await gate;
      return { stdout: '1.0.0' };
    });
    const emitDiagnosticsStatus = vi.fn();
    const service = new RuntimeDiagnosticsService({ commandRunner, dataPath, emitDiagnosticsStatus });
    const pendingProbe = service.probe(['beisen-cli']);
    await started;

    await service.setBootstrap('beisen-cli', false);
    releaseCommand();

    const [item] = await pendingProbe;
    expect(item).toEqual(expect.objectContaining({ status: 'ready', bootstrapEnabled: false }));
    expect(emitDiagnosticsStatus).toHaveBeenLastCalledWith(item);
    expect(service.list().find((entry) => entry.id === 'beisen-cli')?.bootstrapEnabled).toBe(false);
  });

  it('reports managed uv as missing when the expected command files are absent', async () => {
    const service = new RuntimeDiagnosticsService({ dataPath: await createDataPath() });

    const [uv] = await service.probe(['uv']);

    expect(uv.status).toBe('missing');
    expect(uv.command).toBe('uv');
    expect(uv.args).toEqual(['--version']);
  });

  it('accepts managed uv only when the required version command succeeds', async () => {
    const dataPath = await createDataPath();
    await createManagedUvCommands(dataPath);
    const commandRunner = vi.fn<DiagnosticCommandRunner>(async () => ({ stdout: 'uv 0.11.31' }));
    const service = new RuntimeDiagnosticsService({ commandRunner, dataPath });

    const [uv] = await service.probe(['uv']);

    expect(uv).toEqual(
      expect.objectContaining({
        status: 'ready',
        versionOutput: 'uv 0.11.31',
      })
    );
    expect(commandRunner).toHaveBeenCalledWith(
      getUvExecutablePathForDiagnostics(dataPath),
      ['--version'],
      expect.objectContaining({ cwd: dataPath, timeout: 30000 })
    );
  });

  it('rejects Python discovered outside the managed runtime directory', async () => {
    const dataPath = await createDataPath();
    await createManagedUvCommands(dataPath);
    await mkdir(getManagedPythonInstallDirectoryForDiagnostics(dataPath), { recursive: true });
    const externalPython = path.join(
      await createDataPath(),
      process.platform === 'win32' ? 'python.exe' : 'python3.14'
    );
    const commandRunner = vi.fn<DiagnosticCommandRunner>(async (_file, args) => {
      if (args[0] === 'python' && args[1] === 'find') {
        return { stdout: externalPython };
      }
      return { stdout: 'Python 3.14.0' };
    });
    const service = new RuntimeDiagnosticsService({ commandRunner, dataPath });

    const [python] = await service.probe(['python']);

    expect(python.status).toBe('broken');
    expect(python.error).toContain('outside the managed runtime directory');
  });

  it('rechecks uv after repair succeeds', async () => {
    const dataPath = await createDataPath();
    const ensureUvRuntime = vi.fn(async () => {
      await createManagedUvCommands(dataPath);
      return { status: 'ready' as const };
    });
    const service = new RuntimeDiagnosticsService({
      commandRunner: async () => ({ stdout: 'uv 0.11.31' }),
      dataPath,
      ensureUvRuntime,
    });

    const result = await service.install(['uv']);

    expect(ensureUvRuntime).toHaveBeenCalledTimes(1);
    expect(result.failedIds).toEqual([]);
    expect(result.items[0]).toEqual(expect.objectContaining({ status: 'ready', versionOutput: 'uv 0.11.31' }));
  });

  it.each([
    { installed: '1.2.0', latest: '1.3.0', updateAvailable: true },
    { installed: '10.0.0', latest: '2.0.0', updateAvailable: false },
    { installed: '1.3.0', latest: '1.3.0', updateAvailable: false },
    { installed: '2.0.0-beta.1', latest: '2.0.0', updateAvailable: true },
    { installed: '1.3.0+local', latest: '1.3.0', updateAvailable: false },
    { installed: 'unknown', latest: '1.3.0', updateAvailable: false },
  ])(
    'compares installed package $installed with registry latest $latest',
    async ({ installed, latest, updateAvailable }) => {
      const dataPath = await createDataPath();
      await createManagedNodeCommands(dataPath);
      await createManagedCli(dataPath, 'shopify-cli', installed);
      const commandRunner = vi.fn<DiagnosticCommandRunner>(async (_file, args) => {
        if (args[0] === '-v') return { stdout: 'v24.11.0' };
        if (args[1] === '--version') return { stdout: '11.6.0' };
        if (args[1] === 'view') return { stdout: JSON.stringify(latest) };
        return { stdout: `@shopify/cli/${installed} win32-x64 node-v24.11.0` };
      });
      const service = new RuntimeDiagnosticsService({ commandRunner, dataPath });

      const [item] = await service.probe(['shopify-cli']);

      expect(item).toMatchObject({
        status: 'ready',
        installedVersion: installed,
        latestVersion: latest,
        updateAvailable,
      });
      expect(service.list().find((entry) => entry.id === 'shopify-cli')).toEqual(item);
    }
  );

  it('shows the registry latest for Codex while keeping the installed version pinned', async () => {
    const dataPath = await createDataPath();
    await createManagedNodeCommands(dataPath);
    await createManagedCli(dataPath, 'codex', '0.151.0');
    const commandRunner = vi.fn<DiagnosticCommandRunner>(async (_file, args) => {
      if (args[0] === '-v') return { stdout: 'v24.11.0' };
      if (args[1] === 'view') return { stdout: '"0.160.0"' };
      return { stdout: '0.151.0' };
    });
    const service = new RuntimeDiagnosticsService({ commandRunner, dataPath });

    const [item] = await service.probe(['codex']);

    expect(item).toMatchObject({
      status: 'ready',
      installedVersion: '0.151.0',
      latestVersion: '0.160.0',
      requiredVersion: '0.151.0',
      updateAvailable: false,
    });
  });

  it('queries the latest version even when the CLI is not installed', async () => {
    const dataPath = await createDataPath();
    await createManagedNodeCommands(dataPath);
    const commandRunner = vi.fn<DiagnosticCommandRunner>(async (_file, args) => {
      if (args[0] === '-v') return { stdout: 'v24.11.0' };
      if (args[1] === 'view') return { stdout: '"1.4.0"' };
      return { stdout: '11.6.0' };
    });
    const service = new RuntimeDiagnosticsService({ commandRunner, dataPath });

    const [item] = await service.probe(['ziniao-open']);

    expect(item).toMatchObject({ status: 'missing', latestVersion: '1.4.0', updateAvailable: false });
    expect(item.installedVersion).toBeUndefined();
  });

  it('keeps a working CLI ready and clears stale upgrade information when the registry query fails', async () => {
    const dataPath = await createDataPath();
    await createManagedNodeCommands(dataPath);
    await createManagedCli(dataPath, 'ziniao-open', '1.3.0');
    let registryFailed = false;
    const commandRunner = vi.fn<DiagnosticCommandRunner>(async (_file, args) => {
      if (args[0] === '-v') return { stdout: 'v24.11.0' };
      if (args[1] === 'view') {
        if (registryFailed) throw new Error('registry unavailable token=private-token');
        return { stdout: '"1.4.0"' };
      }
      return { stdout: '1.3.0' };
    });
    const service = new RuntimeDiagnosticsService({ commandRunner, dataPath });
    await service.probe(['ziniao-open']);
    registryFailed = true;

    const [item] = await service.probe(['ziniao-open']);

    expect(item).toMatchObject({ status: 'ready', installedVersion: '1.3.0', updateAvailable: false });
    expect(item.latestVersion).toBeUndefined();
    expect(item.latestVersionError).toBe('registry unavailable token=<redacted>');
  });

  it('updates installed package metadata and clears the upgrade badge without running CLI probes after installation', async () => {
    const dataPath = await createDataPath();
    await createManagedNodeCommands(dataPath);
    await createManagedCli(dataPath, 'ziniao-open', '1.3.0');
    const commandRunner = vi.fn<DiagnosticCommandRunner>(async (_file, args) => {
      if (args[0] === '-v') return { stdout: 'v24.11.0' };
      if (args[1] === 'view') return { stdout: '"1.4.0"' };
      return { stdout: '1.3.0' };
    });
    const ensureManagedToolReady = vi.fn(async () => {
      await createManagedCli(dataPath, 'ziniao-open', '1.4.0');
      return { status: 'ready' as const };
    });
    const service = new RuntimeDiagnosticsService({ commandRunner, dataPath, ensureManagedToolReady });
    const [before] = await service.probe(['ziniao-open']);
    expect(before.updateAvailable).toBe(true);
    commandRunner.mockClear();

    const result = await service.install(['ziniao-open']);

    expect(commandRunner).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({
      status: 'ready',
      installedVersion: '1.4.0',
      latestVersion: '1.4.0',
      lastCheckedAt: before.lastCheckedAt,
      updateAvailable: false,
    });
  });

  it.each(['failure response', 'thrown error', 'skipped install'] as const)(
    'preserves the last detected versions and upgrade badge after a $0',
    async (failure) => {
      const dataPath = await createDataPath();
      await createManagedNodeCommands(dataPath);
      await createManagedCli(dataPath, 'ziniao-open', '1.3.0');
      const commandRunner = vi.fn<DiagnosticCommandRunner>(async (_file, args) => {
        if (args[0] === '-v') return { stdout: 'v24.11.0' };
        if (args[1] === 'view') return { stdout: '"1.4.0"' };
        return { stdout: '1.3.0' };
      });
      const service = new RuntimeDiagnosticsService({
        commandRunner,
        dataPath,
        ensureManagedToolReady: async () => {
          if (failure === 'thrown error') throw new Error('npm install failed');
          return { status: failure === 'skipped install' ? 'skipped' : 'failed', error: 'npm install failed' };
        },
      });
      const [before] = await service.probe(['ziniao-open']);
      commandRunner.mockClear();

      const result = await service.install(['ziniao-open']);

      expect(result.items[0]).toMatchObject({
        status: failure === 'skipped install' ? 'skipped' : 'failed',
        error: 'npm install failed',
        installedVersion: '1.3.0',
        latestVersion: '1.4.0',
        lastCheckedAt: before.lastCheckedAt,
        updateAvailable: true,
      });
      expect(commandRunner).not.toHaveBeenCalled();
    }
  );

  it('finishes an in-flight latest-version query before installing so stale checks cannot overwrite the upgrade', async () => {
    const dataPath = await createDataPath();
    await createManagedNodeCommands(dataPath);
    await createManagedCli(dataPath, 'ziniao-open', '1.3.0');
    let releaseQuery!: () => void;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    const commandRunner = vi.fn<DiagnosticCommandRunner>(async (_file, args) => {
      if (args[0] === '-v') return { stdout: 'v24.11.0' };
      if (args[1] === 'view') {
        queryStarted();
        await queryGate;
        return { stdout: '"1.4.0"' };
      }
      return { stdout: '1.3.0' };
    });
    const ensureManagedToolReady = vi.fn(async () => {
      await createManagedCli(dataPath, 'ziniao-open', '1.4.0');
      return { status: 'ready' as const };
    });
    const service = new RuntimeDiagnosticsService({ commandRunner, dataPath, ensureManagedToolReady });
    const checking = service.probe(['ziniao-open']);
    await started;

    const installing = service.install(['ziniao-open']);
    expect(ensureManagedToolReady).not.toHaveBeenCalled();
    releaseQuery();
    await Promise.all([checking, installing]);

    expect(service.list().find((item) => item.id === 'ziniao-open')).toMatchObject({
      status: 'ready',
      installedVersion: '1.4.0',
      latestVersion: '1.4.0',
      updateAvailable: false,
    });
  });

  it('deduplicates concurrent repair requests for the same component', async () => {
    const dataPath = await createDataPath();
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const ensureUvRuntime = vi.fn(async () => {
      await installGate;
      await createManagedUvCommands(dataPath);
      return { status: 'ready' as const };
    });
    const service = new RuntimeDiagnosticsService({
      commandRunner: async () => ({ stdout: 'uv 0.11.31' }),
      dataPath,
      ensureUvRuntime,
    });

    const first = service.install(['uv']);
    const second = service.install(['uv']);
    releaseInstall();
    await Promise.all([first, second]);

    expect(ensureUvRuntime).toHaveBeenCalledTimes(1);
  });
});
