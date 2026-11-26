/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICronAgentConfigWrite } from '@/common/adapter/ipcBridge';
import { isAionrsAssistant, type Assistant } from '@/common/types/agent/assistantTypes';
import { resolveAssistantName } from '@renderer/utils/model/assistantDisplay';
import type { HTHRuntimeModelChoices } from '@/common/types/hth/modelReasoning';

type SelectedAionrsProvider = {
  id?: string;
  name?: string;
};

type ResolveCronAgentConfigInput = {
  agentValue: string;
  presetAssistants: Assistant[];
  selectedAionrsProvider?: SelectedAionrsProvider;
  model_id?: string;
  config_options?: Record<string, string>;
  modelChoices?: HTHRuntimeModelChoices;
  workspace?: string;
  localeKey?: string;
  getMode: (assistant: Assistant) => string | undefined;
  aionrsModelRequiredMessage: string;
};

type ResolveCronAgentConfigResult = {
  agent_config: ICronAgentConfigWrite | undefined;
};

export function resolveCronAgentConfig(input: ResolveCronAgentConfigInput): ResolveCronAgentConfigResult {
  const {
    agentValue,
    presetAssistants,
    selectedAionrsProvider,
    model_id,
    config_options,
    workspace,
    localeKey = 'en-US',
    getMode,
    aionrsModelRequiredMessage,
  } = input;

  const colonIdx = agentValue.indexOf(':');
  const prefixedId = colonIdx >= 0 ? agentValue.substring(colonIdx + 1) : agentValue;
  const assistantSelection = presetAssistants.find((item) => item.id === prefixedId || item.id === agentValue);
  if (!assistantSelection) {
    throw new Error('assistant_id is required');
  }

  let agent_config: ICronAgentConfigWrite | undefined;

  const assistant = assistantSelection;
  const assistantName = resolveAssistantName(assistant, localeKey, assistant.name);
  const mode = getMode(assistant);

  if (isAionrsAssistant(assistant)) {
    if (!selectedAionrsProvider?.id || !model_id) {
      throw new Error(aionrsModelRequiredMessage);
    }
    agent_config = {
      name: assistantName,
      assistant_id: assistant.id,
      mode,
      model_id,
      model: {
        provider_id: selectedAionrsProvider.id,
        model: model_id,
        use_model: model_id,
      },
      config_options,
      workspace,
    };
  } else {
    let configOptions = config_options;
    if (input.modelChoices) {
      const selectedModel = input.modelChoices.models.find(
        (model) => model.id === (model_id || input.modelChoices?.default_model_id)
      );
      if (!selectedModel) throw new Error('cronModelUnavailable');
      const effort = config_options?.thought_level ?? config_options?.reasoning_effort ?? config_options?.effort;
      if (effort !== undefined && !selectedModel.efforts.some((value) => value === effort)) {
        throw new Error('cronReasoningEffortUnavailable');
      }
      if (config_options) {
        const {
          thought_level: _thoughtLevel,
          reasoning_effort: _reasoningEffort,
          effort: _effort,
          ...otherOptions
        } = config_options;
        configOptions = effort === undefined ? otherOptions : { ...otherOptions, thought_level: effort };
      }
    }
    agent_config = {
      name: assistantName,
      assistant_id: assistant.id,
      mode,
      model_id,
      config_options: configOptions,
      workspace,
    };
  }

  return { agent_config };
}
