/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  assistantRuntimeKey,
  isAionrsAssistant,
  isHTHSyncedAssistant,
  type Assistant,
} from '@/common/types/agent/assistantTypes';
import { configService } from '@/common/config/configService';
import { HTH_DEFAULT_MODEL } from '@/common/config/constants';
import type { AcpModelInfo } from '../types';
import type { AgentModeOption } from '@/renderer/utils/model/agentTypes';
import {
  buildAgentRuntimeModeState,
  buildAgentRuntimeModelInfo,
  buildAgentRuntimeSlashCommands,
  buildAgentRuntimeThoughtLevelOption,
  type AgentRuntimeCatalog,
  type AgentRuntimeDerivedOption,
} from '@/renderer/utils/model/agentRuntimeCatalog';
import type { SlashCommandItem } from '@/common/chat/slash/types';
import { useManagedAgentRuntimeCatalog } from '@/renderer/hooks/agent/useManagedAgents';
import { useHthModelPricingDescriptions } from '@/renderer/hooks/agent/useHthModelPricingDescriptions';
import {
  getAgentModelCatalogSnapshot,
  reconcileAgentModelCatalog,
  subscribeAgentModelCatalog,
} from '@/renderer/services/runtime/agentModelCatalog';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useCustomAgentsLoader } from './useCustomAgentsLoader';
import { resolveGuidThoughtLevelDefault } from '../utils/assistantDefaults';

export {
  buildAgentRuntimeModeState,
  buildAgentRuntimeModelInfo,
  buildAgentRuntimeSlashCommands,
  type AgentRuntimeCatalog,
};

export type GuidAssistantSelectionResult = {
  selectedAssistantId: string | null;
  setSelectedAssistantId: (assistantId: string) => void;
  defaultAssistantId: string | null;
  selectedAssistant: Assistant | undefined;
  selectedAssistantBackend: string;
  selectedAssistantAvailable: boolean;
  assistants: Assistant[];
  selectedMode: string;
  setSelectedMode: (mode: React.SetStateAction<string>, options?: { persistPreference?: boolean }) => void;
  selectedAcpModel: string | null;
  setSelectedAcpModel: (model: React.SetStateAction<string | null>, options?: { persistPreference?: boolean }) => void;
  currentAcpCachedModelInfo: AcpModelInfo | null;
  currentAgentAvailableCommands: SlashCommandItem[];
  currentAgentModeOptions: AgentModeOption[];
  currentThoughtLevelOption: AgentRuntimeDerivedOption | null;
  selectedThoughtLevelValue: string;
  setSelectedThoughtLevelValue: (
    value: React.SetStateAction<string>,
    options?: { persistPreference?: boolean }
  ) => void;
};

export function resolveInitialAssistantModel(models: string[]): string | null {
  if (models.length > 0) {
    return models[0];
  }

  return null;
}

export function buildAssistantModelInfo(models: string[]): AcpModelInfo | null {
  if (models.length > 0) {
    return {
      current_model_id: models[0],
      current_model_label: models[0],
      available_models: models.map((model) => ({ id: model, label: model })),
    } satisfies AcpModelInfo;
  }

  return null;
}

export function resolveAssistantSelectionKey(
  savedKey: string | undefined,
  assistants: Assistant[]
): string | undefined {
  if (!savedKey) return undefined;

  if (savedKey.startsWith('custom:')) {
    const assistantId = savedKey.slice(7);
    return assistants.some((assistant) => assistant.id === assistantId) ? assistantId : undefined;
  }

  if (assistants.some((assistant) => assistant.id === savedKey)) {
    return savedKey;
  }

  return undefined;
}

function readPersistedGuidAssistantSelectionKey(assistants: Assistant[]): string | undefined {
  const savedKey = configService.get('guid.lastAssistantId');
  const enabledAssistants = assistants.filter((assistant) => assistant.enabled !== false);
  return resolveAssistantSelectionKey(savedKey, enabledAssistants);
}

function persistGuidAssistantSelectionKey(assistantId: string): void {
  void configService.set('guid.lastAssistantId', assistantId).catch((error) => {
    console.error('[Guid] Failed to persist selected assistant:', error);
  });
}

export function pickDefaultAssistantSelectionKey(assistants: Assistant[]): string | null {
  const enabledAssistants = assistants.filter((assistant) => assistant.enabled !== false);
  const preferred =
    enabledAssistants.find((assistant) => assistant.source === 'generated' && isAionrsAssistant(assistant)) ??
    enabledAssistants.find((assistant) => isAionrsAssistant(assistant)) ??
    enabledAssistants[0];
  return preferred?.id ?? null;
}

type UseGuidAssistantSelectionOptions = {
  resetAssistant?: boolean;
  preselectAssistantId?: string;
  locationKey?: string;
};

export const useGuidAssistantSelection = ({
  resetAssistant,
  preselectAssistantId,
  locationKey,
}: UseGuidAssistantSelectionOptions): GuidAssistantSelectionResult => {
  const [selectedAssistantIdState, _setSelectedAssistantId] = useState<string | null>(null);
  const [selectedMode, _setSelectedMode] = useState<string>('default');
  const [selectedAcpModel, _setSelectedAcpModel] = useState<string | null>(null);
  const [selectedThoughtLevelValue, _setSelectedThoughtLevelValue] = useState<string>('');
  const { assistants } = useCustomAgentsLoader();
  const managedAgentRuntimeCatalog = useManagedAgentRuntimeCatalog();
  const modelCatalog = useSyncExternalStore(subscribeAgentModelCatalog, getAgentModelCatalogSnapshot);

  const setSelectedMode = useCallback(
    (mode: React.SetStateAction<string>, _options?: { persistPreference?: boolean }) => {
      _setSelectedMode((prev) => {
        const nextMode = typeof mode === 'function' ? mode(prev) : mode;
        return nextMode;
      });
    },
    []
  );

  const setSelectedAcpModel = useCallback(
    (modelId: React.SetStateAction<string | null>, _options?: { persistPreference?: boolean }) => {
      _setSelectedAcpModel((prev) => {
        const nextModelId = typeof modelId === 'function' ? modelId(prev) : modelId;
        return nextModelId;
      });
    },
    []
  );

  const setSelectedThoughtLevelValue = useCallback(
    (value: React.SetStateAction<string>, _options?: { persistPreference?: boolean }) => {
      _setSelectedThoughtLevelValue((prev) => {
        const nextValue = typeof value === 'function' ? value(prev) : value;
        return nextValue;
      });
    },
    []
  );

  const setSelectedAssistantId = useCallback(
    (assistantId: string) => {
      const normalizedId = resolveAssistantSelectionKey(assistantId, assistants) ?? assistantId;
      _setSelectedAssistantId(normalizedId);
      persistGuidAssistantSelectionKey(normalizedId);
    },
    [assistants]
  );

  const resetHandledRef = useRef(false);
  const prevLocationKeyRef = useRef(locationKey);
  if (locationKey !== prevLocationKeyRef.current) {
    prevLocationKeyRef.current = locationKey;
    resetHandledRef.current = false;
  }

  useLayoutEffect(() => {
    if (assistants.length === 0) return;
    if (resetHandledRef.current) return;

    if (preselectAssistantId) {
      const resolvedPreselect = resolveAssistantSelectionKey(preselectAssistantId, assistants);
      if (resolvedPreselect) {
        resetHandledRef.current = true;
        _setSelectedAssistantId(resolvedPreselect);
        return;
      }
    }

    if (resetAssistant) {
      resetHandledRef.current = true;
      const fallbackId =
        readPersistedGuidAssistantSelectionKey(assistants) ?? pickDefaultAssistantSelectionKey(assistants);
      _setSelectedAssistantId(fallbackId);
    }
  }, [assistants, preselectAssistantId, resetAssistant]);

  useEffect(() => {
    if (assistants.length === 0) return;
    if (resetAssistant) return;
    if (preselectAssistantId && resolveAssistantSelectionKey(preselectAssistantId, assistants)) return;
    if (!selectedAssistantIdState || !assistants.some((assistant) => assistant.id === selectedAssistantIdState)) {
      _setSelectedAssistantId(
        readPersistedGuidAssistantSelectionKey(assistants) ?? pickDefaultAssistantSelectionKey(assistants)
      );
    }
  }, [assistants, preselectAssistantId, resetAssistant, selectedAssistantIdState]);

  const selectedAssistant = useMemo(
    () =>
      selectedAssistantIdState ? assistants.find((assistant) => assistant.id === selectedAssistantIdState) : undefined,
    [assistants, selectedAssistantIdState]
  );
  const selectedAssistantId = selectedAssistant?.id ?? null;
  const selectedAssistantBackend = assistantRuntimeKey(selectedAssistant);
  const selectedAssistantModels = selectedAssistant?.models ?? [];
  const selectedManagedAgentRuntimeCatalog = useMemo(
    () =>
      selectedAssistant?.agent_id
        ? managedAgentRuntimeCatalog.find((agent) => agent.id === selectedAssistant.agent_id)
        : undefined,
    [managedAgentRuntimeCatalog, selectedAssistant?.agent_id]
  );
  const managedModelInfo = useMemo(
    () => buildAgentRuntimeModelInfo(selectedManagedAgentRuntimeCatalog, selectedAssistantBackend),
    [selectedManagedAgentRuntimeCatalog, selectedAssistantBackend]
  );
  useEffect(() => {
    if (selectedAssistant?.agent_id && ['opencode', 'codex'].includes(selectedAssistantBackend) && managedModelInfo) {
      reconcileAgentModelCatalog(selectedAssistant.agent_id, managedModelInfo);
    }
  }, [selectedAssistant?.agent_id, selectedAssistantBackend, managedModelInfo, modelCatalog.scope]);
  const selectedAgentRuntimeModelInfo = useMemo<AcpModelInfo | null>(() => {
    const observed = selectedAssistant?.agent_id ? modelCatalog.observed[selectedAssistant.agent_id] : undefined;
    const runtime = observed ?? managedModelInfo;
    if (runtime) return runtime;
    if (!selectedAssistant?.agent_id || !['opencode', 'codex'].includes(selectedAssistantBackend)) return null;
    if (selectedAssistantModels.length > 0 || selectedAssistant.agent?.source === 'custom') return null;
    if (modelCatalog.initialModelIds.length === 0) return null;
    return {
      current_model_id: null,
      current_model_label: null,
      available_models: modelCatalog.initialModelIds.map((id) => ({
        id: selectedAssistantBackend === 'opencode' ? `hth/${id}` : id,
        label: modelCatalog.initialModelLabels[id] ?? `HTH/${id.toUpperCase()}`,
      })),
    } satisfies AcpModelInfo;
  }, [modelCatalog, selectedAssistant, selectedAssistantModels, selectedAssistantBackend, managedModelInfo]);
  const currentAgentAvailableCommands = useMemo(
    () => buildAgentRuntimeSlashCommands(selectedManagedAgentRuntimeCatalog),
    [selectedManagedAgentRuntimeCatalog]
  );
  const selectedAgentRuntimeModeState = useMemo(
    () => buildAgentRuntimeModeState(selectedManagedAgentRuntimeCatalog),
    [selectedManagedAgentRuntimeCatalog]
  );
  const selectedAgentRuntimeThoughtLevelOption = useMemo(() => {
    const runtime = buildAgentRuntimeThoughtLevelOption(selectedManagedAgentRuntimeCatalog);
    const managedOpenCode = selectedAssistantBackend === 'opencode' && isHTHSyncedAssistant(selectedAssistant);
    if (runtime && (runtime.options.length > 0 || !managedOpenCode)) return runtime;
    if (
      !['codex', 'opencode'].includes(selectedAssistantBackend) ||
      !selectedAssistant?.agent_id ||
      selectedAssistant.agent?.source === 'custom' ||
      selectedAssistantModels.length > 0 ||
      modelCatalog.initialModelIds.length === 0 ||
      (!managedOpenCode && (modelCatalog.observed[selectedAssistant.agent_id] || managedModelInfo))
    ) {
      return null;
    }
    // Managed OpenCode templates advertise these levels even if Core still has an older model-only catalog.
    return buildAgentRuntimeThoughtLevelOption({
      config_options:
        selectedAssistantBackend === 'opencode'
          ? modelCatalog.initialOpenCodeConfigOptions
          : modelCatalog.initialCodexConfigOptions,
    });
  }, [
    selectedManagedAgentRuntimeCatalog,
    selectedAssistantBackend,
    selectedAssistant,
    selectedAssistantModels,
    modelCatalog,
    managedModelInfo,
  ]);
  const currentThoughtLevelOption = useMemo<AgentRuntimeDerivedOption | null>(() => {
    if (!selectedAgentRuntimeThoughtLevelOption) return null;
    return {
      ...selectedAgentRuntimeThoughtLevelOption,
      currentValue: selectedThoughtLevelValue || selectedAgentRuntimeThoughtLevelOption.currentValue,
    };
  }, [selectedAgentRuntimeThoughtLevelOption, selectedThoughtLevelValue]);
  const currentAgentModeOptions = selectedAgentRuntimeModeState.options;

  const pricingModelIds = useMemo(() => {
    const models = selectedAgentRuntimeModelInfo?.available_models ?? selectedAssistantModels.map((id) => ({ id }));
    if (selectedAssistantBackend === 'codex') return models.map((model) => model.id);
    if (selectedAssistantBackend !== 'opencode') return [];
    return models
      .filter((model) => model.id.toLowerCase().startsWith('hth/'))
      .map((model) => model.id.slice('hth/'.length));
  }, [selectedAgentRuntimeModelInfo?.available_models, selectedAssistantBackend, selectedAssistantModels]);
  const hthPricingDescriptions = useHthModelPricingDescriptions(pricingModelIds);

  const selectedAssistantAvailable = useMemo(() => {
    return selectedAssistant?.agent_status === 'online';
  }, [selectedAssistant]);

  const modelSelectionScopeRef = useRef<string | null>(null);
  useEffect(() => {
    // A runtime's current model belongs to its last session, so it must not become
    // the default for a new one. Managed HTH runtimes have an explicit product default.
    const availableModelIds = new Set(
      selectedAgentRuntimeModelInfo?.available_models.map((model) => model.id) ?? selectedAssistantModels
    );
    const managedDefaultModelId =
      selectedAssistantBackend === 'opencode' ? `hth/${HTH_DEFAULT_MODEL}` : HTH_DEFAULT_MODEL;
    const useManagedDefault =
      ['codex', 'opencode'].includes(selectedAssistantBackend) &&
      selectedAssistant?.agent?.source !== 'custom' &&
      selectedAssistantModels.length === 0 &&
      availableModelIds.has(managedDefaultModelId);
    const fallbackModelId = useManagedDefault
      ? managedDefaultModelId
      : selectedAgentRuntimeModelInfo
        ? null
        : resolveInitialAssistantModel(selectedAssistantModels);
    const selectionScope = selectedAssistantId ?? '';

    _setSelectedAcpModel((previousModelId) => {
      const scopeChanged = modelSelectionScopeRef.current !== selectionScope;
      modelSelectionScopeRef.current = selectionScope;

      if (
        !scopeChanged &&
        previousModelId &&
        (availableModelIds.size === 0 || availableModelIds.has(previousModelId))
      ) {
        return previousModelId;
      }

      return fallbackModelId;
    });
  }, [
    selectedAssistantId,
    selectedAssistant?.agent?.source,
    selectedAssistantBackend,
    selectedAssistantModels,
    selectedAgentRuntimeModelInfo,
  ]);

  useEffect(() => {
    const fallbackMode =
      selectedAgentRuntimeModeState.currentMode || selectedAgentRuntimeModeState.options[0]?.value || 'default';
    _setSelectedMode(fallbackMode);
  }, [selectedAgentRuntimeModeState]);

  const thoughtLevelSelectionScopeRef = useRef<string | null>(null);
  useEffect(() => {
    const optionValues = new Set(selectedAgentRuntimeThoughtLevelOption?.options.map((option) => option.value) ?? []);
    const fallbackThoughtLevel = resolveGuidThoughtLevelDefault(
      selectedAssistant,
      selectedAgentRuntimeThoughtLevelOption
    );
    const selectionScope = selectedAssistantId ?? '';

    _setSelectedThoughtLevelValue((previousValue) => {
      const scopeChanged = thoughtLevelSelectionScopeRef.current !== selectionScope;
      thoughtLevelSelectionScopeRef.current = selectionScope;

      if (!selectedAgentRuntimeThoughtLevelOption) {
        return '';
      }

      if (!scopeChanged && previousValue && optionValues.has(previousValue)) {
        return previousValue;
      }

      return fallbackThoughtLevel;
    });
  }, [selectedAgentRuntimeThoughtLevelOption, selectedAssistant, selectedAssistantId]);

  const currentAcpCachedModelInfo = useMemo(() => {
    const modelInfo = selectedAgentRuntimeModelInfo ?? buildAssistantModelInfo(selectedAssistantModels);
    if (!modelInfo) return null;

    return {
      ...modelInfo,
      available_models: modelInfo.available_models.map((model) => {
        if (model.description) return model;
        const pricingModelId = model.id.toLowerCase().startsWith('hth/')
          ? model.id.slice('hth/'.length)
          : selectedAssistantBackend === 'codex'
            ? model.id
            : null;
        if (!pricingModelId) return model;
        const description = hthPricingDescriptions[pricingModelId];
        return description ? Object.assign({}, model, { description }) : model;
      }),
    };
  }, [hthPricingDescriptions, selectedAssistantBackend, selectedAssistantModels, selectedAgentRuntimeModelInfo]);

  const defaultAssistantId = useMemo(() => pickDefaultAssistantSelectionKey(assistants), [assistants]);

  return {
    selectedAssistantId,
    setSelectedAssistantId,
    defaultAssistantId,
    selectedAssistant,
    selectedAssistantBackend,
    selectedAssistantAvailable,
    assistants,
    selectedMode,
    setSelectedMode,
    selectedAcpModel,
    setSelectedAcpModel,
    currentAcpCachedModelInfo,
    currentAgentAvailableCommands,
    currentAgentModeOptions,
    currentThoughtLevelOption,
    selectedThoughtLevelValue,
    setSelectedThoughtLevelValue,
  };
};
