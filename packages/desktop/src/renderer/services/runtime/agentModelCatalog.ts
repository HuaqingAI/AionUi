/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { TChatConversation } from '@/common/config/storage';
import type { HTHInitialModelCatalog } from '@/common/types/hth';
import type { AcpConfigOptionDto, AcpModelInfo } from '@/common/types/platform/acpTypes';

type AgentBackend = 'codex' | 'opencode';
type Model = AcpModelInfo['available_models'][number];
type ConversationRegistration = {
  id: string;
  createdAt: number;
  agentId: string;
  backend: AgentBackend;
};
type ObservedCatalog = ConversationRegistration & { modelInfo: AcpModelInfo; baselineModelIds?: string[] };

export type AgentModelCatalogSnapshot = {
  scope: string | null;
  initialModelIds: string[];
  initialModelLabels: Record<string, string>;
  initialCodexConfigOptions: AcpConfigOptionDto[];
  initialOpenCodeConfigOptions: AcpConfigOptionDto[];
  observed: Record<string, AcpModelInfo>;
};

const STORAGE_PREFIX = 'aionui.agent-model-catalog.v1:';
const listeners = new Set<() => void>();
const conversations = new Map<string, ConversationRegistration>();
const latestConversations = new Map<string, ConversationRegistration>();
const observedCatalogs = new Map<string, ObservedCatalog>();
const managementModelIds = new Map<string, string[]>();
let snapshot: AgentModelCatalogSnapshot = {
  scope: null,
  initialModelIds: [],
  initialModelLabels: {},
  initialCodexConfigOptions: [],
  initialOpenCodeConfigOptions: [],
  observed: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function supportedBackend(value: unknown): AgentBackend | undefined {
  const backend = nonemptyString(value)?.toLowerCase();
  return backend === 'codex' || backend === 'opencode' ? backend : undefined;
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseModels(value: unknown, idField: 'id' | 'value', backend?: AgentBackend): Model[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const models = new Map<string, Model>();
  for (const item of value) {
    if (!isRecord(item)) return null;
    const id = nonemptyString(item[idField]);
    if (!id) return null;
    if (backend === 'opencode' && !id.startsWith('hth/')) continue;
    models.set(id, {
      id,
      label: nonemptyString(item.label) ?? nonemptyString(item.name) ?? id,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
    });
  }
  return models.size > 0 ? [...models.values()] : null;
}

function modelInfo(models: Model[]): AcpModelInfo {
  // The catalog carries choices only; a conversation's selected model is never an Agent default.
  return { current_model_id: null, current_model_label: null, available_models: models };
}

function sortedModelIds(models: Model[]): string[] {
  return models.map((model) => model.id).toSorted();
}

function sameModelIds(left: string[] | undefined, right: string[]): boolean {
  return left?.length === right.length && left.every((id, index) => id === right[index]);
}

function parseConfigModels(payload: unknown, backend: AgentBackend): Model[] | null {
  const options: unknown = Array.isArray(payload) ? payload : isRecord(payload) ? payload.config_options : null;
  if (!Array.isArray(options)) return null;
  const option = options.find(
    (item: unknown) => isRecord(item) && item.category === 'model' && (item.option_type ?? item.type) === 'select'
  );
  return isRecord(option) ? parseModels(option.options, 'value', backend) : null;
}

function sameModels(left: AcpModelInfo | undefined, right: AcpModelInfo): boolean {
  return (
    left?.available_models.length === right.available_models.length &&
    left.available_models.every((model, index) => {
      const other = right.available_models[index];
      return model.id === other.id && model.label === other.label && model.description === other.description;
    })
  );
}

function publish(next: AgentModelCatalogSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function persistObservedCatalogs(): void {
  if (!snapshot.scope) return;
  try {
    localStorage.setItem(
      STORAGE_PREFIX + snapshot.scope,
      JSON.stringify({ version: 1, entries: [...observedCatalogs.values()] })
    );
  } catch {
    // Storage availability must not prevent model selection in the current window.
  }
}

function recordObservedModels(registration: ConversationRegistration, models: Model[]): void {
  const next = modelInfo(models);
  const previous = observedCatalogs.get(registration.agentId);
  const baselineModelIds = managementModelIds.get(registration.agentId) ?? previous?.baselineModelIds;
  const unchangedModels = sameModels(previous?.modelInfo, next);
  if (
    unchangedModels &&
    previous?.id === registration.id &&
    previous.createdAt === registration.createdAt &&
    previous.baselineModelIds === baselineModelIds
  ) {
    return;
  }
  observedCatalogs.set(registration.agentId, { ...registration, modelInfo: next, baselineModelIds });
  persistObservedCatalogs();
  if (!unchangedModels) publish({ ...snapshot, observed: { ...snapshot.observed, [registration.agentId]: next } });
}

/** Switch account/API scope and restore only its previously observed Agent choices. */
export function setAgentModelCatalogScope(scope: string | null): void {
  if (snapshot.scope === scope) return;
  conversations.clear();
  latestConversations.clear();
  observedCatalogs.clear();
  managementModelIds.clear();
  if (scope) {
    try {
      const stored = parsePayload(localStorage.getItem(STORAGE_PREFIX + scope));
      if (isRecord(stored) && stored.version === 1 && Array.isArray(stored.entries)) {
        for (const entry of stored.entries) {
          if (!isRecord(entry)) continue;
          const id = nonemptyString(entry.id);
          const agentId = nonemptyString(entry.agentId);
          const backend = supportedBackend(entry.backend);
          if (!id || !agentId || !backend || typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt)) {
            continue;
          }
          const models = isRecord(entry.modelInfo)
            ? parseModels(entry.modelInfo.available_models, 'id', backend)
            : null;
          if (!models) continue;
          const baselineModelIds =
            Array.isArray(entry.baselineModelIds) &&
            entry.baselineModelIds.length > 0 &&
            entry.baselineModelIds.every((value: unknown) => nonemptyString(value))
              ? [
                  ...new Set(entry.baselineModelIds.map(nonemptyString).filter((value) => value !== undefined)),
                ].toSorted()
              : undefined;
          const catalog = {
            id,
            createdAt: entry.createdAt,
            agentId,
            backend,
            modelInfo: modelInfo(models),
            baselineModelIds,
          };
          observedCatalogs.set(agentId, catalog);
          latestConversations.set(agentId, catalog);
        }
      }
    } catch {
      // Ignore invalid or unavailable local storage and discover fresh choices normally.
    }
  }
  publish({
    scope,
    initialModelIds: [],
    initialModelLabels: {},
    initialCodexConfigOptions: [],
    initialOpenCodeConfigOptions: [],
    observed: Object.fromEntries([...observedCatalogs].map(([agentId, catalog]) => [agentId, catalog.modelInfo])),
  });
}

/** Supply initial gateway candidates without replacing a session-observed catalog. */
export function seedAgentModelCatalog(catalog: HTHInitialModelCatalog): void {
  if (!snapshot.scope || catalog.scope !== snapshot.scope || !Array.isArray(catalog.modelIds)) return;
  const modelIds = [...new Set(catalog.modelIds.map(nonemptyString).filter((id) => id !== undefined))];
  const initialModelLabels = catalog.modelLabels ?? {};
  const initialCodexConfigOptions = catalog.codexConfigOptions ?? [];
  const initialOpenCodeConfigOptions = catalog.opencodeConfigOptions ?? [];
  if (
    modelIds.length === 0 ||
    (modelIds.every((id, index) => id === snapshot.initialModelIds[index]) &&
      modelIds.length === snapshot.initialModelIds.length &&
      JSON.stringify(initialModelLabels) === JSON.stringify(snapshot.initialModelLabels) &&
      JSON.stringify(initialCodexConfigOptions) === JSON.stringify(snapshot.initialCodexConfigOptions) &&
      JSON.stringify(initialOpenCodeConfigOptions) === JSON.stringify(snapshot.initialOpenCodeConfigOptions))
  ) {
    return;
  }
  publish({
    ...snapshot,
    initialModelIds: modelIds,
    initialModelLabels,
    initialCodexConfigOptions,
    initialOpenCodeConfigOptions,
  });
}

/** Register ownership before runtime events arrive, retaining the newest conversation per Agent. */
export function registerAgentModelConversation(
  conversation: Pick<TChatConversation, 'id' | 'created_at' | 'extra'>,
  identity?: { agentId?: string; backend?: string }
): void {
  if (!snapshot.scope || !conversation) return;
  const extra: Record<string, unknown> = isRecord(conversation.extra) ? conversation.extra : {};
  const id = nonemptyString(conversation.id);
  const agentId =
    nonemptyString(extra.agent_id) ?? nonemptyString(extra.custom_agent_id) ?? nonemptyString(identity?.agentId);
  const backend = supportedBackend(identity?.backend ?? extra.backend);
  if (!id || !agentId || !backend) return;
  const createdAt = Number.isFinite(conversation.created_at) ? conversation.created_at : 0;
  const registration = { id, createdAt, agentId, backend };
  conversations.set(id, registration);
  const latest = latestConversations.get(agentId);
  if (!latest || createdAt > latest.createdAt || (createdAt === latest.createdAt && id >= latest.id)) {
    latestConversations.set(agentId, registration);
  }
}

/** Replace Agent choices only from complete model frames belonging to its newest registered conversation. */
export function observeAgentModelMessage(message: IResponseMessage): void {
  if (!snapshot.scope || !message || (message.type !== 'acp_model_info' && message.type !== 'acp_config_option'))
    return;
  const registration = conversations.get(message.conversation_id);
  if (!registration || latestConversations.get(registration.agentId)?.id !== registration.id) return;
  const payload = parsePayload(message.data);
  let models: Model[] | null = null;
  if (message.type === 'acp_model_info' && isRecord(payload)) {
    models = parseModels(payload.available_models, 'id', registration.backend);
  } else if (message.type === 'acp_config_option') {
    models = parseConfigModels(payload, registration.backend);
  }
  if (!models) return;
  recordObservedModels(registration, models);
}

/** Capture OpenCode's ready session snapshot, whose initial frames can precede the turn stream. */
export function observeAgentModelRuntimeSnapshot(
  conversationId: string,
  configOptions: AcpConfigOptionDto[],
  requestScope: string | null
): void {
  if (!requestScope || requestScope !== snapshot.scope) return;
  const registration = conversations.get(conversationId);
  if (registration?.backend !== 'opencode' || latestConversations.get(registration.agentId)?.id !== registration.id)
    return;
  const models = parseConfigModels(configOptions, registration.backend);
  if (models) recordObservedModels(registration, models);
}

/** Reconcile Core write-back while retaining a newer session list until Core acknowledges it. */
export function reconcileAgentModelCatalog(agentId: string, info: AcpModelInfo): void {
  if (!snapshot.scope || !nonemptyString(agentId) || !isRecord(info)) return;
  const previous = observedCatalogs.get(agentId);
  const models = parseModels(info.available_models, 'id', previous?.backend);
  if (!models) return;
  const ids = sortedModelIds(models);
  managementModelIds.set(agentId, ids);
  if (!previous) return;

  const matchesObserved = sameModelIds(sortedModelIds(previous.modelInfo.available_models), ids);
  if (matchesObserved || !previous.baselineModelIds) {
    if (sameModelIds(previous.baselineModelIds, ids)) return;
    observedCatalogs.set(agentId, { ...previous, baselineModelIds: ids });
    persistObservedCatalogs();
    return;
  }
  if (sameModelIds(previous.baselineModelIds, ids)) return;

  const next = modelInfo(models);
  const registration = latestConversations.get(agentId) ?? previous;
  observedCatalogs.set(agentId, { ...registration, modelInfo: next, baselineModelIds: ids });
  persistObservedCatalogs();
  publish({ ...snapshot, observed: { ...snapshot.observed, [agentId]: next } });
}

/** Subscribe to account, initial-candidate, and observed-catalog changes. */
export function subscribeAgentModelCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Return a stable snapshot until the catalog visibly changes. */
export function getAgentModelCatalogSnapshot(): AgentModelCatalogSnapshot {
  return snapshot;
}
