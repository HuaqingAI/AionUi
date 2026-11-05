import { assertPathInside, copyManagedSection, normalizeZipEntryPath } from '@/process/services/hth/zipSecurity';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('hth zip security', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function createWorkspace(): Promise<{ source: string; target: string; root: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hth-project-copy-'));
    tempDirs.push(root);
    const source = path.join(root, 'package');
    const target = path.join(root, 'workspace');
    await fs.mkdir(path.join(source, 'project', '.codex'), { recursive: true });
    await fs.mkdir(target);
    await fs.writeFile(path.join(source, 'project', 'instructions.md'), 'package instructions');
    await fs.writeFile(path.join(source, 'project', '.codex', 'config.toml'), 'package config');
    return { source, target, root };
  }

  it('accepts files under global and project roots', () => {
    expect(normalizeZipEntryPath('global/opencode.jsonc')).toEqual({
      section: 'global',
      relativePath: 'opencode.jsonc',
    });
    expect(normalizeZipEntryPath('project/instructions.md')).toEqual({
      section: 'project',
      relativePath: 'instructions.md',
    });
  });

  it('rejects path traversal and unsupported roots', () => {
    expect(() => normalizeZipEntryPath('project/../escape.txt')).toThrow();
    expect(() => normalizeZipEntryPath('C:/escape.txt')).toThrow();
    expect(() => normalizeZipEntryPath('other/opencode.jsonc')).toThrow();
  });

  it('rejects target paths that escape the selected directory', () => {
    const base = path.resolve('workspace');
    expect(() => assertPathInside(base, path.join(base, 'instructions.md'))).not.toThrow();
    expect(() => assertPathInside(base, path.resolve('escape.md'))).toThrow();
  });

  it('adds missing configuration while preserving workspace edits and its existing manifest', async () => {
    const { source, target } = await createWorkspace();
    await fs.writeFile(path.join(target, 'instructions.md'), 'user edits');
    await fs.writeFile(path.join(target, '.aionui-hth-sync.json'), 'existing manifest');

    expect(await copyManagedSection(source, 'project', target, 'v2', { overwrite: false })).toEqual([
      '.codex/config.toml',
    ]);
    expect(await fs.readFile(path.join(target, 'instructions.md'), 'utf8')).toBe('user edits');
    expect(await fs.readFile(path.join(target, '.aionui-hth-sync.json'), 'utf8')).toBe('existing manifest');
  });

  it('retains explicit manual reinjection behavior', async () => {
    const { source, target } = await createWorkspace();
    await fs.writeFile(path.join(target, 'instructions.md'), 'old config');
    await copyManagedSection(source, 'project', target, 'v2');
    expect(await fs.readFile(path.join(target, 'instructions.md'), 'utf8')).toBe('package instructions');
    expect(JSON.parse(await fs.readFile(path.join(target, '.aionui-hth-sync.json'), 'utf8')).version).toBe('v2');
  });

  it('removes newly copied files when a background initialization is interrupted', async () => {
    const { source, target } = await createWorkspace();
    const copyFile = fs.copyFile.bind(fs);
    let copies = 0;
    vi.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
      copies += 1;
      if (copies === 2) throw new Error('disk write failed');
      await copyFile(...args);
    });

    await expect(copyManagedSection(source, 'project', target, 'v2', { overwrite: false })).rejects.toThrow(
      'disk write failed'
    );
    await expect(fs.access(path.join(target, '.codex', 'config.toml'))).rejects.toThrow();
    await expect(fs.access(path.join(target, 'instructions.md'))).rejects.toThrow();
  });

  it('rejects project subdirectories that redirect writes outside the workspace', async () => {
    const { source, target, root } = await createWorkspace();
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(target, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(copyManagedSection(source, 'project', target, 'v2', { overwrite: false })).rejects.toThrow(
      'escapes target directory'
    );
    await expect(fs.access(path.join(outside, 'config.toml'))).rejects.toThrow();
  });
});
