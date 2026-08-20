import { describe, expect, it } from 'vitest';
import {
  filterVisibleMcpServers,
  filterVisibleSkills,
  isAionUiInternalResource,
} from '@/renderer/utils/internalResources';

describe('internal resource visibility', () => {
  it('recognizes the reserved aionui- prefix after trimming', () => {
    expect(isAionUiInternalResource(' aionui-private')).toBe(true);
    expect(isAionUiInternalResource('user-skill')).toBe(false);
  });

  it('filters internal skills and MCP servers while preserving visible items', () => {
    expect(filterVisibleSkills([{ name: 'aionui-system' }, { name: 'public-skill' }])).toEqual([
      { name: 'public-skill' },
    ]);
    expect(filterVisibleMcpServers([{ name: 'aionui-tools' }, { name: 'public-mcp' }])).toEqual([
      { name: 'public-mcp' },
    ]);
  });
});
