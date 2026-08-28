/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addManagedUvBinsToPath,
  ensureUvReady,
  getBundledUvArtifactName,
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

    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(fixture.ziniaoPath));
    expect(env.UV_TOOL_DIR).toBe(path.join(fixture.dataPath, 'runtime', 'uv-tools'));
    expect(env.UV_TOOL_BIN_DIR).toBe(path.dirname(fixture.ziniaoPath));
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

  it('skips the startup bootstrap in the E2E environment', () => {
    expect(isUvBootstrapEnabled({ AIONUI_E2E_TEST: '1' })).toBe(false);
    expect(isUvBootstrapEnabled({})).toBe(true);
  });
});
