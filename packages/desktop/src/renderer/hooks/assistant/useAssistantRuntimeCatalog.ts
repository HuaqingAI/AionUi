/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { assistantRuntimeKey, isHTHSyncedAssistant, type Assistant } from '@/common/types/agent/assistantTypes';
import type { AcpModelInfo } from '@/common/types/platform/acpTypes';
import { useManagedAgentRuntimeCatalog } from '@/renderer/hooks/agent/useManagedAgents';
import { useHthModelPricingDescriptions } from '@/renderer/hooks/agent/useHthModelPricingDescriptions';
import {
  getAgentModelCatalogSnapshot,
  reconcileAgentModelCatalog,
  subscribeAgentModelCatalog,
} from '@/renderer/services/runtime/agentModelCatalog';
import {
  buildAgentRuntimeModeState,
  buildAgentRuntimeModelInfo,
  buildAgentRuntimeSlashCommands,
  buildAgentRuntimeThoughtLevelOption,
} from '@/renderer/utils/model/agentRuntimeCatalog';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

const EMPTY_MODELS: string[] = [];

/** Build explicit assistant model choices when no runtime catalog is available. */
export function buildAssistantModelInfo(models: string[]): AcpModelInfo | null {
  if (models.length === 0) return null;
  return {
    current_model_id: models[0],
    current_model_label: models[0],
    available_models: models.map((model) => ({ id: model, label: model })),
  };
}

/** Share runtime choices across new conversations and scheduled tasks without selecting a model. */
export const useAssistantRuntimeCatalog = (assistant: Assistant | undefined) => {
  const managedAgents = useManagedAgentRuntimeCatalog();
  const catalog = useSyncExternalStore(subscribeAgentModelCatalog, getAgentModelCatalogSnapshot);
  const backend = assistantRuntimeKey(assistant);
  const assistantModels = assistant?.models ?? EMPTY_MODELS;
  const managedAgent = useMemo(
    () => (assistant?.agent_id ? managedAgents.find((agent) => agent.id === assistant.agent_id) : undefined),
    [managedAgents, assistant?.agent_id]
  );
  const managedModelInfo = useMemo(() => buildAgentRuntimeModelInfo(managedAgent, backend), [managedAgent, backend]);

  useEffect(() => {
    if (assistant?.agent_id && ['opencode', 'codex'].includes(backend) && managedModelInfo) {
      reconcileAgentModelCatalog(assistant.agent_id, managedModelInfo);
    }
  }, [assistant?.agent_id, backend, managedModelInfo, catalog.scope]);

  const runtimeModelInfo = useMemo<AcpModelInfo | null>(() => {
    const observed = assistant?.agent_id ? catalog.observed[assistant.agent_id] : undefined;
    const runtime = observed ?? managedModelInfo;
    if (runtime) return runtime;
    if (!assistant?.agent_id || !['opencode', 'codex'].includes(backend)) return null;
    if (assistantModels.length > 0 || assistant.agent?.source === 'custom') return null;
    if (catalog.initialModelIds.length === 0) return null;
    return {
      current_model_id: null,
      current_model_label: null,
      available_models: catalog.initialModelIds.map((id) => ({
        id: backend === 'opencode' ? `hth/${id}` : id,
        label: catalog.initialModelLabels[id] ?? `HTH/${id.toUpperCase()}`,
      })),
    };
  }, [catalog, assistant, assistantModels, backend, managedModelInfo]);

  const availableCommands = useMemo(() => buildAgentRuntimeSlashCommands(managedAgent), [managedAgent]);
  const modeState = useMemo(() => buildAgentRuntimeModeState(managedAgent), [managedAgent]);
  const thoughtLevelOption = useMemo(() => {
    const runtime = buildAgentRuntimeThoughtLevelOption(managedAgent, backend);
    const managedOpenCode = backend === 'opencode' && isHTHSyncedAssistant(assistant);
    if (runtime && (runtime.options.length > 0 || !managedOpenCode)) return runtime;
    if (
      !['codex', 'opencode'].includes(backend) ||
      !assistant?.agent_id ||
      assistant.agent?.source === 'custom' ||
      assistantModels.length > 0 ||
      catalog.initialModelIds.length === 0 ||
      (!managedOpenCode && (catalog.observed[assistant.agent_id] || managedModelInfo))
    ) {
      return null;
    }
    // Managed OpenCode templates advertise these levels even with an older model-only Core catalog.
    return buildAgentRuntimeThoughtLevelOption(
      {
        config_options:
          backend === 'opencode' ? catalog.initialOpenCodeConfigOptions : catalog.initialCodexConfigOptions,
      },
      backend
    );
  }, [managedAgent, backend, assistant, assistantModels, catalog, managedModelInfo]);

  const pricingModelIds = useMemo(() => {
    const models = runtimeModelInfo?.available_models ?? assistantModels.map((id) => ({ id }));
    if (backend === 'codex') return models.map((model) => model.id);
    if (backend !== 'opencode') return [];
    return models
      .filter((model) => model.id.toLowerCase().startsWith('hth/'))
      .map((model) => model.id.slice('hth/'.length));
  }, [runtimeModelInfo?.available_models, backend, assistantModels]);
  const pricingDescriptions = useHthModelPricingDescriptions(pricingModelIds);
  const modelInfo = useMemo(() => {
    const info = runtimeModelInfo ?? buildAssistantModelInfo(assistantModels);
    if (!info) return null;
    return {
      ...info,
      available_models: info.available_models.map((model) => {
        if (model.description) return model;
        const pricingModelId = model.id.toLowerCase().startsWith('hth/')
          ? model.id.slice('hth/'.length)
          : backend === 'codex'
            ? model.id
            : null;
        if (!pricingModelId) return model;
        const description = pricingDescriptions[pricingModelId];
        return description ? Object.assign({}, model, { description }) : model;
      }),
    };
  }, [pricingDescriptions, backend, assistantModels, runtimeModelInfo]);

  return { modelInfo, runtimeModelInfo, thoughtLevelOption, modeState, availableCommands };
};
