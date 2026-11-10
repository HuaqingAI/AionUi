import { ipcBridge } from '@/common';
import type { EnsureConversationRuntimeResponse } from '@/common/types/platform/acpTypes';
import {
  getAgentModelCatalogSnapshot,
  observeAgentModelRuntimeSnapshot,
} from '@/renderer/services/runtime/agentModelCatalog';

const ensureRuntimeByConversation = new Map<string, Promise<EnsureConversationRuntimeResponse>>();

export function ensureConversationRuntime(conversation_id: string): Promise<EnsureConversationRuntimeResponse> {
  const existing = ensureRuntimeByConversation.get(conversation_id);
  if (existing) {
    return existing;
  }

  const requestScope = getAgentModelCatalogSnapshot().scope;
  const promise = ipcBridge.conversation.ensureRuntime
    .invoke({ conversation_id })
    .then((response) => {
      observeAgentModelRuntimeSnapshot(conversation_id, response.config_options, requestScope);
      return response;
    })
    .finally(() => {
      ensureRuntimeByConversation.delete(conversation_id);
    });
  ensureRuntimeByConversation.set(conversation_id, promise);
  return promise;
}

export function resetEnsureConversationRuntimeStateForTests(): void {
  ensureRuntimeByConversation.clear();
}
