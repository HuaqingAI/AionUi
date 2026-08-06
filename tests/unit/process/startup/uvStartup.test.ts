/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addManagedUvBinsToPath,
  ensureZiniaoReady,
  getBundledUvArtifactName,
  isZiniaoBootstrapEnabled,
} from '@process/startup/uvStartup';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('managed uv and Ziniao bootstrap', () => {
  async function createRuntimeFixture(): Promise<{
    dataPath: string;
    uvPath: string;
    uvxPath: string;
    ziniaoPath: string;
    ziniaoProfilePath: string;
  }> {
    const dataPath = await mkdtemp(path.join(tmpdir(), 'aionui-ziniao-startup-'));
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
      ziniaoProfilePath: path.join(dataPath, 'runtime', 'uv-tools', 'ziniao', '.aionui-install-profile'),
    };
  }

  it('copies the bundled release artifact and installs Ziniao with managed uv', async () => {
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
    const commandRunner = vi.fn(async () => {
      await mkdir(path.dirname(fixture.ziniaoPath), { recursive: true });
      await writeFile(fixture.ziniaoPath, 'ziniao');
      return {};
    });

    const result = await ensureZiniaoReady({
      commandRunner,
      bundledArtifactPath,
      copyArtifact,
      dataPath: fixture.dataPath,
      emitStatus: vi.fn(),
      env: {},
      extractArtifact,
    });

    expect(result).toEqual({ status: 'ready' });
    expect(copyArtifact).toHaveBeenCalledWith(bundledArtifactPath, expect.stringContaining('uv-v0.11.31-'));
    expect(commandRunner).toHaveBeenCalledWith(
      fixture.uvPath,
      [
        'tool',
        'install',
        '--reinstall',
        '--default-index',
        'https://pypi.tuna.tsinghua.edu.cn/simple',
        '--with',
        'mcp<2',
        'ziniao',
      ],
      expect.objectContaining({
        cwd: fixture.dataPath,
        env: expect.objectContaining({
          UV_MANAGED_PYTHON: '1',
          UV_DEFAULT_INDEX: 'https://pypi.tuna.tsinghua.edu.cn/simple',
          UV_TOOL_BIN_DIR: path.dirname(fixture.ziniaoPath),
        }),
        timeout: 180000,
      })
    );
  });

  it('does not copy or reinstall when the managed commands already exist', async () => {
    const fixture = await createRuntimeFixture();
    await mkdir(path.dirname(fixture.uvPath), { recursive: true });
    await mkdir(path.dirname(fixture.ziniaoPath), { recursive: true });
    await Promise.all([
      writeFile(fixture.uvPath, 'uv'),
      writeFile(fixture.uvxPath, 'uvx'),
      writeFile(fixture.ziniaoPath, 'ziniao'),
      mkdir(path.dirname(fixture.ziniaoProfilePath), { recursive: true }).then(() =>
        writeFile(fixture.ziniaoProfilePath, 'mcp<2\n')
      ),
    ]);
    const copyArtifact = vi.fn();
    const commandRunner = vi.fn();

    const result = await ensureZiniaoReady({
      commandRunner,
      dataPath: fixture.dataPath,
      copyArtifact,
      emitStatus: vi.fn(),
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect(copyArtifact).not.toHaveBeenCalled();
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('reinstalls a legacy Ziniao tool without the managed dependency profile', async () => {
    const fixture = await createRuntimeFixture();
    await mkdir(path.dirname(fixture.uvPath), { recursive: true });
    await mkdir(path.dirname(fixture.ziniaoPath), { recursive: true });
    await Promise.all([
      writeFile(fixture.uvPath, 'uv'),
      writeFile(fixture.uvxPath, 'uvx'),
      writeFile(fixture.ziniaoPath, 'ziniao'),
    ]);
    const commandRunner = vi.fn(async () => ({}));

    const result = await ensureZiniaoReady({
      commandRunner,
      dataPath: fixture.dataPath,
      emitStatus: vi.fn(),
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect(commandRunner).toHaveBeenCalledWith(
      fixture.uvPath,
      expect.arrayContaining(['--reinstall', '--with', 'mcp<2']),
      expect.any(Object)
    );
  });

  it('repairs the invalid nodriver source encoding before OpenCode starts Ziniao', async () => {
    const fixture = await createRuntimeFixture();
    const nodriverSourcePath = path.join(
      fixture.dataPath,
      'runtime',
      'uv-tools',
      'ziniao',
      process.platform === 'win32' ? 'Lib' : path.join('lib', 'python3.14'),
      'site-packages',
      'nodriver',
      'cdp',
      'network.py'
    );
    await mkdir(path.dirname(fixture.uvPath), { recursive: true });
    await mkdir(path.dirname(fixture.ziniaoPath), { recursive: true });
    await mkdir(path.dirname(nodriverSourcePath), { recursive: true });
    await Promise.all([
      writeFile(fixture.uvPath, 'uv'),
      writeFile(fixture.uvxPath, 'uvx'),
      writeFile(fixture.ziniaoPath, 'ziniao'),
      mkdir(path.dirname(fixture.ziniaoProfilePath), { recursive: true }).then(() =>
        writeFile(fixture.ziniaoProfilePath, 'mcp<2\n')
      ),
      writeFile(nodriverSourcePath, Buffer.from('JSON (\xb1Inf).', 'binary')),
    ]);

    const result = await ensureZiniaoReady({
      dataPath: fixture.dataPath,
      emitStatus: vi.fn(),
      env: {},
    });

    expect(result).toEqual({ status: 'ready' });
    expect((await readFile(nodriverSourcePath)).subarray(0, 26).toString('ascii')).toBe('# -*- coding: gb18030 -*-\n');
  });

  it('returns a failed result when the bundled release artifact cannot be copied', async () => {
    const fixture = await createRuntimeFixture();
    const commandRunner = vi.fn();

    const result = await ensureZiniaoReady({
      commandRunner,
      dataPath: fixture.dataPath,
      bundledArtifactPath: path.join(fixture.dataPath, 'uv-release.zip'),
      copyArtifact: async () => {
        throw new Error('bundled artifact is unreadable');
      },
      emitStatus: vi.fn(),
      env: {},
    });

    expect(result).toEqual({ status: 'failed', error: 'bundled artifact is unreadable' });
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('adds managed uv and tool bins to PATH for MCP child processes', async () => {
    const fixture = await createRuntimeFixture();
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\existing\\bin' };

    addManagedUvBinsToPath(fixture.dataPath, env);

    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(fixture.ziniaoPath));
    expect(env.UV_TOOL_DIR).toBe(path.join(fixture.dataPath, 'runtime', 'uv-tools'));
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(path.join(fixture.dataPath, 'runtime', 'uv-python'));
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

  it('allows the startup bootstrap to be disabled for tests and support diagnostics', () => {
    expect(isZiniaoBootstrapEnabled({ AIONUI_E2E_TEST: '1' })).toBe(false);
    expect(isZiniaoBootstrapEnabled({ AIONUI_ZINIAO_BOOTSTRAP: '0' })).toBe(false);
    expect(isZiniaoBootstrapEnabled({})).toBe(true);
  });
});
