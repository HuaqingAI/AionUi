import { assertPathInside, normalizeZipEntryPath } from '@/process/services/hth/zipSecurity';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('hth zip security', () => {
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
});
