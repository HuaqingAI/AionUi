/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { AcpConfigOptionDto, AcpModelInfo } from '@/common/types/platform/acpTypes';
import { useHthModelPricingDescriptions } from './useHthModelPricingDescriptions';
import {
  type AcpConfigOptionsLoader,
  type AcpConfigSetStatus,
  type AcpDerivedOption,
  useAcpConfigOptions,
} from './useAcpConfigOptions';
import { filterOpenCodeModels, isOpenCodeRuntime } from '@/renderer/utils/model/agentRuntimeCatalog';
import { useCallback, useEffect, useMemo, useState } from 'react';

type UseAcpModelInfoArgs = {
  conversation_id: string;
  backend?: string;
  initialModelId?: string;
  prepareRuntime?: () => Promise<void>;
  prepareSetRuntime?: () => Promise<void>;
  loadConfigOptions?: AcpConfigOptionsLoader;
  enabled?: boolean;
  onSelectModelSuccess?: (model_id: string) => void;
  onSelectModelFailed?: (model_id: string, error: unknown) => void;
};

export type UseAcpModelInfoResult = {
  model_info: AcpModelInfo | null;
  canSwitch: boolean;
  isLoading: boolean;
  isSetting: boolean;
  selectModel: (model_id: string) => void;
  thoughtLevel: AcpDerivedOption | null;
  setStatus: AcpConfigSetStatus;
  setConfigOption: (optionId: string, value: string) => Promise<AcpConfigOptionDto[]>;
};

function sameModelInfo(a: AcpModelInfo | null, b: AcpModelInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.current_model_id === b.current_model_id &&
    a.current_model_label === b.current_model_label &&
    a.available_models.length === b.available_models.length &&
    a.available_models.every((item, index) => {
      const other = b.available_models[index];
      return other?.id === item.id && other.label === item.label && other.description === item.description;
    })
  );
}

function normalizeInitialModel(info: AcpModelInfo, initialModelId?: string): AcpModelInfo {
  if (!initialModelId || info.current_model_id) return info;
  const match = info.available_models.find((model) => model.id === initialModelId);
  if (!match) return info;
  return {
    ...info,
    current_model_id: initialModelId,
    current_model_label: match.label || initialModelId,
  };
}

export const useAcpModelInfo = ({
  conversation_id,
  backend,
  initialModelId,
  prepareRuntime,
  prepareSetRuntime,
  loadConfigOptions,
  enabled = true,
  onSelectModelSuccess,
  onSelectModelFailed,
}: UseAcpModelInfoArgs): UseAcpModelInfoResult => {
  const { model, thoughtLevel, setStatus, setConfigOption, isLoading } = useAcpConfigOptions({
    conversation_id,
    prepareRuntime,
    prepareSetRuntime,
    loadConfigOptions,
    enabled,
  });
  const [legacyModelInfo, setLegacyModelInfo] = useState<AcpModelInfo | null>(null);
  const hthModelIds = useMemo(
    () =>
      backend === 'opencode'
        ? (model?.options
            .filter((item) => item.value.startsWith('hth/'))
            .map((item) => item.value.slice('hth/'.length)) ?? [])
        : [],
    [backend, model]
  );
  const hthPricingDescriptions = useHthModelPricingDescriptions(hthModelIds, backend === 'opencode');

  const configModelInfo = useMemo<AcpModelInfo | null>(() => {
    if (!model) return null;
    const availableOptions = filterOpenCodeModels(model.options, backend);
    const requestedCurrentModelId = model.currentValue || initialModelId || null;
    const currentModelId = availableOptions.some((item) => item.value === requestedCurrentModelId)
      ? requestedCurrentModelId
      : (availableOptions[0]?.value ?? null);
    return {
      current_model_id: currentModelId,
      current_model_label:
        availableOptions.find((item) => item.value === currentModelId)?.label || currentModelId || null,
      available_models: availableOptions.map((item) => ({
        id: item.value,
        label: item.label,
        description:
          item.description ??
          (item.value.startsWith('hth/') ? hthPricingDescriptions[item.value.slice('hth/'.length)] : undefined),
      })),
    };
  }, [backend, hthPricingDescriptions, initialModelId, model]);
  const persistedModelInfo = useMemo<AcpModelInfo | null>(() => {
    if (!initialModelId) return null;
    return {
      current_model_id: initialModelId,
      current_model_label: initialModelId,
      available_models: [],
    };
  }, [initialModelId]);

  useEffect(() => {
    if (!enabled) {
      setLegacyModelInfo(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const handler = (message: IResponseMessage) => {
      if (message.conversation_id !== conversation_id) return;
      if (message.type === 'acp_model_info' && message.data) {
        const incoming = normalizeInitialModel(message.data as AcpModelInfo, initialModelId);
        const available_models = filterOpenCodeModels(incoming.available_models, backend);
        const isOpenCode = isOpenCodeRuntime(backend);
        const selectedModel = isOpenCode
          ? (available_models.find((candidate) => candidate.id === incoming.current_model_id) ?? available_models[0])
          : undefined;
        const filteredIncoming = {
          ...incoming,
          current_model_id: isOpenCode ? (selectedModel?.id ?? null) : incoming.current_model_id,
          current_model_label: isOpenCode ? (selectedModel?.label ?? null) : incoming.current_model_label,
          available_models,
        };
        setLegacyModelInfo((previous) => (sameModelInfo(previous, filteredIncoming) ? previous : filteredIncoming));
      } else if (message.type === 'codex_model_info' && message.data) {
        const data = message.data as { model?: string };
        if (!data.model) return;
        const incoming: AcpModelInfo = {
          current_model_id: data.model,
          current_model_label: data.model,
          available_models: [],
        };
        setLegacyModelInfo((previous) => (sameModelInfo(previous, incoming) ? previous : incoming));
      }
    };
    return ipcBridge.acpConversation.responseStream.on(handler);
  }, [backend, conversation_id, enabled, initialModelId]);

  const model_info = configModelInfo ?? legacyModelInfo ?? persistedModelInfo;

  const selectModel = useCallback(
    (model_id: string) => {
      if (!enabled || !model) return;
      void setConfigOption(model.id, model_id)
        .then(async () => {
          onSelectModelSuccess?.(model_id);
        })
        .catch((error) => {
          onSelectModelFailed?.(model_id, error);
        });
    },
    [enabled, model, onSelectModelFailed, onSelectModelSuccess, setConfigOption]
  );

  return {
    model_info,
    canSwitch: Boolean(configModelInfo && configModelInfo.available_models.length > 0),
    isLoading: !model_info && isLoading,
    isSetting: setStatus.state === 'setting' && setStatus.optionId === model?.id,
    selectModel,
    thoughtLevel,
    setStatus,
    setConfigOption,
  };
};
