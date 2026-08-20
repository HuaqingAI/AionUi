/** Resources reserved for AionUi internals and hidden from user-facing pickers. */
export const isAionUiInternalResource = (name?: string): boolean => (name ?? '').trim().startsWith('aionui-');

export const filterVisibleSkills = <T extends { name?: string }>(items: T[]): T[] =>
  items.filter((item) => !isAionUiInternalResource(item.name));

export const filterVisibleMcpServers = <T extends { name?: string }>(items: T[]): T[] =>
  items.filter((item) => !isAionUiInternalResource(item.name));
