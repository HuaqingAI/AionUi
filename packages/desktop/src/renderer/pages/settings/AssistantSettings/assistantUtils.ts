import { resolveExtensionAssetUrl } from '@/renderer/utils/platform';
import { isBackendRelativeAssetPath, isLikelyLocalFilePath } from '@/renderer/utils/model/assistantAvatar';
import { ASSISTANT_CATEGORY_CODES, type AssistantCategoryCode } from '@/common/types/agent/assistantCategories';
import type { AssistantListItem, AvailableBackend } from './types';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';

export type AssistantListFilter = 'all' | 'enabled' | 'disabled' | 'builtin' | 'user';

/**
 * Source tag shown next to an assistant in the settings list.
 *
 * - `builtin` → "Built-in" tag
 * - `user` → "Custom" tag
 * - `generated` (agent-generated) → "CLI" tag, matching the product terminology.
 */
export type AssistantSourceTag = 'builtin' | 'custom' | 'cli' | null;

export const resolveAssistantSourceTag = (source: string): AssistantSourceTag => {
  if (source === 'builtin') return 'builtin';
  if (source === 'generated') return 'cli';
  return 'custom';
};

/**
 * Check if a string is an emoji (simple check for common emoji patterns).
 */
export const isEmoji = (str: string): boolean => {
  if (!str) return false;
  const emojiRegex = /^(?:\p{Emoji_Presentation}|\p{Emoji}️)(?:‍(?:\p{Emoji_Presentation}|\p{Emoji}️))*$/u;
  return emojiRegex.test(str);
};

/**
 * Resolve an avatar string to an image src URL, or undefined if it is not an image.
 */
export const resolveAvatarImageSrc = (avatar: string | undefined): string | undefined => {
  const value = avatar?.trim();
  if (!value) return undefined;

  if (isLikelyLocalFilePath(value)) return undefined;
  if (value.startsWith('/') && !isBackendRelativeAssetPath(value)) return undefined;

  const resolved = resolveExtensionAssetUrl(value) || value;
  const isImage = /\.(svg|png|jpe?g|webp|gif)$/i.test(resolved) || /^(https?:|file:\/\/|data:|\/)/i.test(resolved);
  return isImage ? resolved : undefined;
};

/**
 * Sort assistants by sortOrder. The backend already returns sorted lists; this
 * is a deterministic fallback for local reorder operations.
 */
export const sortAssistants = (list: AssistantListItem[]): AssistantListItem[] =>
  [...list].toSorted((a, b) => a.sort_order - b.sort_order);

/**
 * Reorder assistants by moving `activeId` to the position of `overId`.
 */
export const reorderAssistantList = (
  assistants: AssistantListItem[],
  activeId: string,
  overId: string
): AssistantListItem[] => {
  const activeIndex = assistants.findIndex((assistant) => assistant.id === activeId);
  const overIndex = assistants.findIndex((assistant) => assistant.id === overId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return assistants;
  }

  const nextAssistants = [...assistants];
  const [movedAssistant] = nextAssistants.splice(activeIndex, 1);
  nextAssistants.splice(overIndex, 0, movedAssistant);
  return nextAssistants;
};

/**
 * Apply search and management filter to assistant list.
 */
export const filterAssistants = (
  assistants: AssistantListItem[],
  query: string,
  filter: AssistantListFilter,
  localeKey: string
): AssistantListItem[] => {
  const normalizedQuery = query.trim().toLowerCase();

  return assistants.filter((assistant) => {
    if (normalizedQuery) {
      const searchableText = [
        assistant.name_i18n?.[localeKey] || assistant.name,
        assistant.description_i18n?.[localeKey] || assistant.description || '',
      ]
        .join(' ')
        .toLowerCase();

      if (!searchableText.includes(normalizedQuery)) return false;
    }

    switch (filter) {
      case 'enabled':
        return assistant.enabled !== false;
      case 'disabled':
        return assistant.enabled === false;
      case 'builtin':
        return assistant.source === 'builtin';
      case 'user':
        return assistant.source === 'user';
      case 'all':
      default:
        return true;
    }
  });
};

/**
 * Split assistants into enabled and disabled groups while preserving order.
 */
export const groupAssistantsByEnabled = (assistants: AssistantListItem[]) => ({
  enabledAssistants: assistants.filter((assistant) => assistant.enabled !== false),
  disabledAssistants: assistants.filter((assistant) => assistant.enabled === false),
});

export type AssistantEnabledFilter = 'all' | 'enabled' | 'disabled';

/** Apply the enabled/disabled dropdown filter used by the "My Assistants" tab. */
export const filterByEnabled = (
  assistants: AssistantListItem[],
  filter: AssistantEnabledFilter
): AssistantListItem[] => {
  switch (filter) {
    case 'enabled':
      return assistants.filter((assistant) => assistant.enabled !== false);
    case 'disabled':
      return assistants.filter((assistant) => assistant.enabled === false);
    default:
      return assistants;
  }
};

const byAssistantSortOrder = (a: AssistantListItem, b: AssistantListItem) => a.sort_order - b.sort_order;
const ASSISTANT_EDITOR_AGENT_TYPES = new Set(['acp', 'aionrs']);

const isAssistantEditorAgent = (agent: ManagedAgent): boolean => ASSISTANT_EDITOR_AGENT_TYPES.has(agent.agent_type);

/**
 * Split the user's own assistants for the "My Assistants" tab.
 * Only user-created assistants are shown there.
 */
export const groupMyAssistants = (assistants: AssistantListItem[]) => {
  return {
    cliAssistants: [] as AssistantListItem[],
    createdAssistants: assistants.filter((a) => a.source === 'user').toSorted(byAssistantSortOrder),
  };
};

export type AssistantCategoryGroup = {
  code: AssistantCategoryCode;
  assistants: AssistantListItem[];
};

/** Group user assistants by the fixed category order from the Agent Platform. */
export const groupAssistantsByCategory = (assistants: AssistantListItem[]): AssistantCategoryGroup[] => {
  const groups = new Map<AssistantCategoryCode, AssistantListItem[]>();
  for (const code of ASSISTANT_CATEGORY_CODES) {
    groups.set(code, []);
  }

  for (const assistant of assistants) {
    const categories = assistant.categories?.filter((category): category is AssistantCategoryCode =>
      ASSISTANT_CATEGORY_CODES.includes(category as AssistantCategoryCode)
    );
    const effectiveCategories: AssistantCategoryCode[] = categories && categories.length > 0 ? categories : ['general'];
    for (const category of effectiveCategories) {
      const group = groups.get(category);
      if (group && !group.some((item) => item.id === assistant.id)) {
        group.push(assistant);
      }
    }
  }

  return ASSISTANT_CATEGORY_CODES.map((code) => ({ code, assistants: groups.get(code) ?? [] })).filter(
    (group) => group.assistants.length > 0
  );
};

export const buildAssistantEditorBackends = (
  agents: ManagedAgent[],
  localeKey: string,
  currentAgentId?: string
): AvailableBackend[] => {
  const backendMap = new Map<string, AvailableBackend>();

  for (const agent of agents) {
    if (!isAssistantEditorAgent(agent)) {
      continue;
    }

    const agentId = agent.id?.trim() || '';
    const status = agent.status;
    const isCurrent = Boolean(currentAgentId && agentId === currentAgentId);
    const isSelectable = agent.enabled !== false && (status === 'online' || status === 'unchecked');
    if (!agentId || backendMap.has(agentId) || (!isSelectable && !isCurrent)) {
      continue;
    }

    const runtimeKey = (agent.backend || agent.agent_type || '').trim();
    if (!runtimeKey) {
      continue;
    }

    backendMap.set(agentId, {
      id: agentId,
      name: agent.name_i18n?.[localeKey] || agent.name,
      runtimeKey,
      isExtension: agent.isExtension,
      // Prefer the agent's own avatar/icon; the dropdown falls back to the logo
      // catalog (keyed by runtimeKey) when this is empty.
      icon: agent.avatar || agent.icon,
      customAgentId: agent.custom_agent_id,
      modelOptions: [],
    });
  }

  return [...backendMap.values()];
};
