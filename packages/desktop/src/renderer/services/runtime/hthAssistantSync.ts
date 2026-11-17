/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { HTHAuthStatus, HTHSyncProgressEvent, HTHSyncResult } from '@/common/types/hth';
import { mutate } from 'swr';

const startupScopes = new Set<string>();
const listeners = new Set<() => void>();
let loginProgress: HTHSyncProgressEvent | null = null;
let loginSync: { key: string; promise: Promise<HTHSyncResult> } | null = null;
let assistantScope: string | null = null;

/** Invalidate account-specific update hints before exposing a new account's pages. */
export function setHTHAssistantSyncScope(status: HTHAuthStatus | null): void {
  const scope = status?.loggedIn ? JSON.stringify([status.baseUrl, status.email]) : null;
  if (scope === assistantScope) return;
  assistantScope = scope;
  void mutate('hth.assistantUpdates', undefined, { revalidate: true }).catch((): void => undefined);
}

export function subscribeHTHLoginSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getHTHLoginSyncProgress(): HTHSyncProgressEvent | null {
  return loginProgress;
}

/** Share one login sync between the loopback poll and the protocol callback. */
export function syncHTHAssistantsAfterLogin(status: HTHAuthStatus): Promise<HTHSyncResult> {
  if (!status.loggedIn) return Promise.reject(new Error('HTH login is required before assistant synchronization'));
  const scope = JSON.stringify([status.baseUrl, status.email]);
  const key = JSON.stringify([scope, status.lastLoginAt]);
  if (loginSync?.key === key) return loginSync.promise;

  startupScopes.add(scope);
  const syncId = crypto.randomUUID();
  loginProgress = { syncId, stage: 'preparing', total: 0, completed: 0, synced: 0, failed: 0 };
  listeners.forEach((listener) => listener());
  const unsubscribe = ipcBridge.hth.syncAgentConfigsProgress.on((event) => {
    if (event.syncId !== syncId) return;
    loginProgress = event;
    listeners.forEach((listener) => listener());
  });
  const promise = Promise.resolve()
    .then(() => ipcBridge.hth.syncAgentConfigs.invoke({ force: true, syncId }))
    .finally(() => {
      unsubscribe();
      loginProgress = null;
      listeners.forEach((listener) => listener());
      void mutate('assistants.list').catch((): void => undefined);
      void mutate('hth.assistantUpdates').catch((): void => undefined);
    });
  loginSync = { key, promise };
  return promise;
}

/** Start once per account and app load; navigation never waits for this work. */
export function startHTHAssistantBackgroundSync(status: HTHAuthStatus): void {
  if (!status.loggedIn || !status.baseUrl || !status.email) return;
  const scope = JSON.stringify([status.baseUrl, status.email]);
  if (startupScopes.has(scope)) return;
  startupScopes.add(scope);
  void Promise.resolve()
    .then(() => ipcBridge.hth.syncAgentConfigs.invoke({ incremental: true, background: true }))
    .catch(() => {
      console.warn('[HTH] Background assistant synchronization failed');
    })
    .finally(() => {
      void mutate('assistants.list').catch((): void => undefined);
      void mutate('hth.assistantUpdates').catch((): void => undefined);
    });
}
