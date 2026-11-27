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

  it('removes the six retired official skills while keeping other builtin skills', () => {
    const retiredSkills = [
      'xiaohongshu-recruiter',
      'weixin-file-send',
      'x-recruiter',
      'story-roleplay',
      'openclaw-setup',
      'moltbook',
    ].map((name) => ({ name, source: 'builtin' }));
    const visibleSkills = [
      { name: 'pdf', source: 'builtin' },
      { name: 'cron', source: 'builtin' },
      { name: 'moltbook-helper', source: 'builtin' },
    ];

    expect(filterVisibleSkills([...retiredSkills, ...visibleSkills])).toEqual(visibleSkills);
  });

  it.each(['custom', 'extension', 'cron', undefined])(
    'preserves same-name skills that come from source %s',
    (source) => {
      const skills = [
        'xiaohongshu-recruiter',
        'weixin-file-send',
        'x-recruiter',
        'story-roleplay',
        'openclaw-setup',
        'moltbook',
      ].map((name) => ({ name, source }));

      expect(filterVisibleSkills(skills)).toEqual(skills);
    }
  );
});
