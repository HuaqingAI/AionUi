/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutContext } from '@/renderer/hooks/context/LayoutContext';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { AgentRuntimeDerivedOption } from '@/renderer/utils/model/agentRuntimeCatalog';

const {
  modelSelectionMock,
  agentSelectionMock,
  locationMock,
  guidInputMock,
  capturedGuidActionRowProps,
  capturedAssistantSelectionAreaProps,
  capturedGuidInputCardProps,
  capturedGuidSendDeps,
  listAvailableSkillsInvokeMock,
  resolveGuidAssistantDefaultsMock,
  sendMock,
  navigateMock,
} = vi.hoisted(() => ({
  modelSelectionMock: {
    modelList: [],
    isGoogleAuth: false,
    current_model: undefined,
    setCurrentModel: vi.fn(),
    resetCurrentModel: vi.fn(),
  },
  agentSelectionMock: {
    selectedAssistantId: 'bare-aionrs',
    selectedAssistant: {
      id: 'bare-aionrs',
      source: 'generated',
      name: 'Aion CLI',
      name_i18n: {},
      description_i18n: {},
      enabled: true,
      sort_order: 10,
      agent_id: '',
      agent: undefined as Assistant['agent'],
      preset_agent_type: 'aionrs',
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
    },
    assistants: [
      {
        id: 'bare-aionrs',
        source: 'generated',
        name: 'Aion CLI',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 10,
        preset_agent_type: 'aionrs',
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
      },
    ],
    selectedAssistantBackend: 'aionrs',
    selectedAssistantAvailable: true,
    selectedMode: 'default',
    setSelectedMode: vi.fn(),
    selectedAcpModel: null,
    setSelectedAcpModel: vi.fn(),
    currentAcpCachedModelInfo: null,
    currentThoughtLevelOption: null as AgentRuntimeDerivedOption | null,
    selectedThoughtLevelValue: '',
    setSelectedThoughtLevelValue: vi.fn(),
    defaultAssistantId: 'bare-aionrs',
    setSelectedAssistantId: vi.fn(),
  },
  guidInputMock: {
    input: '',
    setInput: vi.fn(),
    files: [],
    setFiles: vi.fn(),
    dir: '',
    setDir: vi.fn(),
    loading: false,
    setLoading: vi.fn(),
    isInputFocused: false,
    isFileDragging: false,
    dragHandlers: {},
    onPaste: vi.fn(),
    handleTextareaFocus: vi.fn(),
    handleTextareaBlur: vi.fn(),
    handleFilesUploaded: vi.fn(),
    handleRemoveFile: vi.fn(),
  },
  locationMock: {
    state: null as unknown,
    key: 'guid-location',
    pathname: '/guid',
    search: '',
    hash: '',
  },
  capturedGuidActionRowProps: [] as Array<Record<string, unknown>>,
  capturedAssistantSelectionAreaProps: [] as Array<Record<string, unknown>>,
  capturedGuidInputCardProps: [] as Array<Record<string, unknown>>,
  capturedGuidSendDeps: [] as Array<Record<string, unknown>>,
  listAvailableSkillsInvokeMock: vi.fn(),
  resolveGuidAssistantDefaultsMock: vi.fn(() => ({
    disabledBuiltinSkillIds: [],
    skillIds: [],
    mcpIds: [],
  })),
  sendMock: {
    handleSend: vi.fn(),
    sendMessageHandler: vi.fn(),
    isButtonDisabled: false,
  },
  navigateMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; [key: string]: unknown }) => options?.defaultValue || key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => locationMock,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      listAvailableSkills: { invoke: listAvailableSkillsInvokeMock },
    },
  },
}));

vi.mock('@/renderer/hooks/mcp/catalog', () => ({
  ensureBackendMcpCatalog: vi.fn().mockResolvedValue({ allServers: [] }),
}));

vi.mock('@/renderer/hooks/chat/useInputFocusRing', () => ({
  useInputFocusRing: () => ({
    activeBorderColor: '#000',
    inactiveBorderColor: '#ccc',
    activeShadow: 'none',
  }),
}));

vi.mock('@/renderer/pages/guid/hooks/useGuidModelSelection', () => ({
  useGuidModelSelection: () => modelSelectionMock,
}));

const useGuidAssistantSelectionMock = vi.fn(() => agentSelectionMock);

vi.mock('@/renderer/pages/guid/hooks/useGuidAssistantSelection', () => ({
  useGuidAssistantSelection: (...args: unknown[]) => useGuidAssistantSelectionMock(...args),
  resolveAssistantSelectionKey: vi.fn(),
  pickDefaultAssistantSelectionKey: vi.fn(),
}));

vi.mock('@/renderer/pages/guid/hooks/useGuidInput', () => ({
  useGuidInput: () => guidInputMock,
}));

vi.mock('@/renderer/pages/guid/hooks/useGuidSend', () => ({
  useGuidSend: (deps: Record<string, unknown>) => {
    capturedGuidSendDeps.push(deps);
    return sendMock;
  },
}));

vi.mock('@/renderer/pages/guid/hooks/useTypewriterPlaceholder', () => ({
  useTypewriterPlaceholder: () => '',
}));

vi.mock('@/renderer/pages/guid/components/AssistantSelectionArea', () => ({
  default: (props: Record<string, unknown>) => {
    capturedAssistantSelectionAreaProps.push(props);
    return <div data-testid='assistant-selection-area' />;
  },
}));

vi.mock('@/renderer/pages/guid/components/GuidActionRow', () => ({
  default: (props: Record<string, unknown>) => {
    capturedGuidActionRowProps.push(props);
    return <div data-testid='guid-action-row' />;
  },
}));

vi.mock('@/renderer/pages/guid/components/GuidInputCard', () => ({
  default: (props: Record<string, unknown>) => {
    capturedGuidInputCardProps.push(props);
    return <div data-testid='guid-input-card'>{props.actionRow as React.ReactNode}</div>;
  },
}));

vi.mock('@/renderer/pages/guid/components/GuidModelSelector', () => ({
  default: () => <div data-testid='guid-model-selector' />,
}));

vi.mock('@/renderer/pages/guid/components/QuickActionButtons', () => ({
  default: () => <div data-testid='guid-quick-actions' />,
}));

vi.mock('@/renderer/components/settings/SettingsModal/contents/FeedbackReportModal', () => ({
  default: () => null,
}));

vi.mock('@/renderer/components/chat/SpeechInputButton', () => ({
  default: () => null,
}));

vi.mock('@/renderer/hooks/system/useLiveTranscriptInsertion', () => ({
  useLiveTranscriptInsertion: () => ({ handleLiveTranscript: vi.fn() }),
}));

vi.mock('@/renderer/hooks/system/useSpeechInput', () => ({
  appendSpeechTranscript: (prev: string, next: string) => `${prev}${next}`,
}));

vi.mock('@/renderer/utils/platform', () => ({
  openExternalUrl: vi.fn(),
  resolveExtensionAssetUrl: vi.fn(),
  resolveBackendAssetUrl: vi.fn((path: string) => path),
}));

vi.mock('@/renderer/pages/guid/utils/assistantDefaults', async () => {
  const actual = await vi.importActual<typeof import('@/renderer/pages/guid/utils/assistantDefaults')>(
    '@/renderer/pages/guid/utils/assistantDefaults'
  );
  return {
    ...actual,
    resolveGuidAssistantDefaults: (...args: unknown[]) => resolveGuidAssistantDefaultsMock(...args),
  };
});

const swrMock = vi.hoisted(() => ({
  useSWRMock: vi.fn(),
}));

const assistantDetailFixture = {
  prompts: {
    recommended: [],
    recommended_i18n: {
      'en-US': [
        'Create a three-page financial dashboard with profit, revenue mix, and conditional formatting highlights',
      ],
    },
  },
  defaults: {
    model: { mode: 'auto' },
    permission: { mode: 'auto' },
    thought_level: { mode: 'auto' },
    skills: { mode: 'auto', value: [] },
    mcps: { mode: 'auto', value: [] },
  },
  preferences: {
    last_model_id: null,
    last_permission_value: null,
    last_skill_ids: [],
    last_disabled_builtin_skill_ids: [],
    last_mcp_ids: [],
  },
};

const buildManagedAssistantDetail = (backend: 'codex' | 'opencode') => ({
  ...assistantDetailFixture,
  engine: {
    agent_id: `agent-${backend}`,
    agent: { type: 'acp', source: 'builtin' as const, acp_backend: backend },
  },
});

const buildManagedThoughtLevelOption = (
  currentValue = 'low',
  values = ['low', 'medium', 'high']
): AgentRuntimeDerivedOption => ({
  id: 'reasoning_effort',
  category: 'thought_level',
  currentValue,
  options: values.map((value) => ({ value, label: value })),
});

vi.mock('swr', async () => {
  const actual = await vi.importActual<typeof import('swr')>('swr');
  return {
    ...actual,
    default: swrMock.useSWRMock,
    mutate: vi.fn(),
  };
});

import GuidPage from '@/renderer/pages/guid/GuidPage';

const guidInputCardProps = {
  input: 'Existing Guid draft\nCreate with /cron in AionUi',
  onInputChange: vi.fn(),
  onKeyDown: vi.fn(),
  onPaste: vi.fn(),
  onFocus: vi.fn(),
  onBlur: vi.fn(),
  placeholder: 'Message',
  isInputActive: false,
  isFileDragging: false,
  activeBorderColor: 'var(--color-primary-6)',
  inactiveBorderColor: 'var(--color-border-2)',
  activeShadow: 'none',
  dragHandlers: {},
  files: [],
  onRemoveFile: vi.fn(),
  actionRow: null,
  workspaceDir: '',
  onSelectWorkspace: vi.fn(),
  onClearWorkspace: vi.fn(),
};

describe('GuidPage', () => {
  beforeEach(() => {
    locationMock.state = null;
    locationMock.key = 'guid-location';
    navigateMock.mockReset();
    swrMock.useSWRMock.mockReturnValue({ data: null });
    listAvailableSkillsInvokeMock.mockReset();
    listAvailableSkillsInvokeMock.mockResolvedValue([]);
    capturedGuidActionRowProps.length = 0;
    capturedAssistantSelectionAreaProps.length = 0;
    capturedGuidInputCardProps.length = 0;
    capturedGuidSendDeps.length = 0;
    useGuidAssistantSelectionMock.mockClear();
    resolveGuidAssistantDefaultsMock.mockReturnValue({
      disabledBuiltinSkillIds: [],
      skillIds: [],
      mcpIds: [],
    });
    modelSelectionMock.modelList = [];
    modelSelectionMock.setCurrentModel.mockReset();
    modelSelectionMock.resetCurrentModel.mockReset();
    agentSelectionMock.currentAgentModeOptions = [];
    agentSelectionMock.currentAcpCachedModelInfo = null;
    agentSelectionMock.selectedAssistantId = 'bare-aionrs';
    agentSelectionMock.selectedAssistant.id = 'bare-aionrs';
    agentSelectionMock.selectedAssistant.agent_id = '';
    agentSelectionMock.selectedAssistant.agent = undefined;
    agentSelectionMock.selectedAssistant.models = [];
    agentSelectionMock.currentThoughtLevelOption = null;
    agentSelectionMock.selectedThoughtLevelValue = '';
    agentSelectionMock.setSelectedThoughtLevelValue.mockReset();
    agentSelectionMock.selectedAssistantBackend = 'aionrs';
    agentSelectionMock.setSelectedAcpModel.mockReset();
    agentSelectionMock.setSelectedMode.mockReset();
    agentSelectionMock.assistants = [
      {
        id: 'bare-aionrs',
        source: 'generated',
        name: 'Aion CLI',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 10,
        preset_agent_type: 'aionrs',
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
      },
    ];
  });

  it('keeps the existing replace contract for ordinary Guid prefills', () => {
    locationMock.state = { prefillPrompt: 'Replace with this prompt' };
    guidInputMock.setInput.mockClear();
    guidInputMock.setFiles.mockClear();
    guidInputMock.setDir.mockClear();

    render(<GuidPage />);

    expect(guidInputMock.setInput).toHaveBeenCalledWith('Replace with this prompt');
    expect(guidInputMock.setFiles).toHaveBeenCalledWith([]);
    expect(guidInputMock.setDir).toHaveBeenCalledWith('');
    expect(capturedGuidInputCardProps.at(-1)?.focusRequestKey).toBeUndefined();
  });

  it('keeps replacing attachments supplied by an ordinary Guid prefill', () => {
    locationMock.state = {
      prefillPrompt: 'Replace prompt and attachments',
      prefillFiles: ['/tmp/one.png', '/tmp/two.png'],
    };
    guidInputMock.setFiles.mockClear();

    render(<GuidPage />);

    // Prefill attachments carry no source tag → seeded as `upload` refs.
    expect(guidInputMock.setFiles).toHaveBeenCalledWith([
      { kind: 'upload', path: '/tmp/one.png' },
      { kind: 'upload', path: '/tmp/two.png' },
    ]);
  });

  it('appends a draft-preserving prefill without clearing attachments or workspace', () => {
    locationMock.state = {
      prefillPrompt: 'Create with /cron in AionUi',
      preservePrefillDraft: true,
      focusPrefill: true,
      returnTo: 'conversation-sidebar',
    };
    guidInputMock.setInput.mockClear();
    guidInputMock.setFiles.mockClear();
    guidInputMock.setDir.mockClear();

    const { rerender, unmount } = render(<GuidPage />);

    const inputUpdater = guidInputMock.setInput.mock.calls[0]?.[0];
    expect(inputUpdater).toBeTypeOf('function');
    expect(inputUpdater('Existing Guid draft')).toBe('Existing Guid draft\nCreate with /cron in AionUi');
    expect(guidInputMock.setFiles).not.toHaveBeenCalled();
    expect(guidInputMock.setDir).not.toHaveBeenCalled();
    expect(capturedGuidInputCardProps.at(-1)?.focusRequestKey).toBe('guid-location');
    expect(navigateMock).toHaveBeenCalledWith('/guid', {
      replace: true,
      state: { returnTo: 'conversation-sidebar' },
    });

    locationMock.state = { returnTo: 'conversation-sidebar' };
    locationMock.key = 'guid-location-replaced';
    rerender(<GuidPage />);
    expect(guidInputMock.setInput).toHaveBeenCalledOnce();
    expect(guidInputMock.setDir).not.toHaveBeenCalled();

    unmount();
    guidInputMock.setInput.mockClear();
    render(<GuidPage />);
    expect(guidInputMock.setInput).toHaveBeenCalledWith('');
    expect(guidInputMock.setInput.mock.calls.some(([value]) => typeof value === 'function')).toBe(false);
  });

  it('removes a consumed preserved prefill even when no other navigation state remains', () => {
    locationMock.state = {
      prefillPrompt: 'Create with /cron in AionUi',
      preservePrefillDraft: true,
      focusPrefill: true,
    };

    render(<GuidPage />);

    expect(navigateMock).toHaveBeenCalledWith('/guid', { replace: true, state: null });
  });

  it('keeps a generic conversation heading and omits assistant-detail chrome on the home page', () => {
    render(<GuidPage />);

    expect(screen.queryByLabelText('common.back')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Assistant Details')).not.toBeInTheDocument();
    expect(screen.getByText('conversation.welcome.title')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-selection-area')).toBeInTheDocument();
    expect(screen.queryByTestId('guid-quick-actions')).not.toBeInTheDocument();
    const latestAssistantSelectionAreaProps = capturedAssistantSelectionAreaProps.at(-1);
    const latestGuidActionRowProps = capturedGuidActionRowProps.at(-1);
    const latestGuidInputCardProps = capturedGuidInputCardProps.at(-1);

    expect(capturedAssistantSelectionAreaProps.length).toBeGreaterThan(0);
    expect(latestAssistantSelectionAreaProps).not.toHaveProperty('is_presetAgent');
    expect(latestAssistantSelectionAreaProps).not.toHaveProperty('selectedAgentInfo');
    expect(capturedGuidActionRowProps.length).toBeGreaterThan(0);
    expect(latestGuidActionRowProps).not.toHaveProperty('hidePresetTag');
    expect(latestGuidActionRowProps).not.toHaveProperty('is_presetAgent');
    expect(latestGuidActionRowProps).not.toHaveProperty('selectedAgent');
    expect(latestGuidActionRowProps).not.toHaveProperty('selectedAgentInfo');
    expect(latestGuidActionRowProps).not.toHaveProperty('onClosePresetTag');
    expect(capturedGuidInputCardProps.length).toBeGreaterThan(0);
    expect(latestGuidInputCardProps).not.toHaveProperty('mentionOpen');
    expect(latestGuidInputCardProps).not.toHaveProperty('mentionSelectorBadge');
    expect(latestGuidInputCardProps).not.toHaveProperty('mentionDropdown');
  });

  it('ignores legacy selectedAgentKey navigation state when preselecting an assistant', () => {
    locationMock.state = {
      selectedAgentKey: 'bare:claude',
    };

    render(<GuidPage />);

    expect(useGuidAssistantSelectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preselectAssistantId: undefined,
      })
    );
  });

  it('renders example prompts with wrapping text for long assistant suggestions', () => {
    agentSelectionMock.assistants = [
      {
        id: 'bare-aionrs',
        source: 'generated',
        name: 'Aion CLI',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 10,
        preset_agent_type: 'aionrs',
        enabled_skills: [],
        custom_skill_names: [],
        disabled_builtin_skills: [],
        context_i18n: {},
        prompts: [],
        prompts_i18n: {
          'en-US': [
            'Create a three-page financial dashboard with profit, revenue mix, and conditional formatting highlights',
          ],
        },
        models: [],
        agent_status: 'online',
        team_selectable: true,
        deletable: false,
      },
    ];

    swrMock.useSWRMock.mockImplementation((key: string | null) => {
      if (key?.startsWith('guid.assistant.detail.')) {
        return {
          data: assistantDetailFixture,
        };
      }
      return { data: null };
    });

    render(<GuidPage />);

    const promptButton = screen.getByRole('button', {
      name: /Create a three-page financial dashboard with profit/i,
    });

    expect(promptButton.className).toContain('!whitespace-normal');
    expect(promptButton.className).toContain('!break-words');
  });

  it('falls back to default instruction prompts when the selected assistant has no recommendations', () => {
    render(<GuidPage />);

    expect(screen.getByRole('button', { name: 'guid.defaultPrompts.understand' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'guid.defaultPrompts.cleanup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'guid.defaultPrompts.create' })).toBeInTheDocument();
  });

  it('does not seed skill defaults from the assistant list while detail is loading', async () => {
    agentSelectionMock.assistants = [
      {
        id: 'bare-aionrs',
        source: 'generated',
        name: 'Aion CLI',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 10,
        preset_agent_type: 'aionrs',
        enabled_skills: ['stale-list-skill'],
        custom_skill_names: [],
        disabled_builtin_skills: ['stale-disabled-builtin'],
        context_i18n: {},
        prompts: [],
        prompts_i18n: {},
        models: [],
        agent_status: 'online',
        team_selectable: true,
        deletable: false,
      },
    ];
    swrMock.useSWRMock.mockReturnValue({ data: null });

    render(<GuidPage />);

    await vi.waitFor(() => {
      const latestDeps = capturedGuidSendDeps.at(-1);
      expect(latestDeps).toMatchObject({
        guidEnabledSkills: undefined,
        guidDisabledBuiltinSkills: undefined,
      });
    });
  });

  it('omits aionui-prefixed internal skills from the Guid new-conversation skill menu', async () => {
    listAvailableSkillsInvokeMock.mockResolvedValue([
      {
        name: 'aionui-config',
        description: 'Internal config sync',
        source: 'builtin',
        is_auto_inject: true,
      },
      {
        name: 'aionui-browser',
        description: 'Internal browser integration',
        source: 'builtin',
        is_auto_inject: false,
      },
      {
        name: 'pdf-reader',
        description: 'Read PDFs',
        source: 'builtin',
        is_auto_inject: false,
      },
    ]);

    render(<GuidPage />);

    await waitFor(() => {
      const latestProps = capturedGuidActionRowProps.at(-1);
      const skillNames = (latestProps?.allSkills as Array<{ name: string }> | undefined)?.map((skill) => skill.name);
      expect(skillNames).toEqual(['pdf-reader']);
    });
  });

  it('applies an aionrs assistant default model after provider models load', async () => {
    swrMock.useSWRMock.mockReturnValue({ data: assistantDetailFixture });
    resolveGuidAssistantDefaultsMock.mockReturnValue({
      modelId: 'gpt-4.1',
      disabledBuiltinSkillIds: [],
      skillIds: [],
      mcpIds: [],
    });

    const { rerender } = render(<GuidPage />);

    expect(modelSelectionMock.setCurrentModel).not.toHaveBeenCalled();

    modelSelectionMock.modelList = [
      {
        id: 'provider-openai',
        name: 'OpenAI',
        models: ['gpt-4.1'],
        use_model: 'gpt-4o',
        enabled: true,
      },
    ];

    rerender(<GuidPage />);

    await vi.waitFor(() => {
      expect(modelSelectionMock.setCurrentModel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'provider-openai',
          use_model: 'gpt-4.1',
        }),
        { persistPreference: false }
      );
    });
  });

  it.each([
    { backend: 'codex' as const, available: true },
    { backend: 'opencode' as const, available: true },
    { backend: 'codex' as const, available: false },
    { backend: 'opencode' as const, available: false },
  ])('uses the available managed default for $backend (available: $available)', ({ backend, available }) => {
    const defaultModelId = backend === 'opencode' ? 'hth/gpt-6.1-sol' : 'gpt-6.1-sol';
    swrMock.useSWRMock.mockReturnValue({ data: buildManagedAssistantDetail(backend) });
    agentSelectionMock.selectedAssistantBackend = backend;
    agentSelectionMock.currentAcpCachedModelInfo = {
      current_model_id: 'last-session-model',
      current_model_label: 'Last session model',
      available_models: (available ? ['last-session-model', defaultModelId] : ['last-session-model']).map((id) => ({
        id,
        label: id,
      })),
    };

    render(<GuidPage />);

    expect(agentSelectionMock.setSelectedAcpModel).toHaveBeenLastCalledWith(available ? defaultModelId : null, {
      persistPreference: false,
    });
  });

  it.each([
    { backend: 'codex' as const, mode: 'fixed' },
    { backend: 'opencode' as const, mode: 'fixed' },
    { backend: 'codex' as const, mode: 'auto' },
    { backend: 'opencode' as const, mode: 'auto' },
  ])('keeps the resolved $mode model for $backend', ({ backend, mode }) => {
    const detail = buildManagedAssistantDetail(backend);
    swrMock.useSWRMock.mockReturnValue({
      data: {
        ...detail,
        defaults: { ...detail.defaults, model: { mode, value: mode === 'fixed' ? 'chosen-model' : undefined } },
        preferences: { ...detail.preferences, last_model_id: mode === 'auto' ? 'chosen-model' : undefined },
      },
    });
    resolveGuidAssistantDefaultsMock.mockReturnValue({
      modelId: 'chosen-model',
      disabledBuiltinSkillIds: [],
      skillIds: [],
      mcpIds: [],
    });
    agentSelectionMock.selectedAssistantBackend = backend;
    agentSelectionMock.currentAcpCachedModelInfo = {
      current_model_id: null,
      current_model_label: null,
      available_models: ['chosen-model', backend === 'opencode' ? 'hth/gpt-6.1-sol' : 'gpt-6.1-sol'].map((id) => ({
        id,
        label: id,
      })),
    };

    render(<GuidPage />);

    expect(agentSelectionMock.setSelectedAcpModel).toHaveBeenLastCalledWith('chosen-model', {
      persistPreference: false,
    });
  });

  it.each(['custom', 'static-models', 'none', 'unbound'])(
    'keeps the CLI default for an excluded %s assistant',
    (exclusion) => {
      const detail = buildManagedAssistantDetail('codex');
      swrMock.useSWRMock.mockReturnValue({
        data: {
          ...detail,
          defaults: { ...detail.defaults, model: { mode: exclusion === 'none' ? 'none' : 'auto' } },
          engine: {
            ...detail.engine,
            agent_id: exclusion === 'unbound' ? '' : detail.engine.agent_id,
            agent: { ...detail.engine.agent, source: exclusion === 'custom' ? 'custom' : 'builtin' },
          },
        },
      });
      agentSelectionMock.selectedAssistantBackend = 'codex';
      agentSelectionMock.selectedAssistant.models = exclusion === 'static-models' ? ['assistant-model'] : [];
      agentSelectionMock.currentAcpCachedModelInfo = {
        current_model_id: 'gpt-6.1-sol',
        current_model_label: 'Sol',
        available_models: [{ id: 'gpt-6.1-sol', label: 'Sol' }],
      };

      render(<GuidPage />);

      expect(agentSelectionMock.setSelectedAcpModel).toHaveBeenLastCalledWith(null, { persistPreference: false });
    }
  );

  it('keeps a manual model choice when the managed catalog refreshes', () => {
    swrMock.useSWRMock.mockReturnValue({ data: buildManagedAssistantDetail('codex') });
    agentSelectionMock.selectedAssistantBackend = 'codex';
    agentSelectionMock.currentAcpCachedModelInfo = {
      current_model_id: null,
      current_model_label: null,
      available_models: ['gpt-6.1-sol', 'chosen-model'].map((id) => ({ id, label: id })),
    };
    const { rerender } = render(<GuidPage />);
    const modelSelectorNode = capturedGuidActionRowProps.at(-1)?.modelSelectorNode as React.ReactElement<{
      setSelectedAcpModel: (model: string) => void;
    }>;
    modelSelectorNode.props.setSelectedAcpModel('chosen-model');
    agentSelectionMock.setSelectedAcpModel.mockClear();
    agentSelectionMock.currentAcpCachedModelInfo = {
      current_model_id: 'gpt-6.1-sol',
      current_model_label: 'Sol',
      available_models: ['gpt-6.1-sol', 'chosen-model', 'new-model'].map((id) => ({ id, label: id })),
    };

    rerender(<GuidPage />);

    expect(agentSelectionMock.setSelectedAcpModel).not.toHaveBeenCalled();
  });

  it.each(['opencode', 'codex'] as const)(
    'defaults %s thinking to high when the real catalog reports low',
    (backend) => {
      const detail = buildManagedAssistantDetail(backend);
      swrMock.useSWRMock.mockReturnValue({ data: detail });
      agentSelectionMock.selectedAssistantBackend = backend;
      agentSelectionMock.selectedAssistant.agent_id = detail.engine.agent_id;
      agentSelectionMock.selectedAssistant.agent = detail.engine.agent;
      agentSelectionMock.currentThoughtLevelOption = buildManagedThoughtLevelOption('low');

      render(<GuidPage />);

      expect(agentSelectionMock.setSelectedThoughtLevelValue).toHaveBeenLastCalledWith('high', {
        persistPreference: false,
      });
    }
  );

  it.each(['opencode', 'codex'] as const)(
    'applies Sol and high defaults when the %s wire payload omits empty models',
    async (backend) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const detail = buildManagedAssistantDetail(backend);
        const defaultModelId = backend === 'opencode' ? 'hth/gpt-6.1-sol' : 'gpt-6.1-sol';
        swrMock.useSWRMock.mockReturnValue({ data: detail });
        agentSelectionMock.selectedAssistantBackend = backend;
        agentSelectionMock.selectedAssistant = JSON.parse(
          JSON.stringify({
            ...agentSelectionMock.selectedAssistant,
            agent_id: detail.engine.agent_id,
            agent: detail.engine.agent,
            models: undefined,
          })
        ) as typeof agentSelectionMock.selectedAssistant;
        agentSelectionMock.currentAcpCachedModelInfo = {
          current_model_id: null,
          current_model_label: null,
          available_models: [{ id: defaultModelId, label: defaultModelId }],
        };
        agentSelectionMock.currentThoughtLevelOption = buildManagedThoughtLevelOption('low');

        render(<GuidPage />);

        await waitFor(() => {
          expect(agentSelectionMock.setSelectedAcpModel).toHaveBeenLastCalledWith(defaultModelId, {
            persistPreference: false,
          });
          expect(agentSelectionMock.setSelectedThoughtLevelValue).toHaveBeenLastCalledWith('high', {
            persistPreference: false,
          });
        });
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    }
  );

  it('does not carry the previous assistant low thinking selection into another assistant', () => {
    const detail = buildManagedAssistantDetail('opencode');
    swrMock.useSWRMock.mockReturnValue({ data: detail });
    agentSelectionMock.selectedAssistantBackend = 'opencode';
    agentSelectionMock.selectedAssistant.agent_id = detail.engine.agent_id;
    agentSelectionMock.selectedAssistant.agent = detail.engine.agent;
    agentSelectionMock.currentThoughtLevelOption = buildManagedThoughtLevelOption('low');
    const { rerender } = render(<GuidPage />);
    const modelSelectorNode = capturedGuidActionRowProps.at(-1)?.modelSelectorNode as React.ReactElement<{
      onThoughtLevelSelect: (value: string) => void;
    }>;
    modelSelectorNode.props.onThoughtLevelSelect('low');
    agentSelectionMock.setSelectedThoughtLevelValue.mockClear();
    agentSelectionMock.selectedAssistantId = 'another-opencode-assistant';
    agentSelectionMock.selectedAssistant.id = 'another-opencode-assistant';
    agentSelectionMock.selectedThoughtLevelValue = 'low';
    agentSelectionMock.currentThoughtLevelOption = buildManagedThoughtLevelOption('low');

    rerender(<GuidPage />);

    expect(agentSelectionMock.setSelectedThoughtLevelValue).toHaveBeenLastCalledWith('high', {
      persistPreference: false,
    });
  });

  it.each(['fixed', 'auto'])('keeps an explicit or remembered low thinking level in %s mode', (mode) => {
    const detail = buildManagedAssistantDetail('opencode');
    swrMock.useSWRMock.mockReturnValue({
      data: {
        ...detail,
        defaults: { ...detail.defaults, thought_level: { mode, value: mode === 'fixed' ? 'low' : undefined } },
        preferences: { ...detail.preferences, last_thought_level_value: mode === 'auto' ? 'low' : undefined },
      },
    });
    resolveGuidAssistantDefaultsMock.mockReturnValue({
      thoughtLevel: 'low',
      disabledBuiltinSkillIds: [],
      skillIds: [],
      mcpIds: [],
    });
    agentSelectionMock.selectedAssistantBackend = 'opencode';
    agentSelectionMock.selectedAssistant.agent_id = detail.engine.agent_id;
    agentSelectionMock.selectedAssistant.agent = detail.engine.agent;
    agentSelectionMock.currentThoughtLevelOption = buildManagedThoughtLevelOption('low');

    render(<GuidPage />);

    expect(agentSelectionMock.setSelectedThoughtLevelValue).toHaveBeenLastCalledWith('low', {
      persistPreference: false,
    });
  });

  it('keeps a manual medium thinking choice when the real catalog refreshes', () => {
    const detail = buildManagedAssistantDetail('opencode');
    swrMock.useSWRMock.mockReturnValue({ data: detail });
    agentSelectionMock.selectedAssistantBackend = 'opencode';
    agentSelectionMock.selectedAssistant.agent_id = detail.engine.agent_id;
    agentSelectionMock.selectedAssistant.agent = detail.engine.agent;
    agentSelectionMock.currentThoughtLevelOption = buildManagedThoughtLevelOption('low');
    const { rerender } = render(<GuidPage />);
    const modelSelectorNode = capturedGuidActionRowProps.at(-1)?.modelSelectorNode as React.ReactElement<{
      onThoughtLevelSelect: (value: string) => void;
    }>;
    modelSelectorNode.props.onThoughtLevelSelect('medium');
    expect(agentSelectionMock.setSelectedThoughtLevelValue).toHaveBeenLastCalledWith('medium', {
      persistPreference: false,
    });
    agentSelectionMock.setSelectedThoughtLevelValue.mockClear();
    agentSelectionMock.currentThoughtLevelOption = buildManagedThoughtLevelOption('low', [
      'low',
      'medium',
      'high',
      'xhigh',
    ]);

    rerender(<GuidPage />);

    expect(agentSelectionMock.setSelectedThoughtLevelValue).not.toHaveBeenCalled();
  });

  it.each(['opencode', 'codex'] as const)('uses the real %s thinking level when high is unsupported', (backend) => {
    const detail = buildManagedAssistantDetail(backend);
    swrMock.useSWRMock.mockReturnValue({ data: detail });
    agentSelectionMock.selectedAssistantBackend = backend;
    agentSelectionMock.selectedAssistant.agent_id = detail.engine.agent_id;
    agentSelectionMock.selectedAssistant.agent = detail.engine.agent;
    agentSelectionMock.currentThoughtLevelOption = buildManagedThoughtLevelOption('medium', ['low', 'medium']);

    render(<GuidPage />);

    expect(agentSelectionMock.setSelectedThoughtLevelValue).toHaveBeenLastCalledWith('medium', {
      persistPreference: false,
    });
  });

  it('does not reapply assistant default model over a guid-page model selection', async () => {
    swrMock.useSWRMock.mockReturnValue({ data: assistantDetailFixture });
    resolveGuidAssistantDefaultsMock.mockReturnValue({
      modelId: 'default',
      disabledBuiltinSkillIds: [],
      skillIds: [],
      mcpIds: [],
    });
    agentSelectionMock.selectedAssistantBackend = 'claude';
    agentSelectionMock.currentAcpCachedModelInfo = {
      current_model_id: 'default',
      current_model_label: 'Default',
      available_models: [
        { id: 'default', label: 'Default' },
        { id: 'global.anthropic.claude-opus-4-8', label: 'Opus 4.8' },
      ],
    };

    const { rerender } = render(<GuidPage />);

    await vi.waitFor(() => {
      expect(agentSelectionMock.setSelectedAcpModel).toHaveBeenCalledWith('default', { persistPreference: false });
    });
    agentSelectionMock.setSelectedAcpModel.mockClear();

    const latestActionRowProps = capturedGuidActionRowProps.at(-1);
    const modelSelectorNode = latestActionRowProps?.modelSelectorNode as React.ReactElement<{
      setSelectedAcpModel: (model: string) => void;
    }>;
    const setSelectedAcpModel = modelSelectorNode.props.setSelectedAcpModel;
    setSelectedAcpModel('global.anthropic.claude-opus-4-8');

    expect(agentSelectionMock.setSelectedAcpModel).toHaveBeenCalledWith('global.anthropic.claude-opus-4-8', {
      persistPreference: false,
    });
    agentSelectionMock.setSelectedAcpModel.mockClear();

    agentSelectionMock.currentAcpCachedModelInfo = {
      current_model_id: 'default',
      current_model_label: 'Default',
      available_models: [
        { id: 'default', label: 'Default' },
        { id: 'global.anthropic.claude-opus-4-8', label: 'Opus 4.8' },
        { id: 'global.anthropic.claude-sonnet-4-8', label: 'Sonnet 4.8' },
      ],
    };
    rerender(<GuidPage />);

    expect(agentSelectionMock.setSelectedAcpModel).not.toHaveBeenCalledWith('default', {
      persistPreference: false,
    });
  });

  it('sends on Enter with empty input (empty-input start), matching the button', () => {
    guidInputMock.input = '';
    sendMock.isButtonDisabled = false;
    sendMock.sendMessageHandler.mockClear();

    render(<GuidPage />);

    const onKeyDown = capturedGuidInputCardProps.at(-1)?.onKeyDown as (event: unknown) => void;
    const preventDefault = vi.fn();
    onKeyDown({ key: 'Enter', shiftKey: false, preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    expect(sendMock.sendMessageHandler).toHaveBeenCalledTimes(1);
  });

  it('does not send on Enter while the send gate is disabled', () => {
    guidInputMock.input = '';
    sendMock.isButtonDisabled = true;
    sendMock.sendMessageHandler.mockClear();

    render(<GuidPage />);

    const onKeyDown = capturedGuidInputCardProps.at(-1)?.onKeyDown as (event: unknown) => void;
    onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: vi.fn() });

    expect(sendMock.sendMessageHandler).not.toHaveBeenCalled();

    // Restore shared mock state for later tests.
    sendMock.isButtonDisabled = false;
  });
});

describe('GuidInputCard prefill focus', () => {
  it('focuses a draft-preserving prefill on desktop', async () => {
    const { default: GuidInputCard } = await vi.importActual<
      typeof import('@/renderer/pages/guid/components/GuidInputCard')
    >('@/renderer/pages/guid/components/GuidInputCard');

    const originalDraft = 'Existing Guid draft';
    const { rerender } = render(
      <LayoutContext.Provider value={{ isMobile: false, siderCollapsed: false, setSiderCollapsed: vi.fn() }}>
        <GuidInputCard {...guidInputCardProps} input={originalDraft} focusRequestKey='desktop-prefill' />
      </LayoutContext.Provider>
    );

    const textarea = screen.getByTestId('guid-input');
    await waitFor(() => expect(textarea).toHaveFocus());
    expect((textarea as HTMLTextAreaElement).selectionStart).toBe(originalDraft.length);

    const outsideTarget = document.createElement('button');
    document.body.append(outsideTarget);
    outsideTarget.focus();
    rerender(
      <LayoutContext.Provider value={{ isMobile: false, siderCollapsed: false, setSiderCollapsed: vi.fn() }}>
        <GuidInputCard {...guidInputCardProps} focusRequestKey='desktop-prefill' />
      </LayoutContext.Provider>
    );
    await waitFor(() => expect(textarea).toHaveFocus());
    expect((textarea as HTMLTextAreaElement).selectionStart).toBe(guidInputCardProps.input.length);

    outsideTarget.focus();
    rerender(
      <LayoutContext.Provider value={{ isMobile: false, siderCollapsed: false, setSiderCollapsed: vi.fn() }}>
        <GuidInputCard {...guidInputCardProps} focusRequestKey='desktop-prefill' />
      </LayoutContext.Provider>
    );
    expect(outsideTarget).toHaveFocus();

    rerender(
      <LayoutContext.Provider value={{ isMobile: false, siderCollapsed: false, setSiderCollapsed: vi.fn() }}>
        <GuidInputCard {...guidInputCardProps} input={`${guidInputCardProps.input}!`} />
      </LayoutContext.Provider>
    );
    expect(outsideTarget).toHaveFocus();
    outsideTarget.remove();
  });

  it('does not force focus for a mobile prefill', async () => {
    const { default: GuidInputCard } = await vi.importActual<
      typeof import('@/renderer/pages/guid/components/GuidInputCard')
    >('@/renderer/pages/guid/components/GuidInputCard');

    render(
      <LayoutContext.Provider value={{ isMobile: true, siderCollapsed: false, setSiderCollapsed: vi.fn() }}>
        <GuidInputCard {...guidInputCardProps} focusRequestKey='mobile-prefill' />
      </LayoutContext.Provider>
    );

    expect(screen.getByTestId('guid-input')).not.toHaveFocus();
  });

  it('does not focus without an explicit request key', async () => {
    const { default: GuidInputCard } = await vi.importActual<
      typeof import('@/renderer/pages/guid/components/GuidInputCard')
    >('@/renderer/pages/guid/components/GuidInputCard');
    const outsideTarget = document.createElement('button');
    document.body.append(outsideTarget);
    outsideTarget.focus();

    render(
      <LayoutContext.Provider value={{ isMobile: false, siderCollapsed: false, setSiderCollapsed: vi.fn() }}>
        <GuidInputCard {...guidInputCardProps} />
      </LayoutContext.Provider>
    );

    expect(outsideTarget).toHaveFocus();
    outsideTarget.remove();
  });
});
