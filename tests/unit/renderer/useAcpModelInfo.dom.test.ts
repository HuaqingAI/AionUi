/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { AcpConfigOptionDto, AcpModelInfo } from '@/common/types/platform/acpTypes';
import { useAcpModelInfo } from '@/renderer/hooks/agent/useAcpModelInfo';
import { resetEnsureConversationRuntimeStateForTests } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

const { ensureRuntimeInvokeMock, setConfigOptionInvokeMock, responseStreamHandlers } = vi.hoisted(() => ({
  ensureRuntimeInvokeMock: vi.fn(),
  setConfigOptionInvokeMock: vi.fn(),
  responseStreamHandlers: [] as Array<(message: IResponseMessage) => void>,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      ensureRuntime: { invoke: ensureRuntimeInvokeMock },
    },
    acpConversation: {
      setConfigOption: { invoke: setConfigOptionInvokeMock },
      responseStream: {
        on: vi.fn().mockImplementation((handler: (message: IResponseMessage) => void) => {
          responseStreamHandlers.push(handler);
          return () => {
            const index = responseStreamHandlers.indexOf(handler);
            if (index >= 0) responseStreamHandlers.splice(index, 1);
          };
        }),
      },
    },
  },
}));

const buildConfigOptions = (currentModelId = 'sonnet-4'): AcpConfigOptionDto[] => [
  {
    id: 'model',
    category: 'model',
    option_type: 'select',
    current_value: currentModelId,
    options: [
      { value: 'sonnet-4', label: 'Claude Sonnet 4' },
      { value: 'opus-4', label: 'Claude Opus 4' },
    ],
  },
  {
    id: 'thought_level',
    category: 'thought_level',
    option_type: 'select',
    current_value: 'medium',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
    ],
  },
];

const buildLegacyModelInfo = (overrides: Partial<AcpModelInfo> = {}): AcpModelInfo => ({
  current_model_id: 'sonnet-4',
  current_model_label: 'Claude Sonnet 4',
  available_models: [
    { id: 'sonnet-4', label: 'Claude Sonnet 4' },
    { id: 'opus-4', label: 'Claude Opus 4' },
  ],
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const emitStream = (message: IResponseMessage) => {
  for (const handler of responseStreamHandlers) {
    handler(message);
  }
};

const createSwrWrapper = () => {
  const cache = new Map();

  return function SwrTestWrapper({ children }: PropsWithChildren) {
    return createElement(
      SWRConfig,
      {
        value: {
          provider: () => cache,
          dedupingInterval: 0,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        },
      },
      children
    );
  };
};

const renderUseAcpModelInfo = (params: Parameters<typeof useAcpModelInfo>[0]) =>
  renderHook(() => useAcpModelInfo(params), { wrapper: createSwrWrapper() });

describe('useAcpModelInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responseStreamHandlers.length = 0;
    resetEnsureConversationRuntimeStateForTests();
    ensureRuntimeInvokeMock.mockReset();
    setConfigOptionInvokeMock.mockReset();
    ensureRuntimeInvokeMock.mockResolvedValue({ recovered: true, config_options: buildConfigOptions(), runtime: null });
    setConfigOptionInvokeMock.mockResolvedValue({
      confirmation: 'observed',
      config_options: buildConfigOptions('opus-4'),
    });
  });

  it('derives model info from the model config option and ignores thought_level values', async () => {
    ensureRuntimeInvokeMock.mockResolvedValue({
      recovered: true,
      config_options: buildConfigOptions('opus-4'),
      runtime: null,
    });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      initialModelId: 'sonnet-4',
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('opus-4');
    });
    expect(result.current.model_info?.available_models.map((model) => model.id)).toEqual(['sonnet-4', 'opus-4']);
    expect(result.current.canSwitch).toBe(true);
    expect(ensureRuntimeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1' });
  });

  it('orders model options by their displayed multiplier', async () => {
    ensureRuntimeInvokeMock.mockResolvedValue({
      recovered: true,
      config_options: [
        {
          id: 'model',
          category: 'model',
          option_type: 'select',
          current_value: 'gpt-5.6-terra',
          options: [
            { value: 'gpt-5.6-terra', label: 'GPT-5.6-TERRA 39x' },
            { value: 'deepseek-v4-flash', label: 'DEEPSEEK-V4-FLASH 1x' },
            { value: 'gpt-5.6-sol', label: 'GPT-5.6-SOL 78x' },
            { value: 'deepseek-v4-pro', label: 'DEEPSEEK-V4-PRO 3x' },
            { value: 'gpt-5.5', label: 'GPT-5.6-LUNA 16x' },
          ],
        },
      ],
      runtime: null,
    });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'opencode',
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('gpt-5.6-terra');
    });
    expect(result.current.model_info?.available_models.map((model) => model.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'gpt-5.5',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ]);
  });

  it('filters thought level options for deepseek-v4 models', async () => {
    ensureRuntimeInvokeMock.mockResolvedValue({
      recovered: true,
      config_options: [
        {
          id: 'model',
          category: 'model',
          option_type: 'select',
          current_value: 'deepseek-v4-pro',
          options: [
            { value: 'gpt-5.6-terra', label: 'GPT-5.6-TERRA' },
            { value: 'deepseek-v4-pro', label: 'DEEPSEEK-V4-PRO' },
          ],
        },
        {
          id: 'reasoning_effort',
          category: 'thought_level',
          option_type: 'select',
          current_value: 'low',
          options: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'Xhigh' },
          ],
        },
      ],
      runtime: null,
    });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'deepseek',
      initialModelId: 'deepseek-v4-pro',
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('deepseek-v4-pro');
    });
    expect(result.current.thoughtLevel?.options.map((item) => item.value)).toEqual(['max', 'none']);
    expect(result.current.thoughtLevel?.currentValue).toBe('max');
  });

  it('uses an injected config option loader without starting standalone runtime', async () => {
    const prepareRuntime = vi.fn().mockResolvedValue(undefined);
    const loadConfigOptions = vi.fn().mockResolvedValue(buildConfigOptions('opus-4'));

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      prepareRuntime,
      loadConfigOptions,
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('opus-4');
    });
    expect(prepareRuntime).toHaveBeenCalled();
    expect(loadConfigOptions).toHaveBeenCalledWith('conv-1');
    expect(ensureRuntimeInvokeMock).not.toHaveBeenCalled();
  });

  it('runs set-only runtime preparation before selecting a model without warming during initial load', async () => {
    const calls: string[] = [];
    const prepareSetRuntime = vi.fn(async () => {
      calls.push('prepare-set');
    });
    const loadConfigOptions = vi.fn(async () => {
      calls.push('load');
      return buildConfigOptions('sonnet-4');
    });
    setConfigOptionInvokeMock.mockImplementation(async () => {
      calls.push('set');
      return {
        confirmation: 'observed',
        config_options: buildConfigOptions('opus-4'),
      };
    });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      prepareSetRuntime,
      loadConfigOptions,
    });

    await waitFor(() => {
      expect(result.current.canSwitch).toBe(true);
    });
    expect(calls).toEqual(['load']);
    expect(prepareSetRuntime).not.toHaveBeenCalled();

    act(() => {
      result.current.selectModel('opus-4');
    });

    await waitFor(() => {
      expect(setConfigOptionInvokeMock).toHaveBeenCalledWith({
        conversation_id: 'conv-1',
        option_id: 'model',
        value: 'opus-4',
      });
    });
    expect(calls).toEqual(['load', 'prepare-set', 'load', 'set']);
  });

  it('falls back to the persisted model when the initial config option snapshot fails', async () => {
    const loadConfigOptions = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime not ready'))
      .mockResolvedValueOnce(buildConfigOptions('opus-4'));

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      initialModelId: 'sonnet-4',
      loadConfigOptions,
    });

    await waitFor(() => {
      expect(loadConfigOptions).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('sonnet-4');
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.canSwitch).toBe(false);

    act(() => {
      emitStream({
        type: 'agent_status',
        conversation_id: 'conv-1',
        data: { status: 'session_active' },
      } as unknown as IResponseMessage);
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('opus-4');
    });
    expect(result.current.isLoading).toBe(false);
  });

  it('shows the persisted model while an injected config option snapshot is still loading', async () => {
    const configOptionsDeferred = deferred<AcpConfigOptionDto[]>();
    const loadConfigOptions = vi.fn().mockReturnValue(configOptionsDeferred.promise);

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      initialModelId: 'sonnet-4',
      loadConfigOptions,
    });

    await waitFor(() => {
      expect(loadConfigOptions).toHaveBeenCalledWith('conv-1');
    });
    expect(result.current.model_info?.current_model_id).toBe('sonnet-4');
    expect(result.current.canSwitch).toBe(false);
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      configOptionsDeferred.resolve(buildConfigOptions('opus-4'));
      await configOptionsDeferred.promise;
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('opus-4');
      expect(result.current.canSwitch).toBe(true);
    });
  });

  it('preserves model option descriptions from config options', async () => {
    ensureRuntimeInvokeMock.mockResolvedValue({
      recovered: true,
      config_options: [
        {
          id: 'model',
          category: 'model',
          type: 'select',
          current_value: 'default',
          options: [
            {
              value: 'default',
              name: 'Default (recommended)',
              description: 'Use the default model (currently Opus 4.8) · $5/$25 per Mtok',
            },
            {
              value: 'opus',
              name: 'claude-opus-4-8',
              description: 'Custom Opus model (1M context)',
            },
          ],
        },
      ],
      runtime: null,
    });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('default');
    });
    expect(result.current.model_info?.available_models).toEqual([
      {
        id: 'default',
        label: 'Default (recommended)',
        description: 'Use the default model (currently Opus 4.8) · $5/$25 per Mtok',
      },
      {
        id: 'opus',
        label: 'claude-opus-4-8',
        description: 'Custom Opus model (1M context)',
      },
    ]);
  });

  it('filters OpenCode Zen provider models from config option model choices', async () => {
    ensureRuntimeInvokeMock.mockResolvedValue({
      recovered: true,
      config_options: [
        {
          id: 'model',
          category: 'model',
          type: 'select',
          current_value: 'hth/gpt-5.6-terra',
          options: [
            { value: 'opencode-zen/ling-3.0-flash-free', label: 'OpenCode Zen/Ling-3.0-flash Free' },
            { value: 'opencode-zen/north-mini-code-free', label: 'OpenCode Zen/North Mini Code Free' },
            { value: 'hth/gpt-5.3-codex', label: 'HTH/gpt-5.3-codex' },
            { value: 'hth/gpt-5.6-terra', label: 'HTH/gpt-5.6-terra' },
          ],
        },
      ],
      runtime: null,
    });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'opencode',
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('hth/gpt-5.6-terra');
    });
    expect(result.current.model_info?.available_models.map((model) => model.label)).toEqual([
      'HTH/gpt-5.3-codex',
      'HTH/gpt-5.6-terra',
    ]);
  });

  it('filters OpenCode Zen provider models from legacy model info updates', async () => {
    ensureRuntimeInvokeMock.mockResolvedValue({ recovered: true, config_options: [], runtime: null });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'opencode',
    });

    await waitFor(() => {
      expect(responseStreamHandlers.length).toBeGreaterThan(0);
    });

    act(() => {
      emitStream({
        type: 'acp_model_info',
        conversation_id: 'conv-1',
        data: buildLegacyModelInfo({
          current_model_id: 'hth/gpt-5.6-terra',
          current_model_label: 'HTH/gpt-5.6-terra',
          available_models: [
            { id: 'opencode-zen/mimo-v2.5-free', label: 'OpenCode Zen/MiMo V2.5 Free' },
            { id: 'hth/gpt-5.6-terra', label: 'HTH/gpt-5.6-terra' },
          ],
        }),
      } as unknown as IResponseMessage);
    });

    await waitFor(() => {
      expect(result.current.model_info?.available_models.map((model) => model.label)).toEqual(['HTH/gpt-5.6-terra']);
    });
  });

  it('waits for observed confirmation before updating selected model without persisting a global preference', async () => {
    const setConfigDeferred = deferred<{
      confirmation: 'observed';
      config_options: AcpConfigOptionDto[];
    }>();
    const onSelectModelSuccess = vi.fn();
    const onSelectModelFailed = vi.fn();
    setConfigOptionInvokeMock.mockReturnValue(setConfigDeferred.promise);

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      initialModelId: 'sonnet-4',
      onSelectModelSuccess,
      onSelectModelFailed,
    });

    await waitFor(() => {
      expect(result.current.canSwitch).toBe(true);
    });

    act(() => {
      result.current.selectModel('opus-4');
    });

    await waitFor(() => {
      expect(setConfigOptionInvokeMock).toHaveBeenCalledWith({
        conversation_id: 'conv-1',
        option_id: 'model',
        value: 'opus-4',
      });
    });
    expect(result.current.model_info?.current_model_id).toBe('sonnet-4');
    expect(result.current.isSetting).toBe(true);

    await act(async () => {
      setConfigDeferred.resolve({
        confirmation: 'observed',
        config_options: buildConfigOptions('opus-4'),
      });
      await setConfigDeferred.promise;
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('opus-4');
    });
    expect(onSelectModelSuccess).toHaveBeenCalledWith('opus-4');
    expect(onSelectModelFailed).not.toHaveBeenCalled();
  });

  it('does not update model info when backend only returns command acknowledgement', async () => {
    const onSelectModelSuccess = vi.fn();
    const onSelectModelFailed = vi.fn();
    setConfigOptionInvokeMock.mockResolvedValue({
      confirmation: 'command_ack',
      config_options: null,
    });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      initialModelId: 'sonnet-4',
      onSelectModelSuccess,
      onSelectModelFailed,
    });

    await waitFor(() => {
      expect(result.current.canSwitch).toBe(true);
    });

    act(() => {
      result.current.selectModel('opus-4');
    });

    await waitFor(() => {
      expect(onSelectModelFailed).toHaveBeenCalledWith('opus-4', expect.any(Error));
    });
    expect(result.current.model_info?.current_model_id).toBe('sonnet-4');
    expect(onSelectModelSuccess).not.toHaveBeenCalled();
  });

  it('shares observed model snapshots across hook instances for the same conversation', async () => {
    const wrapper = createSwrWrapper();
    const first = renderHook(
      () => useAcpModelInfo({ conversation_id: 'conv-1', backend: 'claude', initialModelId: 'sonnet-4' }),
      { wrapper }
    );
    const second = renderHook(
      () => useAcpModelInfo({ conversation_id: 'conv-1', backend: 'claude', initialModelId: 'sonnet-4' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(first.result.current.canSwitch).toBe(true);
      expect(second.result.current.canSwitch).toBe(true);
    });

    act(() => {
      first.result.current.selectModel('opus-4');
    });

    await waitFor(() => {
      expect(first.result.current.model_info?.current_model_id).toBe('opus-4');
      expect(second.result.current.model_info?.current_model_id).toBe('opus-4');
    });
  });

  it('coalesces concurrent runtime ensure loads for the same conversation', async () => {
    const ensureDeferred = deferred<{
      recovered: boolean;
      config_options: AcpConfigOptionDto[];
      runtime: null;
    }>();
    ensureRuntimeInvokeMock.mockReturnValue(ensureDeferred.promise);

    const wrapper = createSwrWrapper();
    const first = renderHook(
      () => useAcpModelInfo({ conversation_id: 'conv-1', backend: 'claude', initialModelId: 'sonnet-4' }),
      { wrapper }
    );
    const second = renderHook(
      () => useAcpModelInfo({ conversation_id: 'conv-1', backend: 'claude', initialModelId: 'sonnet-4' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      ensureDeferred.resolve({ recovered: true, config_options: buildConfigOptions(), runtime: null });
      await ensureDeferred.promise;
    });

    await waitFor(() => {
      expect(first.result.current.canSwitch).toBe(true);
      expect(second.result.current.canSwitch).toBe(true);
    });
    expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(1);
  });

  it('uses legacy acp_model_info stream only before config options are available', async () => {
    ensureRuntimeInvokeMock.mockResolvedValue({ recovered: true, config_options: [], runtime: null });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      initialModelId: 'sonnet-4',
    });

    await waitFor(() => {
      expect(responseStreamHandlers.length).toBeGreaterThan(0);
    });

    act(() => {
      emitStream({
        type: 'acp_model_info',
        conversation_id: 'conv-1',
        data: buildLegacyModelInfo({ current_model_id: 'opus-4' }),
      } as unknown as IResponseMessage);
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('opus-4');
    });
    expect(result.current.canSwitch).toBe(false);
  });
});
