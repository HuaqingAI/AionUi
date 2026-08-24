/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { useCallback, useEffect } from 'react';
import { ensureConversationRuntime } from '../utils/ensureConversationRuntime';

type HTHProjectConfigInjectionParams = {
  conversationId?: string;
  workspace?: string;
  assistantId?: string | null;
  enabled?: boolean;
  prepareRuntime?: () => Promise<void>;
};

const injectionByKey = new Map<string, Promise<void>>();
const completedInjectionKeys = new Set<string>();
const blockingInjectionReasons = new Set([
  'authRequired',
  'personalApiKeyInvalid',
  'modelListUnavailable',
  'modelListInvalid',
  'modelListEmpty',
  'defaultModelUnavailable',
  'openCodeConfigInvalid',
]);

function injectionKey(conversationId: string, workspace: string, assistantId: string): string {
  return `${conversationId}|${workspace}|${assistantId}`;
}

export function markHTHProjectConfigInjected(conversationId: string, workspace: string, assistantId: string): void {
  completedInjectionKeys.add(injectionKey(conversationId, workspace, assistantId));
}

export function resetHTHProjectConfigInjectionStateForTests(): void {
  injectionByKey.clear();
  completedInjectionKeys.clear();
}

export function useHTHProjectConfigInjection({
  conversationId,
  workspace,
  assistantId,
  enabled = true,
  prepareRuntime,
}: HTHProjectConfigInjectionParams): () => Promise<void> {
  const inject = useCallback(async () => {
    if (!enabled || !conversationId || !workspace || !assistantId) {
      return;
    }

    const key = injectionKey(conversationId, workspace, assistantId);
    if (completedInjectionKeys.has(key)) {
      return;
    }
    const existing = injectionByKey.get(key);
    if (existing) {
      await existing;
      return;
    }

    const promise = (async () => {
      await (prepareRuntime?.() ?? ensureConversationRuntime(conversationId));
      const result = await ipcBridge.hth.injectProjectConfig.invoke({
        conversationId,
        workspace,
        assistantId,
      });
      if (result.reason && blockingInjectionReasons.has(result.reason)) {
        throw new Error(`HTH project config injection failed: ${result.reason}`);
      }
    })().finally(() => {
      if (injectionByKey.get(key) === promise) {
        injectionByKey.delete(key);
      }
    });

    injectionByKey.set(key, promise);
    await promise;
  }, [assistantId, conversationId, enabled, prepareRuntime, workspace]);

  useEffect(() => {
    void inject().catch((error) => {
      console.warn('[HTHProjectConfig] Failed to inject project config:', error);
    });
  }, [inject]);

  return inject;
}
