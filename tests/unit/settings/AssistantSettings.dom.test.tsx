/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from '@arco-design/web-react';
import { MemoryRouter } from 'react-router-dom';
import AssistantSettings from '@/renderer/pages/settings/AssistantSettings';
import EnabledAssistantsList from '@/renderer/pages/settings/AssistantSettings/home/EnabledAssistantsList';
import AssistantHomeTabs from '@/renderer/pages/settings/AssistantSettings/home/AssistantHomeTabs';
import MyAssistantsList from '@/renderer/pages/settings/AssistantSettings/home/MyAssistantsList';
import type { AssistantListItem } from '@/renderer/pages/settings/AssistantSettings/types';

const {
  useAssistantListMock,
  useAssistantEditorMock,
  messageSuccessMock,
  messageErrorMock,
  hthSyncAgentConfigsInvokeMock,
} = vi.hoisted(() => ({
  useAssistantListMock: vi.fn(),
  useAssistantEditorMock: vi.fn(),
  messageSuccessMock: vi.fn(),
  messageErrorMock: vi.fn(),
  hthSyncAgentConfigsInvokeMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'settings.hth.syncSuccess') {
        return 'HTH sync complete: {{success}} successful, {{failed}} failed'.replace(
          /\{\{(\w+)\}\}/g,
          (_match, optionKey: string) => String(options?.[optionKey] ?? '')
        );
      }
      if (key === 'settings.hth.syncAssistants') {
        return 'Sync from HTH';
      }
      return typeof options?.defaultValue === 'string' ? options.defaultValue : key;
    },
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return {
    ...actual,
    Message: {
      useMessage: () => [
        { success: messageSuccessMock, error: messageErrorMock, warning: vi.fn() },
        <div key='message-context' />,
      ],
    },
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    hth: {
      syncAgentConfigs: {
        invoke: hthSyncAgentConfigsInvokeMock,
      },
    },
  },
}));

vi.mock('@/renderer/hooks/agent/useManagedAgents', () => ({
  useManagedAgentRuntimeCatalog: () => [],
}));

vi.mock('@/renderer/hooks/assistant', () => ({
  useAssistantList: () => useAssistantListMock(),
  useAssistantEditor: (params: unknown) => useAssistantEditorMock(params),
}));

vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid='settings-wrapper'>{children}</div>,
}));

vi.mock('@/renderer/pages/settings/AssistantSettings/AssistantEditorPage', () => ({
  default: () => <div data-testid='assistant-editor-page' />,
}));

vi.mock('@/renderer/pages/settings/AssistantSettings/AssistantListPanel', () => ({
  default: () => <div data-testid='assistant-list-panel' />,
}));

vi.mock('@/renderer/utils/model/agentLogo', async () => {
  const actual = await vi.importActual<typeof import('@/renderer/utils/model/agentLogo')>(
    '@/renderer/utils/model/agentLogo'
  );
  return { ...actual, useAgentLogos: () => ({}) };
});

vi.mock('@/renderer/pages/settings/AssistantSettings/DeleteAssistantModal', () => ({
  default: () => null,
}));

vi.mock('@/renderer/pages/settings/AssistantSettings/SkillConfirmModals', () => ({
  default: () => null,
}));

vi.mock('@/renderer/pages/settings/AssistantSettings/assistantUtils', async () => {
  const actual = await vi.importActual<typeof import('@/renderer/pages/settings/AssistantSettings/assistantUtils')>(
    '@/renderer/pages/settings/AssistantSettings/assistantUtils'
  );

  return {
    ...actual,
    resolveAvatarImageSrc: (avatar?: string) => avatar,
  };
});

describe('AssistantSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAssistantListMock.mockReturnValue({
      assistants: [],
      activeAssistantId: 'assistant-1',
      setActiveAssistantId: vi.fn(),
      activeAssistant: null,
      loadAssistants: vi.fn(),
      reorderEnabledAssistants: vi.fn(),
      assistantOrder: [],
      setAssistantOrder: vi.fn(),
      localeKey: 'en-US',
    });

    useAssistantEditorMock.mockReturnValue({
      editVisible: true,
      isCreating: false,
      editName: '',
      setEditName: vi.fn(),
      editDescription: '',
      setEditDescription: vi.fn(),
      editAvatar: '',
      setEditAvatar: vi.fn(),
      editAgent: 'claude',
      setEditAgent: vi.fn(),
      editRecommendedPromptsText: '',
      setEditRecommendedPromptsText: vi.fn(),
      defaultModelMode: 'auto',
      setDefaultModelMode: vi.fn(),
      defaultModelValue: '',
      setDefaultModelValue: vi.fn(),
      defaultPermissionMode: 'auto',
      setDefaultPermissionMode: vi.fn(),
      defaultPermissionValue: '',
      setDefaultPermissionValue: vi.fn(),
      defaultSkillsMode: 'fixed',
      setDefaultSkillsMode: vi.fn(),
      defaultMcpMode: 'auto',
      setDefaultMcpMode: vi.fn(),
      availableMcpServers: [],
      selectedMcpIds: [],
      setSelectedMcpIds: vi.fn(),
      editContext: '',
      setEditContext: vi.fn(),
      promptViewMode: 'preview',
      setPromptViewMode: vi.fn(),
      availableSkills: [],
      selectedSkills: [],
      setSelectedSkills: vi.fn(),
      pendingSkills: [],
      setDeletePendingSkillName: vi.fn(),
      setDeleteCustomSkillName: vi.fn(),
      builtinAutoSkills: [],
      disabledBuiltinSkills: [],
      setDisabledBuiltinSkills: vi.fn(),
      handleSave: vi.fn(),
      handleDeleteClick: vi.fn(),
      handleDuplicate: vi.fn(),
      handleDeleteRequest: vi.fn(),
      handleToggleEnabled: vi.fn(),
      handleEdit: vi.fn(),
      handleCreate: vi.fn(),
      deleteConfirmVisible: false,
      setDeleteConfirmVisible: vi.fn(),
      deletePendingSkillName: null,
      deleteCustomSkillName: null,
      customSkills: [],
      setCustomSkills: vi.fn(),
      setPendingSkills: vi.fn(),
      handleDeleteConfirm: vi.fn(),
      setEditVisible: vi.fn(),
    });
  });

  it('summarizes HTH sync toast as successful and failed assistants only', async () => {
    const loadAssistants = vi.fn();
    useAssistantListMock.mockReturnValue({
      assistants: [],
      activeAssistantId: null,
      setActiveAssistantId: vi.fn(),
      activeAssistant: null,
      loadAssistants,
      reorderEnabledAssistants: vi.fn(),
      assistantOrder: [],
      setAssistantOrder: vi.fn(),
      localeKey: 'en-US',
    });
    useAssistantEditorMock.mockReturnValue({
      editVisible: false,
      isCreating: false,
      editName: '',
      setEditName: vi.fn(),
      editDescription: '',
      setEditDescription: vi.fn(),
      editAvatar: '',
      setEditAvatar: vi.fn(),
      editAgent: 'claude',
      setEditAgent: vi.fn(),
      editRecommendedPromptsText: '',
      setEditRecommendedPromptsText: vi.fn(),
      defaultModelMode: 'auto',
      setDefaultModelMode: vi.fn(),
      defaultModelValue: '',
      setDefaultModelValue: vi.fn(),
      defaultPermissionMode: 'auto',
      setDefaultPermissionMode: vi.fn(),
      defaultPermissionValue: '',
      setDefaultPermissionValue: vi.fn(),
      defaultSkillsMode: 'fixed',
      setDefaultSkillsMode: vi.fn(),
      defaultMcpMode: 'auto',
      setDefaultMcpMode: vi.fn(),
      availableMcpServers: [],
      selectedMcpIds: [],
      setSelectedMcpIds: vi.fn(),
      editContext: '',
      setEditContext: vi.fn(),
      promptViewMode: 'preview',
      setPromptViewMode: vi.fn(),
      availableSkills: [],
      selectedSkills: [],
      setSelectedSkills: vi.fn(),
      pendingSkills: [],
      setDeletePendingSkillName: vi.fn(),
      setDeleteCustomSkillName: vi.fn(),
      builtinAutoSkills: [],
      disabledBuiltinSkills: [],
      setDisabledBuiltinSkills: vi.fn(),
      handleSave: vi.fn(),
      handleDeleteClick: vi.fn(),
      handleDuplicate: vi.fn(),
      handleDeleteRequest: vi.fn(),
      handleToggleEnabled: vi.fn(),
      handleEdit: vi.fn(),
      handleCreate: vi.fn(),
      deleteConfirmVisible: false,
      setDeleteConfirmVisible: vi.fn(),
      deletePendingSkillName: null,
      deleteCustomSkillName: null,
      customSkills: [],
      setCustomSkills: vi.fn(),
      setPendingSkills: vi.fn(),
      handleDeleteConfirm: vi.fn(),
      setEditVisible: vi.fn(),
    });
    hthSyncAgentConfigsInvokeMock.mockResolvedValue({
      success: false,
      imported: 2,
      skipped: 1,
      updated: 1,
      deleted: 3,
      failed: 9,
      packages: [
        { id: 'assistant-1', name: 'Assistant 1', version: '1', status: 'synced' },
        { id: 'assistant-2', name: 'Assistant 2', version: '1', status: 'updated' },
        { id: 'assistant-3', name: 'Assistant 3', version: '1', status: 'skipped' },
        { id: 'assistant-4', name: 'Assistant 4', version: '1', status: 'synced' },
        { id: 'assistant-5', name: 'Assistant 5', version: '1', status: 'failed' },
      ],
    });

    render(
      <ConfigProvider>
        <MemoryRouter>
          <AssistantSettings />
        </MemoryRouter>
      </ConfigProvider>
    );

    fireEvent.click(screen.getByText('Sync from HTH'));

    await waitFor(() => {
      expect(messageSuccessMock).toHaveBeenCalledWith('HTH sync complete: 4 successful, 1 failed');
    });
    expect(loadAssistants).toHaveBeenCalled();
  });

  it('keeps the editor visible when an existing assistant session is open and activeAssistant is temporarily null', () => {
    render(
      <ConfigProvider>
        <MemoryRouter>
          <AssistantSettings />
        </MemoryRouter>
      </ConfigProvider>
    );

    expect(screen.getByTestId('assistant-editor-page')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-list-panel')).not.toBeInTheDocument();
  });

  it('renders enabled custom assistants only', () => {
    const assistants = [
      {
        id: 'cli',
        name: 'Codex',
        sort_order: 1,
        source: 'generated',
        enabled: true,
        agent: { type: 'acp', source: 'builtin', acp_backend: 'codex' },
      },
      {
        id: 'custom',
        name: 'My Writer',
        sort_order: 2,
        source: 'user',
        enabled: true,
        agent: { type: 'acp', source: 'builtin', acp_backend: 'gemini' },
      },
      {
        id: 'official',
        name: 'Cowork',
        sort_order: 3,
        source: 'builtin',
        enabled: true,
        agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' },
      },
      {
        id: 'disabled',
        name: 'Disabled',
        sort_order: 4,
        source: 'builtin',
        enabled: false,
      },
    ] as AssistantListItem[];

    render(
      <ConfigProvider>
        <EnabledAssistantsList
          assistants={assistants}
          assistantOrder={['official', 'custom', 'cli']}
          localeKey='en-US'
          searchActive={false}
          onOpenDetail={vi.fn()}
          onToggleEnabled={vi.fn()}
          onReorder={vi.fn()}
        />
      </ConfigProvider>
    );

    const rows = screen.getAllByTestId(/^enabled-assistant-row-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(['enabled-assistant-row-custom']);
    expect(screen.queryByTestId('enabled-assistant-row-disabled')).not.toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.queryByText('Official')).not.toBeInTheDocument();
    expect(screen.queryByText('CLI')).not.toBeInTheDocument();
    // Runtime engine is shown with a label + logo (same "Agent: {logo}" style as
    // the My Assistants cards, i18n key `assistantRuntimeLabel`), not a bare
    // backend name. The label renders once per enabled row.
    expect(screen.getAllByTestId(/^assistant-runtime-/).length).toBe(1);
    expect(screen.queryByText('claude')).not.toBeInTheDocument();
    // Each enabled row exposes an enable switch so users can disable in place.
    expect(screen.getByTestId('switch-enabled-custom')).toBeInTheDocument();
    expect(screen.queryByTestId('switch-enabled-official')).not.toBeInTheDocument();
    expect(screen.queryByTestId('switch-enabled-cli')).not.toBeInTheDocument();
  });

  it('hides official tab and filters home lists to custom assistants', () => {
    const assistants = [
      { id: 'cli', name: 'Codex CLI', sort_order: 1, source: 'generated', enabled: true },
      {
        id: 'custom-enabled',
        name: 'My Writer',
        sort_order: 2,
        source: 'user',
        enabled: true,
        categories: ['operations'],
      },
      {
        id: 'custom-disabled',
        name: 'Draft Bot',
        sort_order: 3,
        source: 'user',
        enabled: false,
        categories: ['customer_service'],
      },
      { id: 'official', name: 'Aion Butler', sort_order: 4, source: 'builtin', enabled: true },
    ] as AssistantListItem[];

    render(
      <ConfigProvider>
        <AssistantHomeTabs
          assistants={assistants}
          assistantOrder={['official', 'cli', 'custom-enabled']}
          localeKey='en-US'
          onOpenDetail={vi.fn()}
          onDelete={vi.fn()}
          onCreate={vi.fn()}
          onToggleEnabled={vi.fn()}
          onReorderEnabled={vi.fn()}
          onStartChat={vi.fn()}
          onSyncFromHTH={vi.fn()}
          syncingFromHTH={false}
        />
      </ConfigProvider>
    );

    expect(screen.getByTestId('settings-tab-enabled')).toBeInTheDocument();
    expect(screen.getByTestId('settings-tab-mine')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-tab-official')).not.toBeInTheDocument();
    expect(screen.getByTestId('enabled-assistant-row-custom-enabled')).toBeInTheDocument();
    expect(screen.queryByTestId('enabled-assistant-row-cli')).not.toBeInTheDocument();
    expect(screen.queryByTestId('enabled-assistant-row-official')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('settings-tab-mine'));

    expect(screen.getByTestId('my-assistants-pane')).toBeInTheDocument();
    expect(screen.getByText('My Writer')).toBeInTheDocument();
    expect(screen.getByText('Draft Bot')).toBeInTheDocument();
    expect(screen.queryByText('Codex CLI')).not.toBeInTheDocument();
    expect(screen.queryByText('Aion Butler')).not.toBeInTheDocument();
    expect(screen.queryByText(/local CLIs|Your own assistants/)).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-category-operations')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-category-customer_service')).toBeInTheDocument();
  });

  it('disables enabled-assistant dragging while search is active', () => {
    const assistants = [
      { id: 'cli', name: 'Codex', sort_order: 1, source: 'generated', enabled: true },
      { id: 'official', name: 'Cowork', sort_order: 2, source: 'builtin', enabled: true },
      { id: 'custom', name: 'Mine', sort_order: 3, source: 'user', enabled: true },
    ] as AssistantListItem[];

    render(
      <ConfigProvider>
        <EnabledAssistantsList
          assistants={assistants}
          assistantOrder={[]}
          localeKey='en-US'
          searchActive
          onOpenDetail={vi.fn()}
          onToggleEnabled={vi.fn()}
          onReorder={vi.fn()}
        />
      </ConfigProvider>
    );

    expect(screen.getByTestId('enabled-reorder-search-hint')).toHaveTextContent('Clear search to reorder.');
    expect(screen.getByTestId('enabled-assistant-reorder-handle-custom')).toBeDisabled();
    expect(screen.queryByTestId('enabled-assistant-reorder-handle-cli')).not.toBeInTheDocument();
    expect(screen.queryByTestId('enabled-assistant-reorder-handle-official')).not.toBeInTheDocument();
  });

  it('shows the concise enabled-assistant empty state', () => {
    render(
      <ConfigProvider>
        <EnabledAssistantsList
          assistants={[]}
          assistantOrder={[]}
          localeKey='en-US'
          searchActive={false}
          onOpenDetail={vi.fn()}
          onToggleEnabled={vi.fn()}
          onReorder={vi.fn()}
        />
      </ConfigProvider>
    );

    expect(screen.getByText('No assistants here yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Enable an official assistant/)).not.toBeInTheDocument();
  });

  it('does not offer chat creation in the empty My Assistants state', () => {
    render(
      <ConfigProvider>
        <MyAssistantsList
          assistants={[]}
          localeKey='en-US'
          onOpenDetail={vi.fn()}
          onDelete={vi.fn()}
          onToggleEnabled={vi.fn()}
          onStartChat={vi.fn()}
        />
      </ConfigProvider>
    );

    expect(screen.getByText("You don't have any assistants yet")).toBeInTheDocument();
    expect(screen.queryByTestId('created-empty-create')).not.toBeInTheDocument();
  });

  it('uses the homepage avatar treatment without cropping runtime logos', () => {
    const assistants = [
      {
        id: 'claude',
        name: 'Claude',
        avatar: 'https://example.com/claude.svg',
        sort_order: 1,
        source: 'user',
        enabled: true,
        agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' },
      },
    ] as AssistantListItem[];

    render(
      <ConfigProvider>
        <EnabledAssistantsList
          assistants={assistants}
          assistantOrder={[]}
          localeKey='en-US'
          searchActive={false}
          onOpenDetail={vi.fn()}
          onToggleEnabled={vi.fn()}
          onReorder={vi.fn()}
        />
      </ConfigProvider>
    );

    const row = screen.getByTestId('enabled-assistant-row-claude');
    expect(row.querySelector('.arco-avatar-circle')).toHaveStyle({ height: '20px', width: '20px' });
    expect(row.querySelector('img')).toHaveClass('object-contain');
  });
});
