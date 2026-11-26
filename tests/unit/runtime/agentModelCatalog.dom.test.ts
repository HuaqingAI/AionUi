import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { TChatConversation } from '@/common/config/storage';
import type {
  AcpConfigOptionDto,
  AcpModelInfo,
  EnsureConversationRuntimeResponse,
} from '@/common/types/platform/acpTypes';
import {
  applyConfirmedCodexThoughtLevel,
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

const { ensureRuntimeInvokeMock, conversationGetInvokeMock } = vi.hoisted(() => ({
  ensureRuntimeInvokeMock: vi.fn(),
  conversationGetInvokeMock: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      ensureRuntime: { invoke: ensureRuntimeInvokeMock },
      get: { invoke: conversationGetInvokeMock },
    },
  },
}));

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

function codexRuntimeResponse(thoughtLevel: string | null = null): EnsureConversationRuntimeResponse {
  const response = runtimeResponse(['gpt-6.1-sol']);
  response.config_options[0].current_value = 'gpt-6.1-sol';
  response.config_options.push({
    id: 'reasoning_effort',
    category: 'thought_level',
    type: 'select',
    current_value: thoughtLevel,
    options: ['low', 'medium', 'high'].map((value) => ({ value })),
  });
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureRuntimeInvokeMock.mockReset();
  conversationGetInvokeMock.mockReset();
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
  it('keeps all OpenCode candidates while deriving only GPT candidates for Codex from older data', () => {
    seedAgentModelCatalog({ scope: SCOPE, modelIds: ['deepseek-chat', 'Qwen/Qwen3', 'gpt-5', 'openai/gpt-6', 'gptx'] });
    expect(getAgentModelCatalogSnapshot().initialModelIds).toHaveLength(5);
    expect(getAgentModelCatalogSnapshot().initialCodexModelIds).toEqual(['gpt-5', 'openai/gpt-6']);
  });

  it('does not fall back to all models when the explicit Codex candidate list is empty', () => {
    seedAgentModelCatalog({ scope: SCOPE, modelIds: ['gpt-5', 'deepseek-chat'], codexModelIds: [] });
    expect(getAgentModelCatalogSnapshot().initialCodexModelIds).toEqual([]);
  });

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
      initialCodexModelIds: [],
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

describe('confirmed Codex effort', () => {
  const runtime = { backend: 'codex', model: 'gpt-6.1-sol', thoughtLevel: 'medium' };
  const confirmed = { backend: 'codex', model: 'gpt-6.1-sol', thoughtLevel: 'medium' };
  const snapshot = { version: 1, runtime, confirmed };

  it.each(['cron', 'conversation'])(
    'fills a missing supported effort from actual %s metadata and retains it for later empty catalogs',
    async (source) => {
      const response = codexRuntimeResponse();
      ensureRuntimeInvokeMock.mockResolvedValueOnce(response);
      conversationGetInvokeMock.mockResolvedValueOnce({
        id: 'first',
        extra:
          source === 'cron'
            ? { aionui_cron_runtime: snapshot }
            : { thought_level: 'high', aionui_codex_runtime: { version: 1, confirmed } },
      });

      const result = await ensureConversationRuntime('first');

      expect(result.config_options[1].current_value).toBe('medium');
      expect(response.config_options[1].current_value).toBeNull();
      expect(applyConfirmedCodexThoughtLevel('first', codexRuntimeResponse().config_options)[1].current_value).toBe(
        'medium'
      );
    }
  );

  it.each([
    { thought_level: 'medium' },
    { aionui_codex_runtime: { version: 1 } },
    { aionui_codex_runtime: { version: 2, confirmed } },
    { aionui_codex_runtime: { version: 1, confirmed: { ...confirmed, thoughtLevel: 42 } } },
    { aionui_codex_runtime: { version: 1, confirmed: { ...confirmed, backend: 'opencode' } } },
    { aionui_codex_runtime: { version: 1, confirmed: { ...confirmed, model: 'another-model' } } },
    { aionui_codex_runtime: { version: 1, confirmed: { ...confirmed, thoughtLevel: 'unsupported' } } },
    {
      aionui_codex_runtime: null,
      aionui_cron_runtime: { ...snapshot, runtime: { ...runtime, thoughtLevel: 'high' } },
    },
  ])('does not invent a homepage effort from invalid or unconfirmed metadata: %j', async (extra) => {
    ensureRuntimeInvokeMock.mockResolvedValueOnce(codexRuntimeResponse());
    conversationGetInvokeMock.mockResolvedValueOnce({ id: 'first', extra });

    expect((await ensureConversationRuntime('first')).config_options[1].current_value).toBeNull();
  });

  it.each([
    { cron: snapshot, effort: 'medium' },
    { cron: { ...snapshot, runtime: { backend: 'codex', suppressSkillSuggestion: true } }, effort: 'high' },
  ])(
    'uses the confirmation for the active runtime when ordinary chat and cron share a conversation: %j',
    async ({ cron, effort }) => {
      ensureRuntimeInvokeMock.mockResolvedValueOnce(codexRuntimeResponse());
      conversationGetInvokeMock.mockResolvedValueOnce({
        id: 'first',
        extra: {
          aionui_codex_runtime: { version: 1, confirmed: { ...confirmed, thoughtLevel: 'high' } },
          aionui_cron_runtime: cron,
        },
      });

      expect((await ensureConversationRuntime('first')).config_options[1].current_value).toBe(effort);
    }
  );

  it('waits for native discovery before applying a confirmation cached from an empty initial snapshot', async () => {
    const response = { ...codexRuntimeResponse(), config_options: [] };
    ensureRuntimeInvokeMock.mockResolvedValueOnce(response);
    conversationGetInvokeMock.mockResolvedValueOnce({ id: 'first', extra: { aionui_cron_runtime: snapshot } });

    const result = await ensureConversationRuntime('first');

    expect(result.config_options).toEqual([]);
    expect(applyConfirmedCodexThoughtLevel('first', codexRuntimeResponse().config_options)[1].current_value).toBe(
      'medium'
    );
  });

  it.each([
    { name: 'desired settings without confirmation', metadata: { version: 1, runtime } },
    { name: 'unsupported metadata version', metadata: { ...snapshot, version: 2 } },
    { name: 'malformed confirmed effort', metadata: { ...snapshot, confirmed: { ...confirmed, thoughtLevel: 42 } } },
    { name: 'non-Codex requested runtime', metadata: { ...snapshot, runtime: { ...runtime, backend: 'opencode' } } },
    { name: 'non-Codex confirmation', metadata: { ...snapshot, confirmed: { ...confirmed, backend: 'opencode' } } },
    { name: 'requested model mismatch', metadata: { ...snapshot, runtime: { ...runtime, model: 'another-model' } } },
    { name: 'requested effort mismatch', metadata: { ...snapshot, runtime: { ...runtime, thoughtLevel: 'high' } } },
    {
      name: 'native model mismatch',
      metadata: {
        ...snapshot,
        runtime: { ...runtime, model: 'another-model' },
        confirmed: { ...confirmed, model: 'another-model' },
      },
    },
    {
      name: 'effort absent from the native options',
      metadata: {
        ...snapshot,
        runtime: { ...runtime, thoughtLevel: 'max' },
        confirmed: { ...confirmed, thoughtLevel: 'max' },
      },
    },
  ])('keeps the native snapshot for $name', async ({ metadata }) => {
    const response = codexRuntimeResponse();
    ensureRuntimeInvokeMock.mockResolvedValueOnce(response);
    conversationGetInvokeMock.mockResolvedValueOnce({ id: 'first', extra: { aionui_cron_runtime: metadata } });

    const result = await ensureConversationRuntime('first');

    expect(result).toEqual(response);
  });

  it('preserves a nonempty native effort without reading metadata even after a different effort was confirmed', async () => {
    ensureRuntimeInvokeMock.mockResolvedValueOnce(codexRuntimeResponse());
    conversationGetInvokeMock.mockResolvedValueOnce({ id: 'first', extra: { aionui_cron_runtime: snapshot } });
    await ensureConversationRuntime('first');
    conversationGetInvokeMock.mockClear();
    const response = codexRuntimeResponse('high');
    ensureRuntimeInvokeMock.mockResolvedValueOnce(response);

    const result = await ensureConversationRuntime('first');

    expect(result.config_options[1].current_value).toBe('high');
    expect(conversationGetInvokeMock).not.toHaveBeenCalled();
  });

  it('retains the actual runtime response when the confirmation metadata cannot be read', async () => {
    const response = codexRuntimeResponse();
    ensureRuntimeInvokeMock.mockResolvedValueOnce(response);
    conversationGetInvokeMock.mockRejectedValueOnce(new Error('metadata unavailable'));

    await expect(ensureConversationRuntime('first')).resolves.toEqual(response);
  });

  it.each(['other-account', null])('does not apply a cached confirmation to account scope %s', async (scope) => {
    const response = codexRuntimeResponse();
    ensureRuntimeInvokeMock.mockResolvedValueOnce(response);
    conversationGetInvokeMock.mockResolvedValueOnce({ id: 'first', extra: { aionui_cron_runtime: snapshot } });
    await ensureConversationRuntime('first');
    setAgentModelCatalogScope(scope);

    expect(applyConfirmedCodexThoughtLevel('first', response.config_options)).toBe(response.config_options);
  });

  it('does not read or apply confirmation metadata without an account scope', async () => {
    const response = codexRuntimeResponse();
    ensureRuntimeInvokeMock.mockResolvedValueOnce(response);
    conversationGetInvokeMock.mockResolvedValueOnce({ id: 'first', extra: { aionui_cron_runtime: snapshot } });
    setAgentModelCatalogScope(null);

    await expect(ensureConversationRuntime('first')).resolves.toEqual(response);

    expect(conversationGetInvokeMock).not.toHaveBeenCalled();
  });

  it('does not cache a confirmation that arrives after switching account scope', async () => {
    const response = codexRuntimeResponse();
    const metadata = { id: 'first', extra: { aionui_cron_runtime: snapshot } };
    let complete!: (value: typeof metadata) => void;
    ensureRuntimeInvokeMock.mockResolvedValueOnce(response);
    conversationGetInvokeMock.mockReturnValueOnce(
      new Promise<typeof metadata>((resolve) => {
        complete = resolve;
      })
    );
    const pending = ensureConversationRuntime('first');
    await Promise.resolve();
    setAgentModelCatalogScope('other-account');
    complete(metadata);

    expect(await pending).toEqual(response);
    setAgentModelCatalogScope(SCOPE);
    expect(applyConfirmedCodexThoughtLevel('first', response.config_options)).toBe(response.config_options);
  });
});
