/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isChatFileRef, type ChatFileRef } from '@/common/types/chatFile';
import { deriveSelectOption, hasObservedValue } from '@/renderer/hooks/agent/useAcpConfigOptions';
import { markHTHProjectConfigInjected } from '../hooks/useHTHProjectConfigInjection';
import { getConversationOrNull } from '../utils/conversationCache';
import { ensureConversationRuntime } from '../utils/ensureConversationRuntime';
import { getAgentModelCatalogSnapshot } from '@/renderer/services/runtime/agentModelCatalog';
import type { TFunction } from 'i18next';

type ConversationPreparationRequest = {
  backend: 'codex' | 'opencode';
  assistantId: string;
  workspace?: string;
  model?: string | null;
  thoughtLevel?: string;
  initialMessage?: { input: string; files?: ChatFileRef[] };
};

type PendingConversationPreparation = ConversationPreparationRequest & { version: 1; scope: string | null };

const STORAGE_PREFIX = 'aionui.conversation-preparation.v1:';
const preparationsInFlight = new Map<string, Promise<void>>();
const blockingInjectionReasons = new Set([
  'authRequired',
  'personalApiKeyInvalid',
  'modelListUnavailable',
  'modelListInvalid',
  'modelListEmpty',
  'defaultModelUnavailable',
  'openCodeConfigInvalid',
  'codexConfigInvalid',
  'reasoningPolicyUnavailable',
  'reasoningPolicyInvalid',
  'reasoningPolicyForbidden',
  'codexModelListEmpty',
  'cronModelUnavailable',
  'cronReasoningEffortUnavailable',
]);

/** Save the first-turn intent before navigation, without starting the CLI. */
export function registerConversationPreparation(conversationId: string, request: ConversationPreparationRequest): void {
  const pending: PendingConversationPreparation = {
    ...request,
    version: 1,
    scope: getAgentModelCatalogSnapshot().scope,
  };
  sessionStorage.setItem(STORAGE_PREFIX + conversationId, JSON.stringify(pending));
}

/** Restore unfinished preparation after navigation, remount, or reload. */
export function getConversationPreparation(conversationId: string): PendingConversationPreparation | null {
  const stored = sessionStorage.getItem(STORAGE_PREFIX + conversationId);
  if (stored === null) return null;
  const pending = JSON.parse(stored) as PendingConversationPreparation;
  if (
    !pending ||
    pending.version !== 1 ||
    !['codex', 'opencode'].includes(pending.backend) ||
    typeof pending.assistantId !== 'string' ||
    (pending.scope !== null && typeof pending.scope !== 'string') ||
    (pending.initialMessage !== undefined &&
      (typeof pending.initialMessage?.input !== 'string' ||
        (pending.initialMessage.files !== undefined &&
          (!Array.isArray(pending.initialMessage.files) || !pending.initialMessage.files.every(isChatFileRef)))))
  ) {
    throw new Error('Invalid conversation preparation');
  }
  return pending;
}

function assertPreparationScope(pending: PendingConversationPreparation, t: TFunction): void {
  if (pending.scope !== getAgentModelCatalogSnapshot().scope) {
    throw new Error(t('conversation.createFailed'));
  }
}

/** Prepare project configuration before any chat component may start or send to the CLI. */
export function prepareConversation(conversationId: string, t: TFunction, workspace?: string): Promise<void> {
  const existing = preparationsInFlight.get(conversationId);
  if (existing) return existing;

  // Read inside the async operation so invalid persisted state follows the same retry UI.
  const promise = (async () => {
    const pending = getConversationPreparation(conversationId);
    if (!pending) return;
    assertPreparationScope(pending, t);
    const startedAt = Date.now();
    console.info('[ConversationPreparation] started', { conversationId, backend: pending.backend });

    let projectWorkspace = workspace || pending.workspace;
    if (pending.backend === 'codex' && !projectWorkspace) {
      projectWorkspace = (await getConversationOrNull(conversationId))?.extra?.workspace;
      assertPreparationScope(pending, t);
    }
    if (pending.backend === 'codex' && !projectWorkspace) {
      throw new Error('Codex workspace is unavailable after conversation creation');
    }

    const result = await ipcBridge.hth.injectProjectConfig.invoke({
      conversationId,
      workspace: projectWorkspace,
      assistantId: pending.assistantId,
    });
    assertPreparationScope(pending, t);
    if (result.reason && blockingInjectionReasons.has(result.reason)) {
      throw new Error(`HTH project config injection failed: ${result.reason}`);
    }
    if (pending.backend === 'codex' && projectWorkspace) {
      markHTHProjectConfigInjected(conversationId, projectWorkspace, pending.assistantId);
    }

    if (pending.backend === 'opencode' && pending.thoughtLevel) {
      // Keep the original first-turn confirmation: startup can discard an effort
      // against the default model before switching to the selected model.
      const { config_options } = await ensureConversationRuntime(conversationId);
      assertPreparationScope(pending, t);
      const model = deriveSelectOption(config_options, 'model', ['model']);
      if (pending.model && model?.currentValue !== pending.model) {
        throw new Error(t('agent.model.switchFailed'));
      }
      const thoughtLevel = deriveSelectOption(config_options, 'thought_level', [
        'thought_level',
        'reasoning_effort',
        'effort',
        'thinking_budget',
        'thinking',
      ]);
      if (!thoughtLevel?.options.some(({ value }) => value === pending.thoughtLevel)) {
        throw new Error(t('agent.thoughtLevel.switchFailed'));
      }
      if (thoughtLevel.currentValue !== pending.thoughtLevel) {
        const response = await ipcBridge.acpConversation.setConfigOption.invoke({
          conversation_id: conversationId,
          option_id: thoughtLevel.id,
          value: pending.thoughtLevel,
        });
        assertPreparationScope(pending, t);
        if (!hasObservedValue(response, thoughtLevel.id, pending.thoughtLevel)) {
          throw new Error(t('agent.thoughtLevel.switchFailed'));
        }
      }
    }

    // Hand off atomically before opening the chat. Its existing initial-message
    // hook still checks the managed environment and uses the normal send path.
    if (pending.initialMessage) {
      sessionStorage.setItem(`acp_initial_message_${conversationId}`, JSON.stringify(pending.initialMessage));
    }
    sessionStorage.removeItem(STORAGE_PREFIX + conversationId);
    console.info('[ConversationPreparation] ready', {
      conversationId,
      backend: pending.backend,
      durationMs: Date.now() - startedAt,
    });
  })().finally(() => {
    preparationsInFlight.delete(conversationId);
  });
  preparationsInFlight.set(conversationId, promise);
  return promise;
}

export function resetConversationPreparationForTests(): void {
  preparationsInFlight.clear();
}
