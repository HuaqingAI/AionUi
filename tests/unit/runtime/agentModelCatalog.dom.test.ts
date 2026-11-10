import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { TChatConversation } from '@/common/config/storage';
import type {
  AcpConfigOptionDto,
  AcpModelInfo,
  EnsureConversationRuntimeResponse,
} from '@/common/types/platform/acpTypes';
import {
  ensureConversationRuntime,
  resetEnsureConversationRuntimeStateForTests,
} from '@/renderer/pages/conversation/utils/ensureConversationRuntime';
import {
  getAgentModelCatalogSnapshot,
  observeAgentModelMessage,
  reconcileAgentModelCatalog,
  registerAgentModelConversation,
  seedAgentModelCatalog,
  setAgentModelCatalogScope,
  subscribeAgentModelCatalog,
} from '@/renderer/services/runtime/agentModelCatalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureRuntimeInvokeMock } = vi.hoisted(() => ({ ensureRuntimeInvokeMock: vi.fn() }));
vi.mock('@/common', () => ({ ipcBridge: { conversation: { ensureRuntime: { invoke: ensureRuntimeInvokeMock } } } }));

const SCOPE = 'https://gateway.test|alice';

function conversation(
  id: string,
  createdAt: number,
  backend = 'codex',
  agentId = 'assistant-1'
): Pick<TChatConversation, 'id' | 'created_at' | 'extra'> {
  return { id, created_at: createdAt, extra: { backend, custom_agent_id: agentId } };
}

function modelsMessage(conversationId: string, ids: string[]): IResponseMessage {
  return {
    type: 'acp_model_info',
    conversation_id: conversationId,
    msg_id: 'model-frame',
    data: { current_model_id: ids[0], available_models: ids.map((id) => ({ id, label: id })) },
  };
}

function observedIds(agentId = 'assistant-1'): string[] | undefined {
  return getAgentModelCatalogSnapshot().observed[agentId]?.available_models.map((model) => model.id);
}

function managementInfo(ids: string[]): AcpModelInfo {
  return {
    current_model_id: ids[0] ?? null,
    current_model_label: null,
    available_models: ids.map((id) => ({ id, label: id })),
  };
}

function runtimeResponse(ids: string[]): EnsureConversationRuntimeResponse {
  const configOptions: AcpConfigOptionDto[] = [
    { id: 'model', category: 'model', option_type: 'select', options: ids.map((value) => ({ value })) },
  ];
  return {
    recovered: true,
    config_options: configOptions,
    runtime: {
      state: 'idle',
      can_send_message: true,
      has_task: true,
      is_processing: false,
      pending_confirmations: 0,
      turn_id: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEnsureConversationRuntimeStateForTests();
  setAgentModelCatalogScope(null);
  localStorage.clear();
  setAgentModelCatalogScope(SCOPE);
});

afterEach(() => {
  vi.restoreAllMocks();
  setAgentModelCatalogScope(null);
  localStorage.clear();
});

describe('Agent model catalogs', () => {
  it.each([
    { before: ['a', 'b', 'c'], after: ['a', 'b', 'c', 'd'] },
    { before: ['a', 'b', 'c', 'd'], after: ['a', 'b', 'c'] },
  ])('replaces the previous list when models change from $before.length to $after.length', ({ before, after }) => {
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', before));
    registerAgentModelConversation(conversation('second', 2));
    observeAgentModelMessage(modelsMessage('second', after));

    expect(observedIds()).toEqual(after);
    expect(getAgentModelCatalogSnapshot().observed['assistant-1']).toMatchObject({
      current_model_id: null,
      current_model_label: null,
    });
  });

  it('keeps initial gateway candidates separate from session-observed choices', () => {
    seedAgentModelCatalog({ scope: SCOPE, modelIds: ['initial', 'initial', ''] });
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['discovered']));
    seedAgentModelCatalog({ scope: SCOPE, modelIds: ['late-bootstrap'] });

    expect(getAgentModelCatalogSnapshot().initialModelIds).toEqual(['late-bootstrap']);
    expect(observedIds()).toEqual(['discovered']);
  });

  it('accepts display and thinking metadata for a cached initial list and clears it on account change', () => {
    seedAgentModelCatalog({ scope: SCOPE, modelIds: ['initial'] });
    const codexConfigOptions = [
      {
        id: 'reasoning_effort',
        category: 'thought_level',
        type: 'select' as const,
        current_value: 'high',
        options: [{ value: 'high', name: 'High' }],
      },
    ];
    seedAgentModelCatalog({
      scope: SCOPE,
      modelIds: ['initial'],
      modelLabels: { initial: 'HTH/INITIAL x2.2' },
      codexConfigOptions,
      opencodeConfigOptions: [{ ...codexConfigOptions[0], id: 'effort' }],
    });
    expect(getAgentModelCatalogSnapshot().initialCodexConfigOptions).toEqual(codexConfigOptions);
    expect(getAgentModelCatalogSnapshot().initialModelLabels).toEqual({ initial: 'HTH/INITIAL x2.2' });
    expect(getAgentModelCatalogSnapshot().initialOpenCodeConfigOptions[0].id).toBe('effort');
    setAgentModelCatalogScope('another-account');
    expect(getAgentModelCatalogSnapshot().initialCodexConfigOptions).toEqual([]);
    expect(getAgentModelCatalogSnapshot().initialModelLabels).toEqual({});
    expect(getAgentModelCatalogSnapshot().initialOpenCodeConfigOptions).toEqual([]);
  });

  it('ignores older conversations even before a newer one reports models or after the older one remounts', () => {
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['a', 'b', 'c']));
    registerAgentModelConversation(conversation('second', 2));
    observeAgentModelMessage(modelsMessage('first', ['old']));
    expect(observedIds()).toEqual(['a', 'b', 'c']);

    observeAgentModelMessage(modelsMessage('second', ['a', 'b', 'c', 'd']));
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['old']));
    expect(observedIds()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('uses conversation ID order to resolve equal creation timestamps independently of mounting order', () => {
    registerAgentModelConversation(conversation('z', 1));
    registerAgentModelConversation(conversation('a', 1));
    observeAgentModelMessage(modelsMessage('z', ['newer']));
    observeAgentModelMessage(modelsMessage('a', ['older']));

    expect(observedIds()).toEqual(['newer']);
  });

  it('isolates accounts, rejects late bootstrap results, and restores observed choices on return', () => {
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['alice-model']));
    setAgentModelCatalogScope('bob');
    seedAgentModelCatalog({ scope: SCOPE, modelIds: ['alice-bootstrap'] });
    observeAgentModelMessage(modelsMessage('first', ['leaked']));
    expect(getAgentModelCatalogSnapshot()).toEqual({
      scope: 'bob',
      initialModelIds: [],
      initialModelLabels: {},
      initialCodexConfigOptions: [],
      initialOpenCodeConfigOptions: [],
      observed: {},
    });

    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['bob-model']));
    setAgentModelCatalogScope(SCOPE);
    expect(observedIds()).toEqual(['alice-model']);
    setAgentModelCatalogScope('bob');
    expect(observedIds()).toEqual(['bob-model']);
  });

  it('retains conversation ordering after restoring persistent choices', () => {
    registerAgentModelConversation(conversation('second', 2));
    observeAgentModelMessage(modelsMessage('second', ['a', 'b', 'c', 'd']));
    setAgentModelCatalogScope(null);
    setAgentModelCatalogScope(SCOPE);
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['a', 'b', 'c']));

    expect(observedIds()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('persists newer conversation ownership even if its models are unchanged', () => {
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['a']));
    registerAgentModelConversation(conversation('second', 2));
    observeAgentModelMessage(modelsMessage('second', ['a']));
    setAgentModelCatalogScope(null);
    setAgentModelCatalogScope(SCOPE);
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['old']));

    expect(observedIds()).toEqual(['a']);
  });

  it('accepts model config options and only retains HTH OpenCode models', () => {
    registerAgentModelConversation(conversation('opencode', 1, 'opencode'));
    observeAgentModelMessage({
      type: 'acp_config_option',
      conversation_id: 'opencode',
      msg_id: 'config-frame',
      data: JSON.stringify({
        config_options: [
          {
            id: 'model',
            category: 'model',
            option_type: 'select',
            current_value: 'other/model',
            options: [{ value: 'other/model' }, { value: 'hth/model', name: 'HTH model', description: 'Available' }],
          },
        ],
      }),
    });

    expect(getAgentModelCatalogSnapshot().observed['assistant-1']).toEqual({
      current_model_id: null,
      current_model_label: null,
      available_models: [{ id: 'hth/model', label: 'HTH model', description: 'Available' }],
    });
  });

  it('prefers the conversation Agent identity over a caller fallback', () => {
    const actual = conversation('first', 1);
    (actual.extra as Record<string, unknown>).agent_id = 'actual';
    registerAgentModelConversation(actual, { agentId: 'fallback', backend: 'codex' });
    observeAgentModelMessage(modelsMessage('first', ['model']));

    expect(observedIds('actual')).toEqual(['model']);
    expect(observedIds('fallback')).toBeUndefined();
  });

  it('uses the resolved backend when legacy conversation metadata disagrees', () => {
    registerAgentModelConversation(conversation('first', 1, 'legacy'), { backend: 'codex' });
    observeAgentModelMessage(modelsMessage('first', ['model']));

    expect(observedIds()).toEqual(['model']);
  });

  it.each([
    { type: 'acp_model_info', data: null },
    { type: 'acp_model_info', data: '{broken' },
    { type: 'acp_model_info', data: { current_model_id: 'changed' } },
    { type: 'acp_model_info', data: { available_models: [] } },
    { type: 'acp_model_info', data: { available_models: [{ id: 'valid' }, null] } },
    { type: 'acp_config_option', data: [{ id: 'model', type: 'select', options: [{ value: 'wrong' }] }] },
    { type: 'acp_config_option', data: [{ id: 'model', category: 'model', type: 'select', options: [] }] },
    {
      type: 'acp_config_option',
      data: [{ id: 'model', category: 'model', type: 'boolean', options: [{ value: 'wrong' }] }],
    },
    { type: 'codex_model_info', data: { model: 'changed' } },
  ])('ignores incomplete or malformed $type payloads: $data', ({ type, data }) => {
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['original']));
    const original = getAgentModelCatalogSnapshot();
    observeAgentModelMessage({ type, data, conversation_id: 'first', msg_id: 'invalid-frame' });

    expect(getAgentModelCatalogSnapshot()).toBe(original);
  });

  it('ignores unsupported backends and unregistered conversations', () => {
    registerAgentModelConversation(conversation('claude', 1, 'claude'));
    observeAgentModelMessage(modelsMessage('claude', ['model']));
    observeAgentModelMessage(modelsMessage('missing', ['model']));

    expect(getAgentModelCatalogSnapshot().observed).toEqual({});
  });

  it.each([
    '{broken',
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({
      version: 1,
      entries: [
        null,
        {
          id: 'first',
          agentId: 'assistant-1',
          backend: 'codex',
          createdAt: 1,
          modelInfo: { available_models: [{ id: '' }] },
        },
      ],
    }),
  ])('ignores invalid persisted catalogs: %s', (stored) => {
    vi.spyOn(localStorage, 'getItem').mockReturnValue(stored);
    setAgentModelCatalogScope('corrupt');

    expect(getAgentModelCatalogSnapshot().observed).toEqual({});
  });

  it('keeps initial gateway candidates in memory until a session observes them', () => {
    seedAgentModelCatalog({ scope: SCOPE, modelIds: ['initial'] });
    setAgentModelCatalogScope(null);
    setAgentModelCatalogScope(SCOPE);

    expect(getAgentModelCatalogSnapshot().initialModelIds).toEqual([]);
    expect(getAgentModelCatalogSnapshot().observed).toEqual({});
  });

  it('tolerates failures reading or writing storage', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    setAgentModelCatalogScope('unavailable');
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['still-usable']));

    expect(observedIds()).toEqual(['still-usable']);
  });

  it('notifies subscribers only when the visible snapshot changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAgentModelCatalog(listener);
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['model']));
    const current = getAgentModelCatalogSnapshot();
    observeAgentModelMessage(modelsMessage('first', ['model']));
    expect(getAgentModelCatalogSnapshot()).toBe(current);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    seedAgentModelCatalog({ scope: SCOPE, modelIds: ['initial'] });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('Core catalog reconciliation', () => {
  it('keeps newer session models while Core still reports the previous baseline, including reordered lists', () => {
    reconcileAgentModelCatalog('assistant-1', managementInfo(['a', 'b', 'c']));
    registerAgentModelConversation(conversation('second', 2));
    observeAgentModelMessage(modelsMessage('second', ['a', 'b', 'c', 'd']));
    reconcileAgentModelCatalog('assistant-1', managementInfo(['c', 'b', 'a']));

    expect(observedIds()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('acknowledges matching write-back and then accepts a subsequent management deletion', () => {
    reconcileAgentModelCatalog('assistant-1', managementInfo(['a', 'b', 'c']));
    registerAgentModelConversation(conversation('second', 2));
    observeAgentModelMessage(modelsMessage('second', ['a', 'b', 'c', 'd']));
    reconcileAgentModelCatalog('assistant-1', managementInfo(['a', 'b', 'c', 'd']));
    reconcileAgentModelCatalog('assistant-1', managementInfo(['a', 'b', 'c']));

    expect(observedIds()).toEqual(['a', 'b', 'c']);
  });

  it.each([
    { before: ['a', 'b', 'c'], after: ['a', 'b', 'c', 'd'] },
    { before: ['a', 'b', 'c', 'd'], after: ['a', 'b', 'c'] },
  ])('recovers a lost session model frame from a changed management catalog: $after', ({ before, after }) => {
    reconcileAgentModelCatalog('assistant-1', managementInfo(before));
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', before));
    reconcileAgentModelCatalog('assistant-1', managementInfo(after));

    expect(observedIds()).toEqual(after);
  });

  it('preserves the baseline across restart so stored models cannot mask a changed Core catalog', () => {
    reconcileAgentModelCatalog('assistant-1', managementInfo(['a', 'b', 'c']));
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['a', 'b', 'c']));
    setAgentModelCatalogScope(null);
    setAgentModelCatalogScope(SCOPE);
    reconcileAgentModelCatalog('assistant-1', managementInfo(['a', 'b', 'c', 'd']));

    expect(observedIds()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('establishes a first management baseline without overwriting an unacknowledged session list', () => {
    registerAgentModelConversation(conversation('second', 2));
    observeAgentModelMessage(modelsMessage('second', ['a', 'b', 'c', 'd']));
    reconcileAgentModelCatalog('assistant-1', managementInfo(['a', 'b', 'c']));

    expect(observedIds()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not clear a complete session list when management has no models', () => {
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['a']));
    const current = getAgentModelCatalogSnapshot();
    reconcileAgentModelCatalog('assistant-1', managementInfo([]));

    expect(getAgentModelCatalogSnapshot()).toBe(current);
  });
});

describe('runtime preparation model snapshots', () => {
  it('captures OpenCode models returned after successful runtime preparation even without a stream frame', async () => {
    registerAgentModelConversation(conversation('first', 1, 'opencode'));
    observeAgentModelMessage(modelsMessage('first', ['hth/a', 'hth/b', 'hth/c']));
    registerAgentModelConversation(conversation('second', 2, 'opencode'));
    ensureRuntimeInvokeMock.mockResolvedValueOnce(runtimeResponse(['hth/a', 'hth/b', 'hth/c', 'hth/d']));
    await ensureConversationRuntime('second');

    expect(observedIds()).toEqual(['hth/a', 'hth/b', 'hth/c', 'hth/d']);
  });

  it('ignores Codex HTTP snapshots because their model list can still be preloaded', async () => {
    registerAgentModelConversation(conversation('first', 1));
    observeAgentModelMessage(modelsMessage('first', ['a', 'b', 'c', 'd']));
    ensureRuntimeInvokeMock.mockResolvedValueOnce(runtimeResponse(['a', 'b', 'c']));
    await ensureConversationRuntime('first');

    expect(observedIds()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects an OpenCode snapshot that arrives after switching account scope', async () => {
    let complete!: (response: EnsureConversationRuntimeResponse) => void;
    ensureRuntimeInvokeMock.mockReturnValueOnce(
      new Promise<EnsureConversationRuntimeResponse>((resolve) => {
        complete = resolve;
      })
    );
    registerAgentModelConversation(conversation('first', 1, 'opencode'));
    const pending = ensureConversationRuntime('first');
    setAgentModelCatalogScope('other-account');
    registerAgentModelConversation(conversation('first', 1, 'opencode'));
    complete(runtimeResponse(['hth/private-model']));
    await pending;

    expect(observedIds()).toBeUndefined();
  });

  it('keeps prior models when runtime preparation fails', async () => {
    registerAgentModelConversation(conversation('first', 1, 'opencode'));
    observeAgentModelMessage(modelsMessage('first', ['hth/a']));
    ensureRuntimeInvokeMock.mockRejectedValueOnce(new Error('startup failed'));

    await expect(ensureConversationRuntime('first')).rejects.toThrow('startup failed');
    expect(observedIds()).toEqual(['hth/a']);
  });
});
