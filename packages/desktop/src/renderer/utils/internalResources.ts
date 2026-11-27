/** Resources reserved for AionUi internals and hidden from user-facing pickers. */
export const isAionUiInternalResource = (name?: string): boolean => (name ?? '').trim().startsWith('aionui-');

const REMOVED_OFFICIAL_SKILLS = new Set([
  'xiaohongshu-recruiter',
  'weixin-file-send',
  'x-recruiter',
  'story-roleplay',
  'openclaw-setup',
  'moltbook',
]);

export const filterVisibleSkills = <T extends { name?: string; source?: string }>(items: T[]): T[] =>
  items.filter(
    (item) =>
      !isAionUiInternalResource(item.name) &&
      !(item.source === 'builtin' && REMOVED_OFFICIAL_SKILLS.has(item.name ?? ''))
  );

export const filterVisibleMcpServers = <T extends { name?: string }>(items: T[]): T[] =>
  items.filter((item) => !isAionUiInternalResource(item.name));
