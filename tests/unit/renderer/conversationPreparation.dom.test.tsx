/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { AcpConfigOptionDto } from '@/common/types/platform/acpTypes';
import ConversationPreparation from '@/renderer/pages/conversation/runtime/ConversationPreparationGate';
import {
  getConversationPreparation,
  prepareConversation,
  registerConversationPreparation,
  resetConversationPreparationForTests,
} from '@/renderer/pages/conversation/runtime/conversationPreparation';
import { resetEnsureConversationRuntimeStateForTests } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';
import { resetHTHProjectConfigInjectionStateForTests } from '@/renderer/pages/conversation/hooks/useHTHProjectConfigInjection';
import { setAgentModelCatalogScope } from '@/renderer/services/runtime/agentModelCatalog';

const ensureRuntimeInvokeMock = vi.fn();
const setConfigOptionInvokeMock = vi.fn();
const injectProjectConfigInvokeMock = vi.fn();
const getConversationOrNullMock = vi.fn();
const mountedChat = vi.fn();
const t = ((key: string) => key) as TFunction;

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      ensureRuntime: { invoke: (...args: unknown[]) => ensureRuntimeInvokeMock(...args) },
    },
    acpConversation: {
      setConfigOption: { invoke: (...args: unknown[]) => setConfigOptionInvokeMock(...args) },
    },
    hth: {
      injectProjectConfig: { invoke: (...args: unknown[]) => injectProjectConfigInvokeMock(...args) },
    },
  },
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: (...args: unknown[]) => getConversationOrNullMock(...args),
}));

function openCodeConfigOptions(effort: string): AcpConfigOptionDto[] {
  return [
    {
      id: 'model',
      category: 'model',
      type: 'select',
      current_value: 'hth/gpt-6.1-sol',
      options: [{ value: 'hth/gpt-6.1-sol', name: 'GPT' }],
    },
    {
      id: 'effort',
      category: 'thought_level',
      type: 'select',
      current_value: effort,
      options: ['low', 'medium', 'high', 'max'].map((value) => ({ value, name: value })),
    },
  ];
}

function registerOpenCode(conversationId = 'conv-1', thoughtLevel = 'max') {
  registerConversationPreparation(conversationId, {
    backend: 'opencode',
    assistantId: 'assistant-1',
    workspace: 'C:/workspace',
    model: 'hth/gpt-6.1-sol',
    thoughtLevel,
    initialMessage: { input: 'hello', files: [{ kind: 'local', path: 'C:/report.pdf' }] },
  });
}

function Chat({ conversationId }: { conversationId: string }) {
  useEffect(() => {
    mountedChat(conversationId, sessionStorage.getItem(`acp_initial_message_${conversationId}`));
  }, [conversationId]);
  return <div data-testid='chat'>{conversationId}</div>;
}

function renderPreparation(conversationId = 'conv-1') {
  return render(
    <ConversationPreparation key={conversationId} conversationId={conversationId}>
      <Chat conversationId={conversationId} />
    </ConversationPreparation>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  resetConversationPreparationForTests();
  resetEnsureConversationRuntimeStateForTests();
  resetHTHProjectConfigInjectionStateForTests();
  setAgentModelCatalogScope(null);
  mountedChat.mockReset();
  ensureRuntimeInvokeMock.mockReset();
  ensureRuntimeInvokeMock.mockResolvedValue({ config_options: openCodeConfigOptions('max') });
  setConfigOptionInvokeMock.mockReset();
  setConfigOptionInvokeMock.mockResolvedValue({
    confirmation: 'observed',
    config_options: openCodeConfigOptions('max'),
  });
  injectProjectConfigInvokeMock.mockReset();
  injectProjectConfigInvokeMock.mockResolvedValue({ injected: true, files: ['opencode.jsonc'] });
  getConversationOrNullMock.mockReset();
  getConversationOrNullMock.mockResolvedValue(null);
});

afterEach(() => cleanup());

describe('conversation preparation', () => {
  it('keeps chat, automatic CLI startup and first-message delivery behind project injection', async () => {
    registerOpenCode();
    let finishInjection!: () => void;
    injectProjectConfigInvokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInjection = () => resolve({ injected: true, files: [] });
        })
    );
    const view = renderPreparation();

    expect(view.queryByTestId('chat')).not.toBeInTheDocument();
    expect(ensureRuntimeInvokeMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('acp_initial_message_conv-1')).toBeNull();

    await act(async () => {
      finishInjection();
    });

    await waitFor(() =>
      expect(mountedChat).toHaveBeenCalledWith(
        'conv-1',
        JSON.stringify({
          input: 'hello',
          files: [{ kind: 'local', path: 'C:/report.pdf' }],
        })
      )
    );
  });

  it('waits for an observed OpenCode effort before mounting chat or handing over its first message', async () => {
    registerOpenCode();
    ensureRuntimeInvokeMock.mockResolvedValue({ config_options: openCodeConfigOptions('low') });
    let confirm!: (value: unknown) => void;
    setConfigOptionInvokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        })
    );
    const view = renderPreparation();
    await waitFor(() =>
      expect(setConfigOptionInvokeMock).toHaveBeenCalledWith({
        conversation_id: 'conv-1',
        option_id: 'effort',
        value: 'max',
      })
    );

    expect(view.queryByTestId('chat')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('acp_initial_message_conv-1')).toBeNull();

    await act(async () => {
      confirm({ confirmation: 'observed', config_options: openCodeConfigOptions('max') });
    });

    await waitFor(() => expect(view.getByTestId('chat')).toBeInTheDocument());
  });

  it.each(['low', 'medium', 'high', 'max'])(
    'preserves an already applied OpenCode %s without an extra config write',
    async (thoughtLevel) => {
      registerOpenCode('conv-1', thoughtLevel);
      ensureRuntimeInvokeMock.mockResolvedValue({ config_options: openCodeConfigOptions(thoughtLevel) });

      await prepareConversation('conv-1', t);

      expect(setConfigOptionInvokeMock).not.toHaveBeenCalled();
      expect(getConversationPreparation('conv-1')).toBeNull();
      expect(sessionStorage.getItem('acp_initial_message_conv-1')).not.toBeNull();
    }
  );

  it.each([
    { confirmation: 'command_ack', config_options: null },
    { confirmation: 'pending_next_turn', config_options: openCodeConfigOptions('low') },
    { confirmation: 'observed', config_options: openCodeConfigOptions('low') },
  ])('retains the first message when the selected effort remains unconfirmed: %j', async (response) => {
    registerOpenCode();
    ensureRuntimeInvokeMock.mockResolvedValue({ config_options: openCodeConfigOptions('low') });
    setConfigOptionInvokeMock.mockResolvedValue(response);

    await expect(prepareConversation('conv-1', t)).rejects.toThrow('agent.thoughtLevel.switchFailed');

    expect(getConversationPreparation('conv-1')?.initialMessage?.input).toBe('hello');
    expect(sessionStorage.getItem('acp_initial_message_conv-1')).toBeNull();
  });

  it.each(['model', 'effort'])(
    'blocks first-message delivery when the selected OpenCode %s is unavailable',
    async (mismatch) => {
      registerOpenCode();
      const options = openCodeConfigOptions('low');
      if (mismatch === 'model') options[0].current_value = 'hth/other-model';
      else options[1].options = [{ value: 'low', name: 'Low' }];
      ensureRuntimeInvokeMock.mockResolvedValue({ config_options: options });

      await expect(prepareConversation('conv-1', t)).rejects.toThrow(
        mismatch === 'model' ? 'agent.model.switchFailed' : 'agent.thoughtLevel.switchFailed'
      );

      expect(setConfigOptionInvokeMock).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('acp_initial_message_conv-1')).toBeNull();
    }
  );

  it('keeps a CLI startup failure retryable without losing its message or attachments', async () => {
    registerOpenCode();
    ensureRuntimeInvokeMock.mockRejectedValueOnce(new Error('CLI startup failed'));
    const view = renderPreparation();
    await screen.findByRole('button', { name: 'common.retry' });

    expect(view.queryByTestId('chat')).not.toBeInTheDocument();
    expect(getConversationPreparation('conv-1')?.initialMessage?.files).toEqual([
      { kind: 'local', path: 'C:/report.pdf' },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));

    await waitFor(() => expect(mountedChat).toHaveBeenCalledTimes(1));
  });

  it('does not start the CLI after a blocking HTH configuration failure', async () => {
    registerOpenCode();
    injectProjectConfigInvokeMock.mockResolvedValue({ injected: false, files: [], reason: 'modelListUnavailable' });

    await expect(prepareConversation('conv-1', t)).rejects.toThrow('modelListUnavailable');

    expect(ensureRuntimeInvokeMock).not.toHaveBeenCalled();
    expect(getConversationPreparation('conv-1')).not.toBeNull();
  });

  it('reuses the same preparation when a conversation remounts before configuration is ready', async () => {
    registerOpenCode();
    let finishInjection!: () => void;
    injectProjectConfigInvokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInjection = () => resolve({ injected: true, files: [] });
        })
    );
    const first = renderPreparation();
    await waitFor(() => expect(injectProjectConfigInvokeMock).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = renderPreparation();

    await act(async () => {
      finishInjection();
    });

    await waitFor(() => expect(second.getByTestId('chat')).toBeInTheDocument());
    expect(injectProjectConfigInvokeMock).toHaveBeenCalledTimes(1);
    expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(1);
  });

  it('resolves the Codex workspace before injection without using the OpenCode runtime confirmation path', async () => {
    registerConversationPreparation('conv-1', {
      backend: 'codex',
      assistantId: 'assistant-1',
      model: 'gpt-6.1-sol',
      thoughtLevel: 'high',
      initialMessage: { input: 'hello' },
    });
    getConversationOrNullMock.mockResolvedValue({ id: 'conv-1', extra: { workspace: 'C:/core-workspace' } });

    await prepareConversation('conv-1', t);

    expect(injectProjectConfigInvokeMock).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      workspace: 'C:/core-workspace',
      assistantId: 'assistant-1',
    });
    expect(ensureRuntimeInvokeMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('acp_initial_message_conv-1')).toBe(JSON.stringify({ input: 'hello' }));
  });

  it('blocks Codex preparation while its workspace is unavailable', async () => {
    registerConversationPreparation('conv-1', { backend: 'codex', assistantId: 'assistant-1' });

    await expect(prepareConversation('conv-1', t)).rejects.toThrow('workspace');

    expect(injectProjectConfigInvokeMock).not.toHaveBeenCalled();
    expect(getConversationPreparation('conv-1')).not.toBeNull();
  });

  it('does not eagerly start OpenCode when there is no selected thought level', async () => {
    registerOpenCode('conv-1', '');

    await prepareConversation('conv-1', t);

    expect(ensureRuntimeInvokeMock).not.toHaveBeenCalled();
    expect(setConfigOptionInvokeMock).not.toHaveBeenCalled();
  });

  it('does not queue an empty start as a first message', async () => {
    registerConversationPreparation('conv-1', { backend: 'codex', assistantId: 'assistant-1', workspace: 'C:/w' });

    await prepareConversation('conv-1', t);

    expect(getConversationPreparation('conv-1')).toBeNull();
    expect(sessionStorage.getItem('acp_initial_message_conv-1')).toBeNull();
  });

  it("does not resume another account's saved preparation", async () => {
    setAgentModelCatalogScope('account-1');
    registerOpenCode();
    setAgentModelCatalogScope('account-2');

    await expect(prepareConversation('conv-1', t)).rejects.toThrow();

    expect(injectProjectConfigInvokeMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('acp_initial_message_conv-1')).toBeNull();
  });

  it('does not start the CLI or hand over a first message after the account changes during injection', async () => {
    setAgentModelCatalogScope('account-1');
    registerOpenCode();
    let finishInjection!: () => void;
    injectProjectConfigInvokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInjection = () => resolve({ injected: true, files: [] });
        })
    );
    const preparation = prepareConversation('conv-1', t);
    const rejected = expect(preparation).rejects.toThrow();
    setAgentModelCatalogScope('account-2');
    finishInjection();

    await rejected;

    expect(ensureRuntimeInvokeMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('acp_initial_message_conv-1')).toBeNull();
  });

  it('waits for the saved account scope to be restored before preparing a reloaded conversation', async () => {
    setAgentModelCatalogScope('account-1');
    registerOpenCode();
    setAgentModelCatalogScope(null);
    const view = renderPreparation();

    expect(injectProjectConfigInvokeMock).not.toHaveBeenCalled();
    expect(view.queryByTestId('chat')).not.toBeInTheDocument();

    await act(async () => {
      setAgentModelCatalogScope('account-1');
    });

    await waitFor(() => expect(view.getByTestId('chat')).toBeInTheDocument());
  });

  it('prepares once under StrictMode and does not restore an already consumed first message on remount', async () => {
    registerOpenCode();
    let finishInjection!: () => void;
    injectProjectConfigInvokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInjection = () => resolve({ injected: true, files: [] });
        })
    );
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const view = render(
      <React.StrictMode>
        <ConversationPreparation conversationId='conv-1'>
          <Chat conversationId='conv-1' />
        </ConversationPreparation>
      </React.StrictMode>
    );
    await waitFor(() => expect(injectProjectConfigInvokeMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      finishInjection();
    });

    await screen.findByTestId('chat');
    sessionStorage.removeItem('acp_initial_message_conv-1');
    view.unmount();
    renderPreparation();

    expect(injectProjectConfigInvokeMock).toHaveBeenCalledTimes(1);
    expect(ensureRuntimeInvokeMock).toHaveBeenCalledTimes(1);
    expect(setItemSpy.mock.calls.filter(([key]) => key === 'acp_initial_message_conv-1')).toHaveLength(1);
    setItemSpy.mockRestore();
  });

  it('renders existing conversations immediately without injecting or preparing their CLI', () => {
    const view = renderPreparation();

    expect(view.getByTestId('chat')).toBeInTheDocument();
    expect(injectProjectConfigInvokeMock).not.toHaveBeenCalled();
    expect(ensureRuntimeInvokeMock).not.toHaveBeenCalled();
  });

  it('keeps another conversation locked when the previous conversation finishes preparing', async () => {
    registerOpenCode('conv-1');
    registerOpenCode('conv-2');
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    injectProjectConfigInvokeMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = () => resolve({ injected: true, files: [] });
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = () => resolve({ injected: true, files: [] });
          })
      );
    const view = renderPreparation('conv-1');
    await waitFor(() => expect(injectProjectConfigInvokeMock).toHaveBeenCalledTimes(1));
    view.rerender(
      <ConversationPreparation key='conv-2' conversationId='conv-2'>
        <Chat conversationId='conv-2' />
      </ConversationPreparation>
    );
    await waitFor(() => expect(injectProjectConfigInvokeMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      finishFirst();
    });

    expect(view.queryByTestId('chat')).not.toBeInTheDocument();

    await act(async () => {
      finishSecond();
    });

    await waitFor(() => expect(view.getByTestId('chat')).toHaveTextContent('conv-2'));
  });
});
