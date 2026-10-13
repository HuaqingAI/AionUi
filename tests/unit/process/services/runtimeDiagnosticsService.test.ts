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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RuntimeDiagnosticsService', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
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
