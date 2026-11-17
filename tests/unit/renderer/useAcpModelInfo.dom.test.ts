/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { SWRConfig, useSWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IConversationListChangedEvent, IResponseMessage } from '@/common/adapter/ipcBridge';
import type { AcpConfigOptionDto, AcpModelInfo } from '@/common/types/platform/acpTypes';
import { useAcpModelInfo } from '@/renderer/hooks/agent/useAcpModelInfo';
import { resetAcpConfigOptionsStateForTests, useAcpConfigOptions } from '@/renderer/hooks/agent/useAcpConfigOptions';
import { resetEnsureConversationRuntimeStateForTests } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';
import { setAgentModelCatalogScope } from '@/renderer/services/runtime/agentModelCatalog';

const {
  ensureRuntimeInvokeMock,
  conversationGetInvokeMock,
  modelPricingDescriptionsInvokeMock,
  setConfigOptionInvokeMock,
  responseStreamHandlers,
  conversationListChangedHandlers,
} = vi.hoisted(() => ({
  ensureRuntimeInvokeMock: vi.fn(),
  conversationGetInvokeMock: vi.fn(),
  modelPricingDescriptionsInvokeMock: vi.fn(),
  setConfigOptionInvokeMock: vi.fn(),
  responseStreamHandlers: [] as Array<(message: IResponseMessage) => void>,
  conversationListChangedHandlers: [] as Array<(message: IConversationListChangedEvent) => void>,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      ensureRuntime: { invoke: ensureRuntimeInvokeMock },
      get: { invoke: conversationGetInvokeMock },
      listChanged: {
        on: vi.fn().mockImplementation((handler: (message: IConversationListChangedEvent) => void) => {
          conversationListChangedHandlers.push(handler);
          return () => {
            const index = conversationListChangedHandlers.indexOf(handler);
            if (index >= 0) conversationListChangedHandlers.splice(index, 1);
          };
        }),
      },
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
    hth: {
      modelPricingDescriptions: { invoke: modelPricingDescriptionsInvokeMock },
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

const buildScheduledConfigOptions = (
  backend: 'codex' | 'opencode',
  model: string,
  effort: string
): AcpConfigOptionDto[] => {
  const prefix = backend === 'opencode' ? 'hth/' : '';
  return [
    {
      id: 'model',
      category: 'model',
      type: 'select',
      current_value: prefix + model,
      options: [
        { value: prefix + 'gpt-6.1-sol', name: 'GPT-6.1-SOL' },
        { value: prefix + 'deepseek-v4-pro', name: 'DEEPSEEK-V4-PRO' },
      ],
    },
    {
      id: 'reasoning_effort',
      category: 'thought_level',
      type: 'select',
      current_value: effort,
      options: [
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'max', name: 'Max' },
      ],
    },
  ];
};

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

const renderUseAcpModelInfo = (params: Parameters<typeof useAcpModelInfo>[0], wrapper = createSwrWrapper()) =>
  renderHook(() => useAcpModelInfo(params), { wrapper });

describe('useAcpModelInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responseStreamHandlers.length = 0;
    conversationListChangedHandlers.length = 0;
    resetEnsureConversationRuntimeStateForTests();
    resetAcpConfigOptionsStateForTests();
    setAgentModelCatalogScope(null);
    conversationGetInvokeMock.mockReset();
    ensureRuntimeInvokeMock.mockReset();
    modelPricingDescriptionsInvokeMock.mockReset();
    setConfigOptionInvokeMock.mockReset();
    ensureRuntimeInvokeMock.mockResolvedValue({ recovered: true, config_options: buildConfigOptions(), runtime: null });
    modelPricingDescriptionsInvokeMock.mockResolvedValue({ descriptions: {} });
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

    expect(result.current.isRuntimeReady).toBe(false);

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('opus-4');
    });
    expect(result.current.isRuntimeReady).toBe(true);
    expect(result.current.model_info?.available_models.map((model) => model.id)).toEqual(['sonnet-4', 'opus-4']);
    expect(result.current.canSwitch).toBe(true);
    expect(ensureRuntimeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1' });
  });

  it('preserves model option order even when labels contain multiplier text', async () => {
    ensureRuntimeInvokeMock.mockResolvedValue({
      recovered: true,
      config_options: [
        {
          id: 'model',
          category: 'model',
          option_type: 'select',
          current_value: 'hth/gpt-5.6-terra',
          options: [
            { value: 'hth/gpt-5.6-terra', label: 'GPT-5.6-TERRA 39x' },
            { value: 'hth/deepseek-v4-flash', label: 'DEEPSEEK-V4-FLASH 1x' },
            { value: 'hth/gpt-5.6-sol', label: 'GPT-5.6-SOL 78x' },
            { value: 'hth/deepseek-v4-pro', label: 'DEEPSEEK-V4-PRO 3x' },
            { value: 'hth/gpt-5.5', label: 'GPT-5.6-LUNA 16x' },
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
    expect(result.current.model_info?.available_models.map((model) => model.id)).toEqual([
      'hth/gpt-5.6-terra',
      'hth/deepseek-v4-flash',
      'hth/gpt-5.6-sol',
      'hth/deepseek-v4-pro',
      'hth/gpt-5.5',
    ]);
  });

  it('keeps runtime thought level options for deepseek-v4 models', async () => {
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
    expect(result.current.thoughtLevel?.options.map((item) => item.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(result.current.thoughtLevel?.currentValue).toBe('low');
  });

  it('uses an injected config option loader without starting standalone runtime', async () => {
    const prepareRuntime = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn().mockResolvedValue(buildConfigOptions('opus-4'));

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      prepareRuntime,
      configOptionsPort: { load },
    });

    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('opus-4');
    });
    expect(prepareRuntime).toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith('conv-1');
    expect(ensureRuntimeInvokeMock).not.toHaveBeenCalled();
  });

  it('runs set-only runtime preparation before selecting a model without warming during initial load', async () => {
    const calls: string[] = [];
    const prepareSetRuntime = vi.fn(async () => {
      calls.push('prepare-set');
    });
    const load = vi.fn(async () => {
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
      configOptionsPort: { load },
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
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime not ready'))
      .mockResolvedValueOnce(buildConfigOptions('opus-4'));

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      initialModelId: 'sonnet-4',
      configOptionsPort: { load },
    });

    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.model_info?.current_model_id).toBe('sonnet-4');
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.canSwitch).toBe(false);
    expect(result.current.isRuntimeReady).toBe(false);

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
    expect(result.current.isRuntimeReady).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it('shows the persisted model while an injected config option snapshot is still loading', async () => {
    const configOptionsDeferred = deferred<AcpConfigOptionDto[]>();
    const load = vi.fn().mockReturnValue(configOptionsDeferred.promise);

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      initialModelId: 'sonnet-4',
      configOptionsPort: { load },
    });

    await waitFor(() => {
      expect(load).toHaveBeenCalledWith('conv-1');
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

  it('does not mark a new conversation ready when the previous runtime load resolves late', async () => {
    const firstLoad = deferred<AcpConfigOptionDto[]>();
    const secondLoad = deferred<AcpConfigOptionDto[]>();
    const load = vi.fn((conversationId: string) =>
      conversationId === 'conv-1' ? firstLoad.promise : secondLoad.promise
    );
    const wrapper = createSwrWrapper();
    const { result, rerender } = renderHook(
      ({ conversationId }) =>
        useAcpModelInfo({
          conversation_id: conversationId,
          backend: 'claude',
          configOptionsPort: { load },
        }),
      { initialProps: { conversationId: 'conv-1' }, wrapper }
    );

    await waitFor(() => expect(load).toHaveBeenCalledWith('conv-1'));
    rerender({ conversationId: 'conv-2' });
    await waitFor(() => expect(load).toHaveBeenCalledWith('conv-2'));

    await act(async () => {
      firstLoad.resolve(buildConfigOptions());
      await firstLoad.promise;
    });
    expect(result.current.isRuntimeReady).toBe(false);

    await act(async () => {
      secondLoad.resolve(buildConfigOptions());
      await secondLoad.promise;
    });
    await waitFor(() => expect(result.current.isRuntimeReady).toBe(true));
  });

  it('updates ordinary Codex effort from actual confirmations without reconnecting or replaying a filled snapshot', async () => {
    setAgentModelCatalogScope('ordinary-codex');
    const nativeOptions = buildScheduledConfigOptions('codex', 'gpt-6.1-sol', '');
    const updatedMetadata = deferred<unknown>();
    const conversation = (thoughtLevel: string) => ({
      id: 'conv-1',
      extra: {
        thought_level: 'high',
        current_model_id: 'gpt-6.1-sol',
        aionui_codex_runtime: {
          version: 1,
          confirmed: { backend: 'codex', model: 'gpt-6.1-sol', thoughtLevel },
        },
      },
    });
    ensureRuntimeInvokeMock.mockResolvedValue({ recovered: false, config_options: nativeOptions, runtime: null });
    conversationGetInvokeMock
      .mockResolvedValueOnce(conversation('medium'))
      .mockReturnValueOnce(updatedMetadata.promise)
      .mockResolvedValue(conversation('high'));
    const { result } = renderUseAcpModelInfo({ conversation_id: 'conv-1', backend: 'codex' });

    await waitFor(() => expect(result.current.thoughtLevel?.currentValue).toBe('medium'));
    expect(result.current.thoughtLevel?.options.find((option) => option.value === 'medium')?.label).toBe('Medium');
    act(() => {
      for (const handler of conversationListChangedHandlers) {
        handler({ conversation_id: 'conv-1', action: 'updated' });
      }
    });
    await waitFor(() => expect(conversationGetInvokeMock).toHaveBeenCalledTimes(2));
    act(() => {
      emitStream({
        type: 'acp_config_option',
        conversation_id: 'conv-1',
        data: { config_options: nativeOptions },
      } as unknown as IResponseMessage);
    });
    await act(async () => {
      updatedMetadata.resolve(conversation('high'));
      await updatedMetadata.promise;
    });
    await waitFor(() => expect(result.current.thoughtLevel?.currentValue).toBe('high'));

    const nativeRefresh = deferred<unknown>();
    ensureRuntimeInvokeMock.mockReturnValue(nativeRefresh.promise);
    act(() => {
      emitStream({
        type: 'acp_config_option',
        conversation_id: 'conv-1',
        data: { config_options: buildScheduledConfigOptions('codex', 'gpt-6.1-sol', 'medium') },
      } as unknown as IResponseMessage);
      for (const handler of conversationListChangedHandlers) {
        handler({ conversation_id: 'conv-1', action: 'updated' });
      }
    });
    await waitFor(() => expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(3));
    await act(async () => {
      nativeRefresh.resolve({
        recovered: false,
        config_options: buildScheduledConfigOptions('codex', 'gpt-6.1-sol', 'medium'),
        runtime: null,
      });
      await nativeRefresh.promise;
    });
    expect(result.current.thoughtLevel?.currentValue).toBe('medium');
    expect(conversationGetInvokeMock).toHaveBeenCalledTimes(2);
    expect(setConfigOptionInvokeMock).not.toHaveBeenCalled();
  });

  it.each(['before', 'after'] as const)(
    'keeps confirmed model and effort when a second selector mounts %s the stream update and the old HTTP load resolves',
    async (mountTiming) => {
      const oldSnapshot = deferred<{ recovered: boolean; config_options: AcpConfigOptionDto[]; runtime: null }>();
      ensureRuntimeInvokeMock.mockReturnValue(oldSnapshot.promise);
      const wrapper = createSwrWrapper();
      const params = { conversation_id: 'conv-1', backend: 'opencode' };
      const first = renderUseAcpModelInfo(params, wrapper);
      let second = mountTiming === 'before' ? renderUseAcpModelInfo(params, wrapper) : undefined;
      await waitFor(() => expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(1));

      act(() => {
        emitStream({
          type: 'acp_config_option',
          conversation_id: 'conv-1',
          data: { config_options: buildScheduledConfigOptions('opencode', 'deepseek-v4-pro', 'max') },
        } as unknown as IResponseMessage);
      });
      second ??= renderUseAcpModelInfo(params, wrapper);
      await waitFor(() => {
        expect(first.result.current.model_info?.current_model_id).toBe('hth/deepseek-v4-pro');
        expect(first.result.current.thoughtLevel?.currentValue).toBe('max');
        expect(second.result.current.model_info?.current_model_id).toBe('hth/deepseek-v4-pro');
        expect(second.result.current.thoughtLevel?.currentValue).toBe('max');
      });

      await act(async () => {
        oldSnapshot.resolve({
          recovered: true,
          config_options: buildScheduledConfigOptions('opencode', 'gpt-6.1-sol', 'high'),
          runtime: null,
        });
        await oldSnapshot.promise;
      });
      await waitFor(() => expect(first.result.current.isRuntimeReady).toBe(true));
      expect(first.result.current.model_info?.current_model_id).toBe('hth/deepseek-v4-pro');
      expect(first.result.current.thoughtLevel?.currentValue).toBe('max');
      expect(second.result.current.model_info?.current_model_id).toBe('hth/deepseek-v4-pro');
      expect(second.result.current.thoughtLevel?.currentValue).toBe('max');
      expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps confirmed Codex medium reasoning when an earlier HTTP load returns no options', async () => {
    const oldSnapshot = deferred<{ recovered: boolean; config_options: AcpConfigOptionDto[]; runtime: null }>();
    ensureRuntimeInvokeMock.mockReturnValue(oldSnapshot.promise);
    const { result } = renderUseAcpModelInfo({ conversation_id: 'conv-1', backend: 'codex' });
    await waitFor(() => expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(1));
    act(() => {
      emitStream({
        type: 'acp_config_option',
        conversation_id: 'conv-1',
        data: { config_options: buildScheduledConfigOptions('codex', 'gpt-6.1-sol', 'medium') },
      } as unknown as IResponseMessage);
    });
    await waitFor(() => expect(result.current.thoughtLevel?.currentValue).toBe('medium'));

    await act(async () => {
      oldSnapshot.resolve({ recovered: true, config_options: [], runtime: null });
      await oldSnapshot.promise;
    });
    await waitFor(() => expect(result.current.isRuntimeReady).toBe(true));
    expect(result.current.model_info?.current_model_id).toBe('gpt-6.1-sol');
    expect(result.current.thoughtLevel?.currentValue).toBe('medium');
  });

  it.each([
    { backend: 'codex' as const, model: 'gpt-6.1-sol', effort: 'medium' },
    { backend: 'opencode' as const, model: 'deepseek-v4-pro', effort: 'max' },
  ])('shows the confirmed $backend HTTP settings on the first mount without reconnecting', async (settings) => {
    ensureRuntimeInvokeMock.mockResolvedValue({
      recovered: false,
      config_options: buildScheduledConfigOptions(settings.backend, settings.model, settings.effort),
      runtime: null,
    });
    const { result } = renderUseAcpModelInfo({ conversation_id: 'conv-1', backend: settings.backend });

    await waitFor(() => expect(result.current.isRuntimeReady).toBe(true));
    expect(result.current.model_info?.current_model_id).toBe(
      settings.backend === 'opencode' ? 'hth/' + settings.model : settings.model
    );
    expect(result.current.thoughtLevel?.currentValue).toBe(settings.effort);
    expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(1);
    expect(setConfigOptionInvokeMock).not.toHaveBeenCalled();
  });

  it.each([
    { streamTiming: 'before', initialEmpty: false },
    { streamTiming: 'after', initialEmpty: false },
    { streamTiming: 'after', initialEmpty: true },
  ])(
    'shows confirmed Codex medium on first open with stream $streamTiming HTTP and initialEmpty=$initialEmpty',
    async ({ streamTiming, initialEmpty }) => {
      setAgentModelCatalogScope('offline-confirmed-codex');
      const nativeOptions = buildScheduledConfigOptions('codex', 'gpt-6.1-sol', '');
      const metadata = deferred<unknown>();
      ensureRuntimeInvokeMock.mockResolvedValue({
        recovered: false,
        config_options: initialEmpty ? [] : nativeOptions,
        runtime: null,
      });
      conversationGetInvokeMock.mockReturnValue(metadata.promise);
      const { result } = renderUseAcpModelInfo({ conversation_id: 'conv-1', backend: 'codex' });
      await waitFor(() => expect(conversationGetInvokeMock).toHaveBeenCalledTimes(1));
      const emitNativeSnapshot = () =>
        emitStream({
          type: 'acp_config_option',
          conversation_id: 'conv-1',
          data: { config_options: nativeOptions },
        } as unknown as IResponseMessage);
      if (streamTiming === 'before') act(emitNativeSnapshot);
      await act(async () => {
        metadata.resolve({
          id: 'conv-1',
          extra: {
            aionui_cron_runtime: {
              version: 1,
              runtime: { backend: 'codex', model: 'gpt-6.1-sol', thoughtLevel: 'medium' },
              confirmed: { backend: 'codex', model: 'gpt-6.1-sol', thoughtLevel: 'medium' },
            },
          },
        });
        await metadata.promise;
      });
      await waitFor(() => expect(result.current.isRuntimeReady).toBe(true));
      if (streamTiming === 'after') act(emitNativeSnapshot);
      await waitFor(() => expect(result.current.thoughtLevel?.currentValue).toBe('medium'));

      act(() =>
        emitStream({
          type: 'acp_config_option',
          conversation_id: 'conv-1',
          data: { config_options: buildScheduledConfigOptions('codex', 'gpt-6.1-sol', 'high') },
        } as unknown as IResponseMessage)
      );
      await waitFor(() => expect(result.current.thoughtLevel?.currentValue).toBe('high'));
      expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(1);
      expect(setConfigOptionInvokeMock).not.toHaveBeenCalled();
    }
  );

  it.each(['before', 'after'] as const)(
    'refreshes confirmed Codex effort when persistence finishes %s an older metadata read',
    async (eventTiming) => {
      setAgentModelCatalogScope('offline-confirmed-codex');
      const nativeOptions = buildScheduledConfigOptions('codex', 'gpt-6.1-sol', '');
      const oldMetadata = deferred<unknown>();
      const runtime = { backend: 'codex', model: 'gpt-6.1-sol', thoughtLevel: 'medium' };
      ensureRuntimeInvokeMock
        .mockResolvedValueOnce({ recovered: false, config_options: [], runtime: null })
        .mockResolvedValue({ recovered: false, config_options: nativeOptions, runtime: null });
      conversationGetInvokeMock.mockReturnValueOnce(oldMetadata.promise).mockResolvedValue({
        id: 'conv-1',
        extra: { aionui_cron_runtime: { version: 1, runtime, confirmed: runtime } },
      });
      const { result } = renderUseAcpModelInfo({ conversation_id: 'conv-1', backend: 'codex' });
      await waitFor(() => expect(conversationGetInvokeMock).toHaveBeenCalledTimes(1));
      expect(conversationListChangedHandlers).toHaveLength(1);
      act(() => {
        emitStream({
          type: 'acp_config_option',
          conversation_id: 'conv-1',
          data: { config_options: nativeOptions },
        } as unknown as IResponseMessage);
      });
      await waitFor(() => expect(result.current.model_info?.current_model_id).toBe('gpt-6.1-sol'));
      expect(result.current.thoughtLevel?.currentValue).toBe('');
      if (eventTiming === 'before') {
        act(() => {
          for (const handler of conversationListChangedHandlers) {
            handler({ conversation_id: 'conv-1', action: 'updated', source: 'aionui' });
          }
        });
        expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(1);
      }
      await act(async () => {
        oldMetadata.resolve({ id: 'conv-1', extra: { aionui_cron_runtime: { version: 1, runtime } } });
        await oldMetadata.promise;
      });
      if (eventTiming === 'after') {
        await waitFor(() => expect(result.current.isRuntimeReady).toBe(true));
        expect(result.current.thoughtLevel?.currentValue).toBe('');
        await act(async () => {
          for (const handler of conversationListChangedHandlers) {
            handler({ conversation_id: 'another-conversation', action: 'updated', source: 'aionui' });
            handler({ conversation_id: 'conv-1', action: 'created', source: 'aionui' });
            handler({ conversation_id: 'conv-1', action: 'deleted', source: 'aionui' });
          }
          await Promise.resolve();
        });
        expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(1);
        expect(conversationGetInvokeMock).toHaveBeenCalledTimes(1);
        act(() => {
          for (const handler of conversationListChangedHandlers) {
            handler({ conversation_id: 'conv-1', action: 'updated', source: 'aionui' });
          }
        });
      }

      await waitFor(() => expect(result.current.thoughtLevel?.currentValue).toBe('medium'));
      expect(result.current.model_info?.current_model_id).toBe('gpt-6.1-sol');
      expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(2);
      expect(conversationGetInvokeMock).toHaveBeenCalledTimes(2);
      expect(setConfigOptionInvokeMock).not.toHaveBeenCalled();
    }
  );

  it('keeps a confirmed set response when an older reload finishes later', async () => {
    const initial = buildScheduledConfigOptions('opencode', 'gpt-6.1-sol', 'high');
    const confirmed = buildScheduledConfigOptions('opencode', 'deepseek-v4-pro', 'max');
    const oldLoad = deferred<AcpConfigOptionDto[]>();
    const setting = deferred<{ confirmation: 'observed'; config_options: AcpConfigOptionDto[] }>();
    const load = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(initial).mockReturnValue(oldLoad.promise);
    setConfigOptionInvokeMock.mockReturnValue(setting.promise);
    const params = { conversation_id: 'conv-1', backend: 'opencode', configOptionsPort: { load } };
    const { result } = renderHook(() => ({ ...useAcpModelInfo(params), reload: useAcpConfigOptions(params).reload }), {
      wrapper: createSwrWrapper(),
    });
    await waitFor(() => expect(result.current.isRuntimeReady).toBe(true));
    let setPromise!: Promise<AcpConfigOptionDto[]>;
    act(() => {
      setPromise = result.current.setConfigOption('reasoning_effort', 'max');
    });
    await waitFor(() => expect(setConfigOptionInvokeMock).toHaveBeenCalledTimes(1));
    let reloadPromise!: Promise<unknown>;
    act(() => {
      reloadPromise = result.current.reload();
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));

    await act(async () => {
      setting.resolve({ confirmation: 'observed', config_options: confirmed });
      await setPromise;
    });
    expect(result.current.model_info?.current_model_id).toBe('hth/deepseek-v4-pro');
    expect(result.current.thoughtLevel?.currentValue).toBe('max');
    await act(async () => {
      oldLoad.resolve(initial);
      await reloadPromise;
    });
    expect(result.current.model_info?.current_model_id).toBe('hth/deepseek-v4-pro');
    expect(result.current.thoughtLevel?.currentValue).toBe('max');
  });

  it('keeps stream confirmation when a stale SWR revalidation finishes later', async () => {
    const oldLoad = deferred<AcpConfigOptionDto[]>();
    const load = vi
      .fn()
      .mockResolvedValueOnce(buildScheduledConfigOptions('opencode', 'gpt-6.1-sol', 'high'))
      .mockReturnValue(oldLoad.promise);
    const params = { conversation_id: 'conv-1', backend: 'opencode', configOptionsPort: { load } };
    const { result } = renderHook(
      () => ({
        info: useAcpModelInfo(params),
        revalidate: useSWRConfig().mutate,
      }),
      { wrapper: createSwrWrapper() }
    );
    await waitFor(() => expect(result.current.info.isRuntimeReady).toBe(true));
    let revalidation!: Promise<unknown>;
    act(() => {
      revalidation = result.current.revalidate(['acp-config-options', 'conv-1']);
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    act(() => {
      emitStream({
        type: 'acp_config_option',
        conversation_id: 'conv-1',
        data: { config_options: buildScheduledConfigOptions('opencode', 'deepseek-v4-pro', 'max') },
      } as unknown as IResponseMessage);
    });
    await waitFor(() => expect(result.current.info.thoughtLevel?.currentValue).toBe('max'));
    await act(async () => {
      oldLoad.resolve(buildScheduledConfigOptions('opencode', 'gpt-6.1-sol', 'high'));
      await revalidation;
    });
    expect(result.current.info.model_info?.current_model_id).toBe('hth/deepseek-v4-pro');
    expect(result.current.info.thoughtLevel?.currentValue).toBe('max');
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

  it('adds HTH model prices to OpenCode option descriptions without replacing native descriptions', async () => {
    ensureRuntimeInvokeMock.mockResolvedValue({
      recovered: true,
      config_options: [
        {
          id: 'model',
          category: 'model',
          type: 'select',
          current_value: 'hth/gpt-5.6-terra',
          options: [
            { value: 'hth/gpt-5.6-terra', label: 'HTH/GPT-5.6-TERRA x2.5' },
            {
              value: 'hth/deepseek-v4-flash',
              label: 'HTH/DEEPSEEK-V4-FLASH x1',
              description: 'OpenCode supplied description',
            },
            { value: 'openai/gpt-5', label: 'OpenAI/GPT-5' },
          ],
        },
      ],
      runtime: null,
    });
    modelPricingDescriptionsInvokeMock.mockResolvedValue({
      descriptions: {
        'gpt-5.6-terra': '输入 $4.00 / 百万 Token\n输出 $8.00 / 百万 Token',
        'deepseek-v4-flash': '输入 $2.00 / 百万 Token\n输出 $2.00 / 百万 Token',
      },
    });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'opencode',
    });

    await waitFor(() => {
      expect(modelPricingDescriptionsInvokeMock).toHaveBeenCalledWith({
        modelIds: ['gpt-5.6-terra', 'deepseek-v4-flash'],
      });
    });
    await waitFor(() => {
      expect(result.current.model_info?.available_models).toEqual([
        {
          id: 'hth/gpt-5.6-terra',
          label: 'HTH/GPT-5.6-TERRA x2.5',
          description: '输入 $4.00 / 百万 Token\n输出 $8.00 / 百万 Token',
        },
        {
          id: 'hth/deepseek-v4-flash',
          label: 'HTH/DEEPSEEK-V4-FLASH x1',
          description: 'OpenCode supplied description',
        },
      ]);
    });
  });

  it('whitelists HTH models from legacy model info updates for OpenCode', async () => {
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
          current_model_id: 'openai/gpt-5',
          current_model_label: 'OpenAI/GPT-5',
          available_models: [
            { id: 'opencode-zen/mimo-v2.5-free', label: 'OpenCode Zen/MiMo V2.5 Free' },
            { id: 'hth/gpt-5.6-terra', label: 'HTH/gpt-5.6-terra' },
            { id: 'openai/gpt-5', label: 'OpenAI/GPT-5' },
          ],
        }),
      } as unknown as IResponseMessage);
    });

    await waitFor(() => {
      expect(result.current.model_info).toEqual({
        current_model_id: 'hth/gpt-5.6-terra',
        current_model_label: 'HTH/gpt-5.6-terra',
        available_models: [{ id: 'hth/gpt-5.6-terra', label: 'HTH/gpt-5.6-terra' }],
      });
    });
  });

  it('clears the selected model when OpenCode returns no HTH models', async () => {
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
          current_model_id: 'opencode-zen/mimo-v2.5-free',
          current_model_label: 'OpenCode Zen/MiMo V2.5 Free',
          available_models: [{ id: 'opencode-zen/mimo-v2.5-free', label: 'OpenCode Zen/MiMo V2.5 Free' }],
        }),
      } as unknown as IResponseMessage);
    });

    await waitFor(() => {
      expect(result.current.model_info).toEqual({
        current_model_id: null,
        current_model_label: null,
        available_models: [],
      });
    });
  });

  it('keeps non-HTH models for non-OpenCode runtimes', async () => {
    ensureRuntimeInvokeMock.mockResolvedValue({ recovered: true, config_options: [], runtime: null });

    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
    });

    await waitFor(() => {
      expect(responseStreamHandlers.length).toBeGreaterThan(0);
    });

    const available_models = [
      { id: 'hth/gpt-5.6-terra', label: 'HTH/gpt-5.6-terra' },
      { id: 'claude/sonnet-4', label: 'Claude/Sonnet 4' },
    ];
    act(() => {
      emitStream({
        type: 'acp_model_info',
        conversation_id: 'conv-1',
        data: buildLegacyModelInfo({
          current_model_id: 'claude/sonnet-4',
          current_model_label: 'Claude/Sonnet 4',
          available_models,
        }),
      } as unknown as IResponseMessage);
    });

    await waitFor(() => {
      expect(result.current.model_info?.available_models).toEqual(available_models);
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

  // Persistence is no longer a separate step the caller chains after the switch —
  // the backend persists it in the same request. So a failure raised AFTER the
  // switch landed must not be reported as a failed switch, which is what the
  // caller-chained version used to do.
  it('does not report a failure when the success callback itself throws', async () => {
    const callbackError = new Error('toast blew up');
    const onSelectModelSuccess = vi.fn(() => {
      throw callbackError;
    });
    const onSelectModelFailed = vi.fn();
    setConfigOptionInvokeMock.mockResolvedValue({
      confirmation: 'observed',
      config_options: buildConfigOptions('opus-4'),
    });
    const { result } = renderUseAcpModelInfo({
      conversation_id: 'conv-1',
      backend: 'claude',
      onSelectModelSuccess,
      onSelectModelFailed,
    });
    await waitFor(() => expect(result.current.canSwitch).toBe(true));

    act(() => result.current.selectModel('opus-4'));

    await waitFor(() => expect(onSelectModelSuccess).toHaveBeenCalledWith('opus-4'));
    // The switch itself succeeded, so the model really did change...
    await waitFor(() => expect(result.current.model_info?.current_model_id).toBe('opus-4'));
    // ...and the user is never told it failed.
    expect(onSelectModelFailed).not.toHaveBeenCalled();
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
