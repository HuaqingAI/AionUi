/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { assistantRuntimeKey, isAionrsAssistant, type Assistant } from '@/common/types/agent/assistantTypes';
import { configService } from '@/common/config/configService';
import { HTH_DEFAULT_MODEL } from '@/common/config/constants';
import type { AcpModelInfo } from '../types';
import type { AgentModeOption } from '@/renderer/utils/model/agentTypes';
import {
  buildAgentRuntimeModeState,
  buildAgentRuntimeModelInfo,
  buildAgentRuntimeSlashCommands,
  type AgentRuntimeCatalog,
  type AgentRuntimeDerivedOption,
} from '@/renderer/utils/model/agentRuntimeCatalog';
import type { SlashCommandItem } from '@/common/chat/slash/types';
import { useAssistantRuntimeCatalog } from '@/renderer/hooks/assistant/useAssistantRuntimeCatalog';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCustomAgentsLoader } from './useCustomAgentsLoader';
import { resolveGuidThoughtLevelDefault } from '../utils/assistantDefaults';

export {
  buildAgentRuntimeModeState,
  buildAgentRuntimeModelInfo,
  buildAgentRuntimeSlashCommands,
  type AgentRuntimeCatalog,
};

export { buildAssistantModelInfo } from '@/renderer/hooks/assistant/useAssistantRuntimeCatalog';

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
  const {
    modelInfo: currentAcpCachedModelInfo,
    runtimeModelInfo: selectedAgentRuntimeModelInfo,
    thoughtLevelOption: selectedAgentRuntimeThoughtLevelOption,
    modeState: selectedAgentRuntimeModeState,
    availableCommands: currentAgentAvailableCommands,
  } = useAssistantRuntimeCatalog(selectedAssistant);
  const currentThoughtLevelOption = useMemo<AgentRuntimeDerivedOption | null>(() => {
    if (!selectedAgentRuntimeThoughtLevelOption) return null;
    return {
      ...selectedAgentRuntimeThoughtLevelOption,
      currentValue: selectedThoughtLevelValue || selectedAgentRuntimeThoughtLevelOption.currentValue,
    };
  }, [selectedAgentRuntimeThoughtLevelOption, selectedThoughtLevelValue]);
  const currentAgentModeOptions = selectedAgentRuntimeModeState.options;

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
