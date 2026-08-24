/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markHTHProjectConfigInjected,
  resetHTHProjectConfigInjectionStateForTests,
  useHTHProjectConfigInjection,
} from '@/renderer/pages/conversation/hooks/useHTHProjectConfigInjection';
import { resetEnsureConversationRuntimeStateForTests } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

const ensureRuntimeInvokeMock = vi.fn();
const injectProjectConfigInvokeMock = vi.fn();

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      ensureRuntime: {
        invoke: (...args: unknown[]) => ensureRuntimeInvokeMock(...args),
      },
    },
    hth: {
      injectProjectConfig: {
        invoke: (...args: unknown[]) => injectProjectConfigInvokeMock(...args),
      },
    },
  },
}));

describe('useHTHProjectConfigInjection', () => {
  beforeEach(() => {
    resetHTHProjectConfigInjectionStateForTests();
    resetEnsureConversationRuntimeStateForTests();
    ensureRuntimeInvokeMock.mockReset();
    ensureRuntimeInvokeMock.mockResolvedValue({ runtime: { state: 'idle' } });
    injectProjectConfigInvokeMock.mockReset();
    injectProjectConfigInvokeMock.mockResolvedValue({ injected: true, files: ['opencode.jsonc'] });
  });

  it('waits for runtime readiness before injecting project config', async () => {
    renderHook(() =>
      useHTHProjectConfigInjection({
        conversationId: 'conv-1',
        workspace: 'C:/workspace',
        assistantId: 'hth-assistant',
      })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(ensureRuntimeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1' });
    expect(injectProjectConfigInvokeMock).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      workspace: 'C:/workspace',
      assistantId: 'hth-assistant',
    });
    expect(ensureRuntimeInvokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      injectProjectConfigInvokeMock.mock.invocationCallOrder[0]
    );
  });

  it('does not reinject a Codex project config prepared before navigation', async () => {
    markHTHProjectConfigInjected('conv-1', 'C:/workspace', 'hth-codex');

    renderHook(() =>
      useHTHProjectConfigInjection({
        conversationId: 'conv-1',
        workspace: 'C:/workspace',
        assistantId: 'hth-codex',
      })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(ensureRuntimeInvokeMock).not.toHaveBeenCalled();
    expect(injectProjectConfigInvokeMock).not.toHaveBeenCalled();
  });

  it('skips injection when workspace is missing', async () => {
    renderHook(() =>
      useHTHProjectConfigInjection({
        conversationId: 'conv-1',
        assistantId: 'hth-assistant',
      })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(ensureRuntimeInvokeMock).not.toHaveBeenCalled();
    expect(injectProjectConfigInvokeMock).not.toHaveBeenCalled();
  });
});
