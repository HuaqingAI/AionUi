/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addManagedUvBinsToPath,
  ensureManagedPython,
  ensureManagedPythonOnce,
  ensureUvReady,
  getBundledUvArtifactName,
  getManagedPythonCommandDirectory,
  isUvBootstrapEnabled,
} from '@process/startup/uvStartup';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('managed uv bootstrap', () => {
  async function createRuntimeFixture(): Promise<{
    dataPath: string;
    uvPath: string;
    uvxPath: string;
    ziniaoPath: string;
  }> {
    const dataPath = await mkdtemp(path.join(tmpdir(), 'aionui-uv-startup-'));
    const extension = process.platform === 'win32' ? '.exe' : '';
    const platformDirectory =
      process.platform === 'win32' ? `uv-v0.11.31-win32-${process.arch}` : `uv-v0.11.31-darwin-${process.arch}`;
    const uvDirectory = path.join(dataPath, 'runtime', 'uv', platformDirectory);
    const toolBinDirectory = path.join(dataPath, 'runtime', 'uv-tool-bin');

    return {
      dataPath,
      uvPath: path.join(uvDirectory, `uv${extension}`),
      uvxPath: path.join(uvDirectory, `uvx${extension}`),
      ziniaoPath: path.join(toolBinDirectory, `ziniao${extension}`),
    };
  }

  async function createManagedPythonFixture(): Promise<{
    commandDirectory: string;
    dataPath: string;
    pythonPath: string;
  }> {
    const dataPath = await mkdtemp(path.join(tmpdir(), 'aionui-managed-python-'));
    const extension = process.platform === 'win32' ? '.exe' : '';
    const platformDirectory =
      process.platform === 'win32' ? `uv-v0.11.31-win32-${process.arch}` : `uv-v0.11.31-darwin-${process.arch}`;
    const uvDirectory = path.join(dataPath, 'runtime', 'uv', platformDirectory);
    const pythonDirectory = path.join(dataPath, 'runtime', 'uv-python', 'cpython-3.14.0-test');
    const pythonName = process.platform === 'win32' ? 'python.exe' : 'python3.14';
    const pythonPath = path.join(pythonDirectory, pythonName);
    await Promise.all([
      mkdir(pythonDirectory, { recursive: true }),
      mkdir(uvDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(pythonPath, 'python'),
      writeFile(path.join(uvDirectory, `uv${extension}`), 'uv'),
      writeFile(path.join(uvDirectory, `uvx${extension}`), 'uvx'),
    ]);
    if (process.platform !== 'win32') {
      await chmod(pythonPath, 0o755);
    }

    return {
      commandDirectory: getManagedPythonCommandDirectory(dataPath),
      dataPath,
      pythonPath,
    };
  }

  it('copies and extracts the bundled uv artifact without installing Ziniao', async () => {
    const fixture = await createRuntimeFixture();
    const bundledArtifactPath = path.join(fixture.dataPath, getBundledUvArtifactName());
    await writeFile(bundledArtifactPath, 'release archive');
    const copyArtifact = vi.fn(async (_source: string, destination: string) => {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, 'release archive');
    });
    const extractArtifact = vi.fn(async (_archivePath: string, destination: string) => {
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, path.basename(fixture.uvPath)), 'uv');
      await writeFile(path.join(destination, path.basename(fixture.uvxPath)), 'uvx');
    });

    const result = await ensureUvReady({
      bundledArtifactPath,
      copyArtifact,
      dataPath: fixture.dataPath,
      env: {},
      extractArtifact,
    });

    expect(result).toEqual({ status: 'ready' });
    expect(copyArtifact).toHaveBeenCalledWith(bundledArtifactPath, expect.stringContaining('uv-v0.11.31-'));
    await expect(access(fixture.uvPath)).resolves.toBeUndefined();
    await expect(access(fixture.uvxPath)).resolves.toBeUndefined();
    await expect(access(fixture.ziniaoPath)).rejects.toBeDefined();
  });

  it('does not copy the artifact when managed uv commands already exist', async () => {
    const fixture = await createRuntimeFixture();
    await mkdir(path.dirname(fixture.uvPath), { recursive: true });
    await Promise.all([writeFile(fixture.uvPath, 'uv'), writeFile(fixture.uvxPath, 'uvx')]);
    const copyArtifact = vi.fn();

    const result = await ensureUvReady({
      copyArtifact,
      dataPath: fixture.dataPath,
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect(copyArtifact).not.toHaveBeenCalled();
  });

  it('returns a failed result when the bundled release artifact cannot be copied', async () => {
    const fixture = await createRuntimeFixture();

    const result = await ensureUvReady({
      dataPath: fixture.dataPath,
      bundledArtifactPath: path.join(fixture.dataPath, 'uv-release.zip'),
      copyArtifact: async () => {
        throw new Error('bundled artifact is unreadable');
      },
      env: {},
    });

    expect(result).toEqual({ status: 'failed', error: 'bundled artifact is unreadable' });
  });

  it('adds managed uv and tool bins to PATH for MCP child processes', async () => {
    const fixture = await createRuntimeFixture();
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\existing\\bin' };

    addManagedUvBinsToPath(fixture.dataPath, env);

    expect(env.PATH?.split(path.delimiter)[0]).toBe(getManagedPythonCommandDirectory(fixture.dataPath));
    expect(env.UV_TOOL_DIR).toBe(path.join(fixture.dataPath, 'runtime', 'uv-tools'));
    expect(env.UV_TOOL_BIN_DIR).toBe(path.dirname(fixture.ziniaoPath));
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(path.join(fixture.dataPath, 'runtime', 'uv-python'));
  });

  it('does not expose an existing unmanaged Python command directory in PATH', async () => {
    const fixture = await createRuntimeFixture();
    const commandName = process.platform === 'win32' ? 'python.exe' : 'python';
    await mkdir(getManagedPythonCommandDirectory(fixture.dataPath), { recursive: true });
    await writeFile(path.join(getManagedPythonCommandDirectory(fixture.dataPath), commandName), 'unmanaged python');
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\existing\\bin' };

    addManagedUvBinsToPath(fixture.dataPath, env);

    expect(env.PATH?.split(path.delimiter)).not.toContain(getManagedPythonCommandDirectory(fixture.dataPath));
  });

  it('uses an installed managed Python without downloading and prioritizes it in PATH', async () => {
    const fixture = await createManagedPythonFixture();
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\existing\\bin' };
    const commandRunner = vi.fn(async (_file: string, args: string[]) => {
      if (args[1] === 'find') {
        return { stdout: fixture.pythonPath };
      }
      if (args[0] === '--version') {
        return { stdout: 'Python 3.14.0' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    const result = await ensureManagedPython({ commandRunner, dataPath: fixture.dataPath, env });

    expect(result).toEqual({ status: 'ready' });
    expect(commandRunner).toHaveBeenCalledTimes(2);
    expect(env.PATH?.split(path.delimiter).slice(0, 2)).toEqual([
      path.dirname(fixture.pythonPath),
      fixture.commandDirectory,
    ]);
    await expect(
      access(path.join(fixture.commandDirectory, process.platform === 'win32' ? 'python.exe' : 'python'))
    ).resolves.toBeUndefined();
  });

  it('installs Python when discovery reports no managed runtime', async () => {
    const fixture = await createManagedPythonFixture();
    const phases: string[] = [];
    let installed = false;
    const commandRunner = vi.fn(async (_file: string, args: string[]) => {
      if (args[1] === 'find') {
        if (!installed) {
          throw new Error('Python 3.14 was not found');
        }
        return { stdout: fixture.pythonPath };
      }
      if (args[1] === 'install') {
        installed = true;
        return {};
      }
      if (args[0] === '--version') {
        return { stdout: 'Python 3.14.0' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    const result = await ensureManagedPython({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus: (event) => phases.push(event.phase),
    });

    expect(result).toEqual({ status: 'ready' });
    expect(commandRunner.mock.calls.filter(([, args]) => args[0] === 'python').map(([, args]) => args.slice(0, 2))).toEqual([
      ['python', 'find'],
      ['python', 'install'],
      ['python', 'find'],
    ]);
    expect(phases).toEqual(['validating', 'downloading', 'validating', 'ready']);
  });

  it('rejects an untrusted Python discovery without adding its directory to child-process PATH', async () => {
    const fixture = await createManagedPythonFixture();
    const externalDirectory = await mkdtemp(path.join(tmpdir(), 'aionui-untrusted-python-'));
    const externalPython = path.join(externalDirectory, process.platform === 'win32' ? 'python.exe' : 'python3.14');
    await writeFile(externalPython, 'python');
    if (process.platform !== 'win32') {
      await chmod(externalPython, 0o755);
    }
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\existing\\bin' };

    const result = await ensureManagedPython({
      commandRunner: async () => ({ stdout: externalPython }),
      dataPath: fixture.dataPath,
      env,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('outside the managed runtime directory');
    expect(env.PATH?.split(path.delimiter)).not.toContain(path.dirname(externalPython));
  });

  it('rejects a managed executable that does not identify as Python 3.14', async () => {
    const fixture = await createManagedPythonFixture();
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\existing\\bin' };

    const result = await ensureManagedPython({
      commandRunner: async (_file, args) =>
        args[1] === 'find' ? { stdout: fixture.pythonPath } : { stdout: 'Python 3.13.9' },
      dataPath: fixture.dataPath,
      env,
    });

    expect(result).toEqual({ status: 'failed', error: 'uv reported a managed runtime file that is not Python 3.14' });
    expect(env.PATH?.split(path.delimiter)).not.toContain(path.dirname(fixture.pythonPath));
  });

  it('shares concurrent bootstrap requests and allows a fresh retry after failure', async () => {
    const fixture = await createManagedPythonFixture();
    let resolveFind: ((value: { stdout: string }) => void) | undefined;
    const firstFind = new Promise<{ stdout: string }>((resolve) => {
      resolveFind = resolve;
    });
    const concurrentRunner = vi.fn((_file: string, args: string[]) => {
      if (args[0] === '--version') {
        return Promise.resolve({ stdout: 'Python 3.14.0' });
      }
      return firstFind;
    });
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\existing\\bin' };

    const firstRequest = ensureManagedPythonOnce({ commandRunner: concurrentRunner, dataPath: fixture.dataPath, env });
    const secondRequest = ensureManagedPythonOnce({ commandRunner: concurrentRunner, dataPath: fixture.dataPath, env });
    expect(secondRequest).toBe(firstRequest);
    await vi.waitFor(() => expect(concurrentRunner).toHaveBeenCalledTimes(1));
    resolveFind?.({ stdout: fixture.pythonPath });
    await expect(firstRequest).resolves.toEqual({ status: 'ready' });

    let installed = false;
    let installAttempts = 0;
    const retryRunner = vi.fn(async (_file: string, args: string[]) => {
      if (args[1] === 'find') {
        if (!installed) {
          throw new Error('Python 3.14 was not found');
        }
        return { stdout: fixture.pythonPath };
      }
      if (args[0] === '--version') {
        return { stdout: 'Python 3.14.0' };
      }
      installAttempts += 1;
      if (installAttempts === 1) {
        throw new Error('network unavailable');
      }
      installed = true;
      return {};
    });

    const failed = await ensureManagedPythonOnce({ commandRunner: retryRunner, dataPath: fixture.dataPath, env });
    const retried = await ensureManagedPythonOnce({ commandRunner: retryRunner, dataPath: fixture.dataPath, env });

    expect(failed).toEqual({ status: 'failed', error: 'network unavailable' });
    expect(retried).toEqual({ status: 'ready' });
    expect(installAttempts).toBe(2);
  });

  it('selects Windows x64 and macOS bundled artifacts', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
    expect(getBundledUvArtifactName()).toBe('uv-x86_64-pc-windows-msvc.zip');

    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');
    expect(() => getBundledUvArtifactName()).toThrow('managed uv is not supported on win32-arm64');

    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');
    expect(getBundledUvArtifactName()).toBe('uv-aarch64-apple-darwin.tar.gz');
  });

  it('skips the startup bootstrap in the E2E environment', () => {
    expect(isUvBootstrapEnabled({ AIONUI_E2E_TEST: '1' })).toBe(false);
    expect(isUvBootstrapEnabled({})).toBe(true);
  });
});
