/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';
import {
  observeAgentModelMessage,
  registerAgentModelConversation,
  seedAgentModelCatalog,
  setAgentModelCatalogScope,
} from '@/renderer/services/runtime/agentModelCatalog';
import {
  buildAgentRuntimeModeState,
  buildAgentRuntimeModelInfo,
  buildAgentRuntimeSlashCommands,
  buildAssistantModelInfo,
  resolveInitialAssistantModel,
  useGuidAssistantSelection,
} from '@/renderer/pages/guid/hooks/useGuidAssistantSelection';

let mockAssistants: Assistant[] = [];
let mockManagedAgents: ManagedAgent[] = [];

const { configGetMock, configSetMock } = vi.hoisted(() => ({
  configGetMock: vi.fn(),
  configSetMock: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    set: configSetMock,
  },
}));

vi.mock('@/renderer/pages/guid/hooks/useCustomAgentsLoader', () => ({
  useCustomAgentsLoader: () => ({
    assistants: mockAssistants,
  }),
}));

vi.mock('@/renderer/hooks/agent/useManagedAgents', () => ({
  useManagedAgentRuntimeCatalog: () => mockManagedAgents,
}));

describe('useGuidAssistantSelection', () => {
  beforeEach(() => {
    setAgentModelCatalogScope(null);
    localStorage.clear();
    configGetMock.mockReturnValue(undefined);
    configSetMock.mockResolvedValue(undefined);
    mockManagedAgents = [];
    mockAssistants = [
      {
        id: 'assistant-claude',
        source: 'builtin',
        name: 'Claude Assistant',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 1,
        agent_id: 'agent-claude',
        agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' },
        enabled_skills: [],
        custom_skill_names: [],
        disabled_builtin_skills: [],
        context_i18n: {},
        prompts: [],
        prompts_i18n: {},
        models: ['claude-opus', 'claude-sonnet'],
        agent_status: 'online',
        team_selectable: true,
        deletable: false,
      } satisfies Assistant,
    ];
  });

  it.each(['codex', 'opencode'])(
    'defaults first-use %s to Sol and exposes selectable reasoning levels',
    async (backend) => {
      mockAssistants = [assistantFixture({ id: 'hth-first-use', runtimeKey: backend, source: 'user', sortOrder: 1 })];
      setAgentModelCatalogScope('first-use');
      seedAgentModelCatalog({
        scope: 'first-use',
        modelIds: ['gpt-5.6-terra', 'gpt-6.1-sol', 'model-c'],
        modelLabels: { 'gpt-5.6-terra': 'HTH/GPT-5.6-TERRA x18.7' },
        codexConfigOptions: [
          {
            id: 'reasoning_effort',
            category: 'thought_level',
            type: 'select',
            current_value: 'high',
            options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })),
          },
        ],
        opencodeConfigOptions: [
          {
            id: 'effort',
            category: 'thought_level',
            type: 'select',
            current_value: 'high',
            options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })),
          },
        ],
      });
      const { result } = renderHook(() => useGuidAssistantSelection({}));

      await waitFor(() => expect(result.current.currentAcpCachedModelInfo?.available_models).toHaveLength(3));
      expect(result.current.currentAcpCachedModelInfo?.available_models[0].id).toBe(
        backend === 'opencode' ? 'hth/gpt-5.6-terra' : 'gpt-5.6-terra'
      );
      expect(result.current.selectedAcpModel).toBe(backend === 'opencode' ? 'hth/gpt-6.1-sol' : 'gpt-6.1-sol');
      expect(result.current.currentAcpCachedModelInfo?.available_models[0].label).toBe('HTH/GPT-5.6-TERRA x18.7');
      expect(result.current.currentAcpCachedModelInfo?.available_models[1].label).toBe('HTH/GPT-6.1-SOL');
      expect(result.current.currentThoughtLevelOption?.options.map((option) => option.value) ?? []).toEqual([
        'low',
        'medium',
        'high',
      ]);
      expect(result.current.currentThoughtLevelOption?.id).toBe(backend === 'opencode' ? 'effort' : 'reasoning_effort');
      expect(result.current.selectedThoughtLevelValue).toBe('high');
      act(() => result.current.setSelectedThoughtLevelValue('low'));
      expect(result.current.currentThoughtLevelOption?.currentValue).toBe('low');
    }
  );

  it.each(['codex', 'opencode'])(
    'replaces initial %s thinking choices with real session capabilities',
    async (backend) => {
      mockAssistants = [assistantFixture({ id: `hth-${backend}`, runtimeKey: backend, source: 'user', sortOrder: 1 })];
      setAgentModelCatalogScope('thinking-capabilities');
      seedAgentModelCatalog({
        scope: 'thinking-capabilities',
        modelIds: ['gpt-5.6-terra'],
        codexConfigOptions: [
          {
            id: 'reasoning_effort',
            category: 'thought_level',
            type: 'select',
            current_value: 'high',
            options: [{ value: 'high', name: 'High' }],
          },
        ],
        opencodeConfigOptions: [
          {
            id: 'effort',
            category: 'thought_level',
            type: 'select',
            current_value: 'high',
            options: [{ value: 'high', name: 'High' }],
          },
        ],
      });
      const { result, rerender } = renderHook(() => useGuidAssistantSelection({}));
      await waitFor(() => expect(result.current.currentThoughtLevelOption?.options[0].value).toBe('high'));
      mockManagedAgents = [
        {
          id: `agent-${backend}`,
          config_options: [
            {
              id: backend === 'opencode' ? 'effort' : 'reasoning_effort',
              category: 'thought_level',
              type: 'select',
              current_value: 'xhigh',
              options: [{ value: 'xhigh', label: 'Extra high' }],
            },
          ],
        } as unknown as ManagedAgent,
      ];
      rerender();
      await waitFor(() =>
        expect(result.current.currentThoughtLevelOption?.options.map((option) => option.value)).toEqual(['xhigh'])
      );
      expect(result.current.selectedThoughtLevelValue).toBe('xhigh');
      mockManagedAgents = [
        {
          id: `agent-${backend}`,
          available_models: {
            available_models: [{ id: backend === 'opencode' ? 'hth/gpt-5.6-terra' : 'gpt-5.6-terra', label: 'Terra' }],
          },
          config_options: [],
        } as unknown as ManagedAgent,
      ];
      rerender();
      await waitFor(() =>
        expect(result.current.currentThoughtLevelOption?.currentValue ?? null).toBe(
          backend === 'opencode' ? 'high' : null
        )
      );
      expect(result.current.selectedThoughtLevelValue).toBe(backend === 'opencode' ? 'high' : '');
    }
  );

  it.each(['codex', 'opencode'])(
    'uses the %s product default while preserving a valid manual selection',
    async (backend) => {
      const prefix = backend === 'opencode' ? 'hth/' : '';
      const sol = `${prefix}gpt-6.1-sol`;
      const terra = `${prefix}gpt-5.6-terra`;
      mockAssistants = [assistantFixture({ id: `hth-${backend}`, runtimeKey: backend, source: 'user', sortOrder: 1 })];
      mockManagedAgents = [
        {
          id: `agent-${backend}`,
          available_models: {
            current_model_id: terra,
            available_models: [sol, terra].map((id) => ({ id, label: id })),
          },
        } as unknown as ManagedAgent,
      ];
      const { result, rerender } = renderHook(() => useGuidAssistantSelection({}));
      await waitFor(() => expect(result.current.selectedAcpModel).toBe(sol));
      act(() => result.current.setSelectedAcpModel(terra));
      mockManagedAgents = [
        {
          id: `agent-${backend}`,
          available_models: { available_models: [sol, terra, `${prefix}another`].map((id) => ({ id, label: id })) },
        } as unknown as ManagedAgent,
      ];
      rerender();
      expect(result.current.selectedAcpModel).toBe(terra);
      mockManagedAgents = [
        {
          id: `agent-${backend}`,
          available_models: { available_models: [{ id: sol, label: sol }] },
        } as unknown as ManagedAgent,
      ];
      rerender();
      await waitFor(() => expect(result.current.selectedAcpModel).toBe(sol));
      mockManagedAgents = [
        {
          id: `agent-${backend}`,
          available_models: { available_models: [{ id: `${prefix}another`, label: 'Another' }] },
        } as unknown as ManagedAgent,
      ];
      rerender();
      await waitFor(() => expect(result.current.selectedAcpModel).toBeNull());
    }
  );

  it.each(['opencode', 'codex'])(
    'defaults another %s assistant to High after the shared runtime reports Low',
    async (backend) => {
      mockAssistants = ['general', 'logistics'].map((name, index) =>
        assistantFixture({ id: `hth-${name}`, runtimeKey: backend, source: 'user', sortOrder: index + 1 })
      );
      const runtime = {
        id: `agent-${backend}`,
        config_options: [
          {
            id: backend === 'opencode' ? 'effort' : 'reasoning_effort',
            category: 'thought_level',
            type: 'select',
            current_value: 'low',
            options: ['low', 'medium', 'high'].map((value) => ({ value, label: value })),
          },
        ],
      } as unknown as ManagedAgent;
      mockManagedAgents = [runtime];
      const { result, rerender } = renderHook(() => useGuidAssistantSelection({}));

      await waitFor(() => expect(result.current.selectedThoughtLevelValue).toBe('high'));
      act(() => result.current.setSelectedThoughtLevelValue('low'));
      mockManagedAgents = [{ ...runtime }];
      rerender();
      expect(result.current.selectedThoughtLevelValue).toBe('low');

      act(() => result.current.setSelectedAssistantId('hth-logistics'));
      await waitFor(() => expect(result.current.selectedThoughtLevelValue).toBe('high'));
      expect(result.current.currentThoughtLevelOption?.options.map(({ value }) => value)).toEqual([
        'low',
        'medium',
        'high',
      ]);

      mockManagedAgents = [
        {
          id: `agent-${backend}`,
          config_options: [
            {
              id: backend === 'opencode' ? 'effort' : 'reasoning_effort',
              category: 'thought_level',
              type: 'select',
              current_value: 'medium',
              options: ['low', 'medium'].map((value) => ({ value, label: value })),
            },
          ],
        } as unknown as ManagedAgent,
      ];
      rerender();
      await waitFor(() => expect(result.current.selectedThoughtLevelValue).toBe('medium'));
      expect(result.current.currentThoughtLevelOption?.options.map(({ value }) => value)).toEqual(['low', 'medium']);
    }
  );

  it('mounts with High when Core omits the empty assistant models field', async () => {
    mockAssistants = JSON.parse(
      JSON.stringify([
        {
          ...assistantFixture({ id: 'hth-opencode', runtimeKey: 'opencode', source: 'user', sortOrder: 1 }),
          models: undefined,
        },
      ])
    ) as Assistant[];
    mockManagedAgents = [
      {
        id: 'agent-opencode',
        config_options: [
          {
            id: 'effort',
            category: 'thought_level',
            type: 'select',
            current_value: 'low',
            options: ['low', 'medium', 'high'].map((value) => ({ value, label: value })),
          },
        ],
      } as unknown as ManagedAgent,
    ];

    const { result } = renderHook(() => useGuidAssistantSelection({}));

    await waitFor(() => expect(result.current.selectedThoughtLevelValue).toBe('high'));
  });

  it.each(['hth-opencode', 'manual-opencode'])(
    'only restores the OpenCode policy for imported legacy catalogs (%s)',
    async (id) => {
      mockAssistants = [assistantFixture({ id, runtimeKey: 'opencode', source: 'user', sortOrder: 1 })];
      mockManagedAgents = [
        {
          id: 'agent-opencode',
          config_options: [{ id: 'effort', category: 'thought_level', type: 'select', options: [] }],
          available_models: { available_models: [{ id: 'hth/gpt-6.1-sol', label: 'Real Sol' }] },
        } as unknown as ManagedAgent,
      ];
      setAgentModelCatalogScope('legacy-opencode');
      seedAgentModelCatalog({
        scope: 'legacy-opencode',
        modelIds: ['gpt-6.1-sol'],
        opencodeConfigOptions: [
          {
            id: 'effort',
            category: 'thought_level',
            type: 'select',
            current_value: 'high',
            options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })),
          },
        ],
      });
      const { result } = renderHook(() => useGuidAssistantSelection({}));
      await waitFor(() => expect(result.current.currentAcpCachedModelInfo?.available_models[0].label).toBe('Real Sol'));
      expect(result.current.currentThoughtLevelOption?.options.map((option) => option.value) ?? []).toEqual(
        id.startsWith('hth-') ? ['low', 'medium', 'high'] : []
      );
      expect(result.current.selectedThoughtLevelValue).toBe(id.startsWith('hth-') ? 'high' : '');
    }
  );

  it('shows the newest real session catalog on Guid even while Core still has the previous list', async () => {
    mockAssistants = [assistantFixture({ id: 'hth-codex', runtimeKey: 'codex', source: 'user', sortOrder: 1 })];
    setAgentModelCatalogScope('live-models');
    seedAgentModelCatalog({ scope: 'live-models', modelIds: ['gpt-5.6-terra', 'model-b', 'model-c'] });
    const { result } = renderHook(() => useGuidAssistantSelection({}));
    await waitFor(() => expect(result.current.currentAcpCachedModelInfo?.available_models).toHaveLength(3));

    mockManagedAgents = [
      {
        id: 'agent-codex',
        available_models: {
          available_models: ['gpt-5.6-terra', 'model-b', 'model-c'].map((id) => ({ id, label: id })),
        },
      } as unknown as ManagedAgent,
    ];
    act(() => {
      registerAgentModelConversation({
        id: 'second-session',
        created_at: 2,
        extra: { workspace: '', backend: 'codex', custom_agent_id: 'agent-codex' },
      });
      observeAgentModelMessage({
        msg_id: 'catalog-second-session',
        conversation_id: 'second-session',
        type: 'acp_model_info',
        data: {
          current_model_id: 'gpt-5.6-terra',
          available_models: ['gpt-5.6-terra', 'model-b', 'model-c', 'model-d'].map((id) => ({ id, label: id })),
        },
      });
    });

    expect(result.current.currentAcpCachedModelInfo?.available_models).toHaveLength(4);
    expect(result.current.selectedAcpModel).toBeNull();
  });

  it.each([
    { modelIds: ['gpt-5.6-terra', 'model-b', 'model-c', 'model-d'] },
    { modelIds: ['gpt-5.6-terra', 'model-c'] },
  ])('uses the later Core session catalog when a model push was missed ($modelIds)', async ({ modelIds }) => {
    const initialIds = ['gpt-5.6-terra', 'model-b', 'model-c'];
    const initialCatalog = {
      current_model_id: null,
      current_model_label: null,
      available_models: initialIds.map((id) => ({ id, label: id })),
    };
    mockAssistants = [assistantFixture({ id: 'hth-codex', runtimeKey: 'codex', source: 'user', sortOrder: 1 })];
    mockManagedAgents = [{ id: 'agent-codex', available_models: initialCatalog } as unknown as ManagedAgent];
    setAgentModelCatalogScope('missed-push');
    const firstHome = renderHook(() => useGuidAssistantSelection({}));
    await waitFor(() => expect(firstHome.result.current.currentAcpCachedModelInfo?.available_models).toHaveLength(3));
    act(() => {
      registerAgentModelConversation({
        id: 'first-session',
        created_at: 1,
        extra: { workspace: '', backend: 'codex', custom_agent_id: 'agent-codex' },
      });
      observeAgentModelMessage({
        msg_id: 'catalog-first-session',
        conversation_id: 'first-session',
        type: 'acp_model_info',
        data: initialCatalog,
      });
    });
    firstHome.unmount();
    registerAgentModelConversation({
      id: 'second-session',
      created_at: 2,
      extra: { workspace: '', backend: 'codex', custom_agent_id: 'agent-codex' },
    });
    mockManagedAgents = [
      {
        id: 'agent-codex',
        available_models: { available_models: modelIds.map((id) => ({ id, label: id })) },
      } as unknown as ManagedAgent,
    ];
    const { result } = renderHook(() => useGuidAssistantSelection({}));
    await waitFor(() =>
      expect(result.current.currentAcpCachedModelInfo?.available_models.map((model) => model.id)).toEqual(modelIds)
    );
  });

  it('derives availability and model info from assistant catalog data', async () => {
    const { result } = renderHook(() =>
      useGuidAssistantSelection({
        resetAssistant: false,
      })
    );

    await waitFor(() => {
      expect(result.current.selectedAssistantId).toBe('assistant-claude');
    });

    expect(result.current.selectedAssistantAvailable).toBe(true);
    expect(result.current.selectedAcpModel).toBe('claude-opus');
    expect(result.current.currentAcpCachedModelInfo).toEqual({
      current_model_id: 'claude-opus',
      current_model_label: 'claude-opus',
      available_models: [
        { id: 'claude-opus', label: 'claude-opus' },
        { id: 'claude-sonnet', label: 'claude-sonnet' },
      ],
    });
  });

  it('restores the last selected guid assistant before falling back to the aionrs default', async () => {
    mockAssistants = [
      assistantFixture({ id: 'bare-aionrs', runtimeKey: 'aionrs', source: 'generated', sortOrder: 1 }),
      assistantFixture({ id: 'assistant-claude', runtimeKey: 'claude', source: 'builtin', sortOrder: 2 }),
    ];
    configGetMock.mockImplementation((key: string) =>
      key === 'guid.lastAssistantId' ? 'assistant-claude' : undefined
    );

    const { result } = renderHook(() =>
      useGuidAssistantSelection({
        resetAssistant: false,
      })
    );

    await waitFor(() => {
      expect(result.current.selectedAssistantId).toBe('assistant-claude');
    });
  });

  it('restores the last selected guid assistant when the guid page resets for a new chat', async () => {
    mockAssistants = [
      assistantFixture({ id: 'bare-aionrs', runtimeKey: 'aionrs', source: 'generated', sortOrder: 1 }),
      assistantFixture({ id: 'assistant-claude', runtimeKey: 'claude', source: 'builtin', sortOrder: 2 }),
    ];
    configGetMock.mockImplementation((key: string) =>
      key === 'guid.lastAssistantId' ? 'assistant-claude' : undefined
    );

    const { result } = renderHook(() =>
      useGuidAssistantSelection({
        resetAssistant: true,
        locationKey: 'new-chat',
      })
    );

    await waitFor(() => {
      expect(result.current.selectedAssistantId).toBe('assistant-claude');
    });
  });

  it('persists manual guid assistant selections for the next visit', async () => {
    mockAssistants = [
      assistantFixture({ id: 'bare-aionrs', runtimeKey: 'aionrs', source: 'generated', sortOrder: 1 }),
      assistantFixture({ id: 'assistant-claude', runtimeKey: 'claude', source: 'builtin', sortOrder: 2 }),
    ];

    const { result } = renderHook(() =>
      useGuidAssistantSelection({
        resetAssistant: false,
      })
    );

    await waitFor(() => {
      expect(result.current.selectedAssistantId).toBe('bare-aionrs');
    });

    act(() => {
      result.current.setSelectedAssistantId('assistant-claude');
    });

    expect(configSetMock).toHaveBeenCalledWith('guid.lastAssistantId', 'assistant-claude');
  });

  it('falls back to the default assistant when the persisted guid assistant no longer exists', async () => {
    mockAssistants = [
      assistantFixture({ id: 'bare-aionrs', runtimeKey: 'aionrs', source: 'generated', sortOrder: 1 }),
      assistantFixture({ id: 'assistant-claude', runtimeKey: 'claude', source: 'builtin', sortOrder: 2 }),
    ];
    configGetMock.mockImplementation((key: string) =>
      key === 'guid.lastAssistantId' ? 'removed-assistant' : undefined
    );

    const { result } = renderHook(() =>
      useGuidAssistantSelection({
        resetAssistant: false,
      })
    );

    await waitFor(() => {
      expect(result.current.selectedAssistantId).toBe('bare-aionrs');
    });
  });

  it('does not synthesize a backend slug when no assistants exist', async () => {
    vi.resetModules();
    vi.doMock('@/renderer/pages/guid/hooks/useCustomAgentsLoader', () => ({
      useCustomAgentsLoader: () => ({
        assistants: [],
      }),
    }));

    const { useGuidAssistantSelection: useSelectionWithoutAssistants } =
      await import('@/renderer/pages/guid/hooks/useGuidAssistantSelection');

    const { result } = renderHook(() =>
      useSelectionWithoutAssistants({
        resetAssistant: false,
      })
    );

    await waitFor(() => {
      expect(result.current.selectedAssistantId).toBeNull();
    });

    expect(result.current.defaultAssistantId).toBeNull();
    expect(result.current.selectedAssistantBackend).toBe('');
    expect(result.current.selectedAssistantAvailable).toBe(false);

    vi.doUnmock('@/renderer/pages/guid/hooks/useCustomAgentsLoader');
    vi.resetModules();
  });

  it('uses the selected assistant agent_id to read runtime catalogs from managed agents', async () => {
    mockAssistants = [
      {
        id: 'custom-1781258588874-26ad',
        source: 'user',
        name: '文件规划助手 (Copy)',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 1,
        agent_id: '2d23ff1c',
        agent: {
          type: 'acp',
          source: 'builtin',
          acp_backend: 'claude',
        },
        enabled_skills: [],
        custom_skill_names: [],
        disabled_builtin_skills: [],
        context_i18n: {},
        prompts: [],
        prompts_i18n: {},
        models: [],
        agent_status: 'online',
        team_selectable: true,
        deletable: true,
      } satisfies Assistant,
    ];
    mockManagedAgents = [
      {
        id: '2d23ff1c',
        backend: 'claude',
        available_models: {
          current_model_id: 'global.anthropic.claude-opus-4-8',
          current_model_label: 'Opus 4.8',
          available_models: [
            { id: 'default', label: 'Default' },
            { id: 'global.anthropic.claude-opus-4-8', label: 'Opus 4.8' },
          ],
        },
        available_modes: {
          current_mode_id: 'bypassPermissions',
          available_modes: [
            { id: 'default', name: 'Default' },
            { id: 'bypassPermissions', name: 'Bypass Permissions' },
          ],
        },
      } as unknown as ManagedAgent,
    ];

    const { result } = renderHook(() =>
      useGuidAssistantSelection({
        resetAssistant: false,
      })
    );

    await waitFor(() => {
      expect(result.current.selectedAssistantId).toBe('custom-1781258588874-26ad');
    });

    // The catalog is READ from the right agent, but it must NOT become a selection: its
    // `current_model_id` is whatever the agent's last session wrote back, not this user's
    // intent. Seeding it made every fresh conversation inherit a stranger's pick — for
    // claude usually its `default` row, which pins the account default and overrides the
    // user's own ANTHROPIC_MODEL, so the app ran a different model than the CLI did.
    expect(result.current.selectedAcpModel).toBeNull();
    expect(result.current.currentAcpCachedModelInfo).toEqual({
      current_model_id: 'global.anthropic.claude-opus-4-8',
      current_model_label: 'Opus 4.8',
      available_models: [
        { id: 'default', label: 'Default' },
        { id: 'global.anthropic.claude-opus-4-8', label: 'Opus 4.8' },
      ],
    });
    expect(result.current.selectedMode).toBe('bypassPermissions');
    expect(result.current.currentAgentModeOptions).toEqual([
      { value: 'default', label: 'Default', description: undefined },
      { value: 'bypassPermissions', label: 'Bypass Permissions', description: undefined },
    ]);
  });

  it('keeps the full runtime model list when assistant models only contain a default', async () => {
    mockAssistants = [
      {
        id: 'assistant-with-default-model',
        source: 'user',
        name: 'Assistant With Default Model',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 1,
        agent_id: 'agent-claude',
        agent: {
          type: 'acp',
          source: 'builtin',
          acp_backend: 'claude',
        },
        enabled_skills: [],
        custom_skill_names: [],
        disabled_builtin_skills: [],
        context_i18n: {},
        prompts: [],
        prompts_i18n: {},
        models: ['default'],
        agent_status: 'online',
        team_selectable: true,
        deletable: true,
      } satisfies Assistant,
    ];
    mockManagedAgents = [
      {
        id: 'agent-claude',
        backend: 'claude',
        available_models: {
          current_model_id: 'default',
          current_model_label: 'Default',
          available_models: [
            { id: 'default', label: 'Default' },
            { id: 'claude-opus', label: 'Claude Opus' },
            { id: 'claude-sonnet', label: 'Claude Sonnet' },
          ],
        },
      } as unknown as ManagedAgent,
    ];

    const { result } = renderHook(() =>
      useGuidAssistantSelection({
        resetAssistant: false,
      })
    );

    await waitFor(() => {
      expect(result.current.selectedAssistantId).toBe('assistant-with-default-model');
    });

    expect(result.current.currentAcpCachedModelInfo?.available_models.map((model) => model.id)).toEqual([
      'default',
      'claude-opus',
      'claude-sonnet',
    ]);
  });

  it('filters OpenCode Zen free models from the guid page managed runtime model list', async () => {
    mockAssistants = [
      {
        id: 'assistant-opencode',
        source: 'generated',
        name: 'OpenCode',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 1,
        agent_id: 'agent-opencode',
        agent: {
          type: 'acp',
          source: 'builtin',
          acp_backend: 'opencode',
        },
        enabled_skills: [],
        custom_skill_names: [],
        disabled_builtin_skills: [],
        context_i18n: {},
        prompts: [],
        prompts_i18n: {},
        models: [],
        agent_status: 'online',
        team_selectable: true,
        deletable: false,
      } satisfies Assistant,
    ];
    mockManagedAgents = [
      {
        id: 'agent-opencode',
        backend: 'opencode',
        config_options: {
          config_options: [
            {
              id: 'model',
              category: 'model',
              type: 'select',
              currentValue: 'opencode-zen/ling-3.0-flash-free',
              options: [
                { value: 'opencode-zen/ling-3.0-flash-free', label: 'OpenCode Zen/Ling-3.0-flash Free' },
                { value: 'hth/gpt-5.3-codex', label: 'HTH/gpt-5.3-codex' },
                { value: 'hth/gpt-5.6-terra', label: 'HTH/gpt-5.6-terra' },
              ],
            },
          ],
        },
      } as unknown as ManagedAgent,
    ];

    const { result } = renderHook(() =>
      useGuidAssistantSelection({
        resetAssistant: false,
      })
    );

    await waitFor(() => {
      expect(result.current.selectedAssistantId).toBe('assistant-opencode');
    });

    expect(result.current.selectedAcpModel).toBeNull();
    expect(result.current.currentAcpCachedModelInfo?.available_models.map((model) => model.label)).toEqual([
      'HTH/gpt-5.3-codex',
      'HTH/gpt-5.6-terra',
    ]);
  });

  it('keeps a guid-page model selection in memory across same-assistant runtime catalog refreshes', async () => {
    mockAssistants = [
      {
        id: 'assistant-with-runtime-models',
        source: 'user',
        name: 'Runtime Model Assistant',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 1,
        agent_id: 'agent-claude',
        agent: {
          type: 'acp',
          source: 'builtin',
          acp_backend: 'claude',
        },
        enabled_skills: [],
        custom_skill_names: [],
        disabled_builtin_skills: [],
        context_i18n: {},
        prompts: [],
        prompts_i18n: {},
        models: [],
        agent_status: 'online',
        team_selectable: true,
        deletable: true,
      } satisfies Assistant,
    ];
    const buildManagedAgent = () =>
      ({
        id: 'agent-claude',
        backend: 'claude',
        available_models: {
          current_model_id: 'default',
          current_model_label: 'Default',
          available_models: [
            { id: 'default', label: 'Default' },
            { id: 'global.anthropic.claude-opus-4-8', label: 'Opus 4.8' },
          ],
        },
      }) as unknown as ManagedAgent;
    mockManagedAgents = [buildManagedAgent()];

    const { result, rerender } = renderHook(() =>
      useGuidAssistantSelection({
        resetAssistant: false,
      })
    );

    // Nothing is picked until the user picks: the catalog's own `current_model_id` must
    // not masquerade as a selection.
    await waitFor(() => {
      expect(result.current.selectedAssistantId).toBe('assistant-with-runtime-models');
    });
    expect(result.current.selectedAcpModel).toBeNull();

    act(() => {
      result.current.setSelectedAcpModel('global.anthropic.claude-opus-4-8');
    });

    expect(result.current.selectedAcpModel).toBe('global.anthropic.claude-opus-4-8');

    // A catalog refresh for the SAME assistant must not disturb the user's pick.
    mockManagedAgents = [buildManagedAgent()];
    rerender();

    expect(result.current.selectedAcpModel).toBe('global.anthropic.claude-opus-4-8');
  });

  it('does not fall back to historical static modes when managed agent catalog has no modes', async () => {
    mockAssistants = [
      {
        id: 'assistant-claude-empty',
        source: 'generated',
        name: 'Claude',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 1,
        agent_id: 'agent-claude-empty',
        agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' },
        enabled_skills: [],
        custom_skill_names: [],
        disabled_builtin_skills: [],
        context_i18n: {},
        prompts: [],
        prompts_i18n: {},
        models: [],
        agent_status: 'online',
        team_selectable: true,
        deletable: false,
      } satisfies Assistant,
    ];
    mockManagedAgents = [{ id: 'agent-claude-empty', backend: 'claude' } as unknown as ManagedAgent];

    const { result } = renderHook(() =>
      useGuidAssistantSelection({
        resetAssistant: false,
      })
    );

    await waitFor(() => {
      expect(result.current.selectedAssistantId).toBe('assistant-claude-empty');
    });

    expect(result.current.currentAgentModeOptions).toEqual([]);
    expect(result.current.selectedMode).toBe('default');
  });

  it('reads aionrs mode options from the managed agent catalog', async () => {
    mockAssistants = [
      {
        id: 'bare:632f31d2',
        source: 'generated',
        name: 'Aion CLI',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 1,
        agent_id: '632f31d2',
        agent: { type: 'aionrs', source: 'internal' },
        enabled_skills: [],
        custom_skill_names: [],
        disabled_builtin_skills: [],
        context_i18n: {},
        prompts: [],
        prompts_i18n: {},
        models: [],
        agent_status: 'online',
        team_selectable: true,
        deletable: false,
      } satisfies Assistant,
    ];
    mockManagedAgents = [
      {
        id: '632f31d2',
        agent_type: 'aionrs',
        available_modes: {
          current_mode_id: 'default',
          available_modes: [
            { id: 'default', name: 'Default' },
            { id: 'auto_edit', name: 'Auto Edit' },
            { id: 'yolo', name: 'YOLO' },
          ],
        },
      } as unknown as ManagedAgent,
    ];

    const { result } = renderHook(() =>
      useGuidAssistantSelection({
        resetAssistant: false,
      })
    );

    await waitFor(() => {
      expect(result.current.selectedAssistantId).toBe('bare:632f31d2');
    });

    expect(result.current.selectedAssistantBackend).toBe('aionrs');
    expect(result.current.selectedMode).toBe('default');
    expect(result.current.currentAgentModeOptions.map((mode) => mode.value)).toEqual(['default', 'auto_edit', 'yolo']);
  });
});

function assistantFixture({
  id,
  runtimeKey,
  source,
  sortOrder,
}: {
  id: string;
  runtimeKey: string;
  source: Assistant['source'];
  sortOrder: number;
}): Assistant {
  const isAionrs = runtimeKey === 'aionrs';
  return {
    id,
    source,
    name: id,
    name_i18n: {},
    description_i18n: {},
    enabled: true,
    sort_order: sortOrder,
    agent_id: `agent-${runtimeKey}`,
    agent: isAionrs
      ? { type: 'aionrs', source: 'internal' }
      : { type: 'acp', source: 'builtin', acp_backend: runtimeKey },
    enabled_skills: [],
    custom_skill_names: [],
    disabled_builtin_skills: [],
    context_i18n: {},
    prompts: [],
    prompts_i18n: {},
    models: [],
    agent_status: 'online',
    team_selectable: true,
    deletable: source === 'user',
  };
}

describe('assistant model helpers', () => {
  it('builds model and mode info from agent runtime payloads', () => {
    const agent = {
      available_models: JSON.stringify({
        current_model_id: 'global.anthropic.claude-opus-4-8',
        current_model_label: 'Opus 4.8',
        available_models: [
          { id: 'default', label: 'Default', description: 'Sonnet 4.6 · Best for everyday tasks' },
          {
            id: 'global.anthropic.claude-opus-4-8',
            label: 'Opus 4.8',
            description: 'Most capable for complex work',
          },
        ],
      }),
      available_modes: JSON.stringify({
        current_mode_id: 'bypassPermissions',
        available_modes: [
          { id: 'default', name: 'Default' },
          { id: 'bypassPermissions', name: 'Bypass Permissions' },
        ],
      }),
    };

    expect(buildAgentRuntimeModelInfo(agent)).toEqual({
      current_model_id: 'global.anthropic.claude-opus-4-8',
      current_model_label: 'Opus 4.8',
      available_models: [
        { id: 'default', label: 'Default', description: 'Sonnet 4.6 · Best for everyday tasks' },
        {
          id: 'global.anthropic.claude-opus-4-8',
          label: 'Opus 4.8',
          description: 'Most capable for complex work',
        },
      ],
    });
    expect(buildAgentRuntimeModeState(agent)).toEqual({
      currentMode: 'bypassPermissions',
      options: [
        { value: 'default', label: 'Default', description: undefined },
        { value: 'bypassPermissions', label: 'Bypass Permissions', description: undefined },
      ],
    });
  });

  it('prefers model config_options before falling back to available_models', () => {
    const agent = {
      config_options: {
        config_options: [
          {
            id: 'model',
            category: 'model',
            type: 'select',
            currentValue: 'gpt-5.5',
            options: [
              { value: 'gpt-5.5', name: 'GPT-5.5' },
              { value: 'gpt-5.2', name: 'gpt-5.2' },
            ],
          },
        ],
      },
      available_models: {
        current_model_id: 'legacy-model',
        available_models: [{ id: 'legacy-model', label: 'Legacy Model' }],
      },
    };

    expect(buildAgentRuntimeModelInfo(agent)).toEqual({
      current_model_id: 'gpt-5.5',
      current_model_label: 'GPT-5.5',
      available_models: [
        { id: 'gpt-5.5', label: 'GPT-5.5' },
        { id: 'gpt-5.2', label: 'gpt-5.2' },
      ],
    });
  });

  it('whitelists HTH models only for the OpenCode runtime', () => {
    const agent = {
      available_models: {
        current_model_id: 'hth/gpt-5.6-terra',
        available_models: [
          { id: 'hth/gpt-5.6-terra', label: 'HTH GPT-5.6 Terra' },
          { id: 'opencode-zen/mimo-v2.5-free', label: 'OpenCode Zen MiMo' },
          { id: 'openai/gpt-5', label: 'OpenAI GPT-5' },
        ],
      },
    };

    expect(buildAgentRuntimeModelInfo(agent, 'opencode')?.available_models).toEqual([
      { id: 'hth/gpt-5.6-terra', label: 'HTH GPT-5.6 Terra', description: undefined },
    ]);
    expect(buildAgentRuntimeModelInfo(agent, 'claude')?.available_models).toHaveLength(3);
  });

  it('prefers mode config_options before falling back to available_modes', () => {
    const agent = {
      config_options: {
        config_options: [
          {
            id: 'mode',
            category: 'mode',
            type: 'select',
            currentValue: 'full-access',
            options: [
              { value: 'read-only', name: 'Read Only' },
              { value: 'full-access', name: 'Full Access' },
            ],
          },
        ],
      },
      available_modes: {
        current_mode_id: 'legacy-mode',
        available_modes: [{ id: 'legacy-mode', name: 'Legacy Mode' }],
      },
    };

    expect(buildAgentRuntimeModeState(agent)).toEqual({
      currentMode: 'full-access',
      options: [
        { value: 'read-only', label: 'Read Only', description: undefined },
        { value: 'full-access', label: 'Full Access', description: undefined },
      ],
    });
  });

  it('builds slash commands from persisted agent available_commands metadata', () => {
    const agent = {
      available_commands: JSON.stringify({
        available_commands: [
          {
            name: 'review',
            description: 'Review the current diff',
            input: {
              hint: '⌘R',
            },
            _meta: {
              completion_behavior: 'neutral_tip_on_empty',
              empty_turn_tip_code: 'acp.empty_turn.choose_command',
              empty_turn_tip_params: { command_count: 1 },
            },
          },
        ],
      }),
    };

    expect(buildAgentRuntimeSlashCommands(agent)).toEqual([
      {
        name: 'review',
        description: 'Review the current diff',
        hint: '⌘R',
        kind: 'template',
        source: 'acp',
        selectionBehavior: 'insert',
        completionBehavior: 'neutral_tip_on_empty',
        emptyTurnTipCode: 'acp.empty_turn.choose_command',
        emptyTurnTipParams: { command_count: 1 },
      },
    ]);
  });

  it('ignores malformed available_commands metadata', () => {
    expect(
      buildAgentRuntimeSlashCommands({
        available_commands: JSON.stringify({
          available_commands: [{ name: 'missing-description' }, null, 'bad'],
        }),
      })
    ).toEqual([]);
  });

  it('builds ACP model info from assistant models', () => {
    expect(buildAssistantModelInfo(['claude-opus', 'claude-sonnet'])).toEqual({
      current_model_id: 'claude-opus',
      current_model_label: 'claude-opus',
      available_models: [
        { id: 'claude-opus', label: 'claude-opus' },
        { id: 'claude-sonnet', label: 'claude-sonnet' },
      ],
    });
  });

  it('builds Codex ACP model info from assistant models', () => {
    expect(buildAssistantModelInfo(['gpt-5.5', 'gpt-5.4'])).toEqual({
      current_model_id: 'gpt-5.5',
      current_model_label: 'gpt-5.5',
      available_models: [
        { id: 'gpt-5.5', label: 'gpt-5.5' },
        { id: 'gpt-5.4', label: 'gpt-5.4' },
      ],
    });
  });

  it('defaults to the first assistant model when no assistant preference has been applied yet', () => {
    expect(resolveInitialAssistantModel(['claude-opus', 'claude-sonnet'])).toBe('claude-opus');
  });

  it('does not synthesize Codex models when the assistant catalog has none', () => {
    expect(buildAssistantModelInfo([])).toBeNull();
    expect(resolveInitialAssistantModel([])).toBeNull();
  });
});
