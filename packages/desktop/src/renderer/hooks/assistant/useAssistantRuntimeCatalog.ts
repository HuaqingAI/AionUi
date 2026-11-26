/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { assistantRuntimeKey, usesHTHModelCatalog, type Assistant } from '@/common/types/agent/assistantTypes';
import { detectModelFamily } from '@/common/types/hth/modelReasoning';
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
  formatThoughtLevelLabel,
  type AgentRuntimeDerivedOption,
} from '@/renderer/utils/model/agentRuntimeCatalog';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useHTHRuntimeModelChoices } from './useHTHRuntimeModelChoices';

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
export const useAssistantRuntimeCatalog = (
  assistant: Assistant | undefined,
  selectedModelId?: string | null,
  enabled = true
) => {
  const managedAgents = useManagedAgentRuntimeCatalog();
  const catalog = useSyncExternalStore(subscribeAgentModelCatalog, getAgentModelCatalogSnapshot);
  const backend = assistantRuntimeKey(assistant);
  const usesHTHModels = usesHTHModelCatalog(assistant);
  const modelChoices = useHTHRuntimeModelChoices(assistant?.id, catalog.scope, enabled && usesHTHModels);
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
    if (modelChoices.choices) {
      return {
        current_model_id: null,
        current_model_label: null,
        available_models: modelChoices.choices.models.map((model) => ({ id: model.id, label: model.label })),
      };
    }
    const observed = assistant?.agent_id ? catalog.observed[assistant.agent_id] : undefined;
    const runtime = observed ?? managedModelInfo;
    if (runtime) {
      if (backend !== 'codex' || !usesHTHModels) return runtime;
      const available_models = runtime.available_models.filter((model) => detectModelFamily(model.id) === 'gpt');
      return { ...runtime, available_models };
    }
    if (!assistant?.agent_id || !['opencode', 'codex'].includes(backend)) return null;
    if (assistantModels.length > 0 || assistant.agent?.source === 'custom') return null;
    const modelIds = backend === 'codex' && usesHTHModels ? catalog.initialCodexModelIds : catalog.initialModelIds;
    if (modelIds.length === 0) return null;
    return {
      current_model_id: null,
      current_model_label: null,
      available_models: modelIds.map((id) => ({
        id: backend === 'opencode' ? `hth/${id}` : id,
        label: catalog.initialModelLabels[id] ?? `HTH/${id.toUpperCase()}`,
      })),
    };
  }, [catalog, assistant, assistantModels, backend, managedModelInfo, modelChoices.choices, usesHTHModels]);

  const availableCommands = useMemo(() => buildAgentRuntimeSlashCommands(managedAgent), [managedAgent]);
  const modeState = useMemo(() => buildAgentRuntimeModeState(managedAgent), [managedAgent]);
  const thoughtLevelOption = useMemo<AgentRuntimeDerivedOption | null>(() => {
    if (!usesHTHModels) return buildAgentRuntimeThoughtLevelOption(managedAgent, backend);
    const choices = modelChoices.choices?.models;
    if (!choices) return null;
    const defaultId = modelChoices.choices?.default_model_id;
    const model = selectedModelId
      ? choices.find((choice) => choice.id === selectedModelId)
      : (choices.find((choice) => choice.id === defaultId) ?? choices[0]);
    if (!model) return null;
    return {
      id: backend === 'opencode' ? 'effort' : 'reasoning_effort',
      category: 'thought_level',
      currentValue: model.default_effort,
      options: model.efforts.map((effort) => ({
        value: effort,
        label: formatThoughtLevelLabel(effort, effort, backend),
      })),
    };
  }, [managedAgent, backend, usesHTHModels, modelChoices.choices, selectedModelId]);

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
    let info = runtimeModelInfo ?? buildAssistantModelInfo(assistantModels);
    if (!info) return null;
    if (backend === 'codex' && usesHTHModels) {
      const available_models = info.available_models.filter((model) => detectModelFamily(model.id) === 'gpt');
      info = { ...info, available_models };
    }
    const available_models = info.available_models.map((model) => {
      if (model.description) return model;
      const pricingModelId = model.id.toLowerCase().startsWith('hth/')
        ? model.id.slice('hth/'.length)
        : backend === 'codex'
          ? model.id
          : null;
      if (!pricingModelId) return model;
      const description = pricingDescriptions[pricingModelId];
      return description ? Object.assign({}, model, { description }) : model;
    });
    if (usesHTHModels) {
      available_models.sort((left, right) =>
        left.id.localeCompare(right.id, 'en', { numeric: true, sensitivity: 'base' })
      );
    }
    return { ...info, available_models };
  }, [pricingDescriptions, backend, assistantModels, runtimeModelInfo, usesHTHModels]);

  return {
    modelInfo,
    runtimeModelInfo,
    thoughtLevelOption,
    modeState,
    availableCommands,
    modelChoices: modelChoices.choices,
    choicesLoading: modelChoices.loading,
    choicesError: modelChoices.error,
    refreshModelChoices: modelChoices.refresh,
  };
};
