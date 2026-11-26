/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HTHRuntimeModelChoices } from '@/common/types/hth/modelReasoning';
import { useHTHRuntimeModelChoices } from '@/renderer/hooks/assistant/useHTHRuntimeModelChoices';
import { useAssistantRuntimeCatalog } from '@/renderer/hooks/assistant/useAssistantRuntimeCatalog';
import type { Assistant } from '@/common/types/agent/assistantTypes';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: {
    hth: {
      runtimeModelChoices: { invoke },
      modelPricingDescriptions: { invoke: async () => ({ descriptions: {} }) },
    },
  },
}));
vi.mock('@/renderer/hooks/agent/useManagedAgents', () => ({ useManagedAgentRuntimeCatalog: () => [] }));

const choices: HTHRuntimeModelChoices = {
  cli_type: 'codex',
  policy_revision: 'revision',
  default_model_id: 'gpt-test',
  models: [{ id: 'gpt-test', gateway_model_id: 'gpt-test', label: 'GPT', efforts: ['max'], default_effort: 'max' }],
};

beforeEach(() => invoke.mockReset());

describe('HTH model choices', () => {
  it.each(['opencode', 'codex'] as const)(
    'sorts %s preview models naturally and capitalizes effort labels without changing values or defaults',
    async (backend) => {
      const assistant = {
        id: 'manual',
        source: 'user',
        agent_id: backend,
        agent: { type: backend, source: 'builtin' },
        models: [],
      } as Assistant;
      const prefix = backend === 'opencode' ? 'hth/' : '';
      const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
      invoke.mockResolvedValue({
        cli_type: backend,
        policy_revision: 'revision',
        default_model_id: `${prefix}gpt-10`,
        models: ['gpt-10', 'GPT-2', 'gpt-1'].map((id) => ({
          id: `${prefix}${id}`,
          gateway_model_id: id,
          label: id,
          efforts,
          default_effort: id === 'gpt-10' ? 'max' : 'low',
        })),
      });
      const { result } = renderHook(() => useAssistantRuntimeCatalog(assistant));
      await waitFor(() => expect(result.current.thoughtLevelOption?.currentValue).toBe('max'));
      expect(result.current.modelInfo?.available_models.map((model) => model.id)).toEqual(
        ['gpt-1', 'GPT-2', 'gpt-10'].map((id) => `${prefix}${id}`)
      );
      expect(result.current.thoughtLevelOption?.options).toEqual([
        { value: 'none', label: 'None' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'Xhigh' },
        { value: 'max', label: 'Max' },
      ]);
    }
  );

  it('uses the gateway default model effort and changes effort choices with the selected model', async () => {
    const assistant = {
      id: 'manual',
      source: 'user',
      agent_id: 'opencode',
      agent: { type: 'opencode', source: 'builtin' },
      models: [],
    } as Assistant;
    invoke.mockResolvedValue({
      cli_type: 'opencode',
      policy_revision: 'revision',
      default_model_id: 'hth/gpt-test',
      models: [
        {
          id: 'hth/deepseek-chat',
          gateway_model_id: 'deepseek-chat',
          label: 'DeepSeek',
          efforts: ['none'],
          default_effort: 'none',
        },
        { id: 'hth/gpt-test', gateway_model_id: 'gpt-test', label: 'GPT', efforts: ['max'], default_effort: 'max' },
      ],
    });
    const { result, rerender } = renderHook(
      ({ selectedModel }) => useAssistantRuntimeCatalog(assistant, selectedModel),
      { initialProps: { selectedModel: null as string | null } }
    );
    await waitFor(() => expect(result.current.thoughtLevelOption?.currentValue).toBe('max'));
    rerender({ selectedModel: 'hth/deepseek-chat' });
    expect(result.current.thoughtLevelOption?.options.map((option) => option.value)).toEqual(['none']);
  });

  it('keeps a native generated Codex assistant outside the HTH model restrictions', () => {
    const assistant = {
      id: 'native',
      source: 'generated',
      agent_id: 'codex',
      agent: { type: 'codex', source: 'builtin' },
      models: ['gpt-10', 'o3', 'gpt-2'],
    } as Assistant;
    const { result } = renderHook(() => useAssistantRuntimeCatalog(assistant));
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.modelInfo?.available_models.map((model) => model.id)).toEqual(['gpt-10', 'o3', 'gpt-2']);
  });

  it('does not request HTH configuration for an unmanaged assistant', () => {
    const { result } = renderHook(() => useHTHRuntimeModelChoices('native', 'account', false));
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('returns model-specific choices and allows retrying an unavailable policy', async () => {
    invoke.mockRejectedValueOnce(new Error('reasoningPolicyUnavailable')).mockResolvedValueOnce(choices);
    const { result } = renderHook(() => useHTHRuntimeModelChoices('assistant', 'account', true));
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.choices).toEqual(choices);
    expect(result.current.error).toBeUndefined();
  });

  it('rejects an outstanding save preview after the account changes', async () => {
    invoke.mockResolvedValueOnce(choices);
    const { result, rerender } = renderHook(({ scope }) => useHTHRuntimeModelChoices('assistant', scope, true), {
      initialProps: { scope: 'first-account' },
    });
    await waitFor(() => expect(result.current.choices).toEqual(choices));
    let complete!: (value: HTHRuntimeModelChoices) => void;
    invoke.mockReturnValueOnce(
      new Promise<HTHRuntimeModelChoices>((resolve) => {
        complete = resolve;
      })
    );
    let saving!: Promise<HTHRuntimeModelChoices>;
    act(() => {
      saving = result.current.refresh();
    });
    const rejected = expect(saving).rejects.toThrow('reasoningPolicyUnavailable');
    invoke.mockResolvedValueOnce({ ...choices, models: [] });
    rerender({ scope: 'second-account' });
    await act(async () => {
      complete(choices);
      await rejected;
    });
    await waitFor(() => expect(result.current.choices?.models).toEqual([]));
  });
});
