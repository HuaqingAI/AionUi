/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfigProvider } from '@arco-design/web-react';
import { MemoryRouter } from 'react-router-dom';
import AssistantSettings from '@/renderer/pages/settings/AssistantSettings';
import EnabledAssistantsList from '@/renderer/pages/settings/AssistantSettings/home/EnabledAssistantsList';
import MyAssistantsList from '@/renderer/pages/settings/AssistantSettings/home/MyAssistantsList';
import type { AssistantListItem } from '@/renderer/pages/settings/AssistantSettings/types';
import { SWRConfig } from 'swr';

const useAssistantListMock = vi.fn();
const useAssistantEditorMock = vi.fn();
const hthMocks = vi.hoisted(() => ({
  checkAgentUpdates: vi.fn(),
  syncAgentConfigs: vi.fn(),
}));

vi.mock('@/common', async () => {
  const actual = await vi.importActual<typeof import('@/common')>('@/common');
  return {
    ...actual,
    ipcBridge: {
      ...actual.ipcBridge,
      hth: {
        ...actual.ipcBridge.hth,
        checkAgentUpdates: { invoke: hthMocks.checkAgentUpdates },
        syncAgentConfigs: { invoke: hthMocks.syncAgentConfigs },
      },
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown> & { defaultValue?: string }) => {
      const text = _key.startsWith('settings.assistantCategory.') ? _key : options?.defaultValue || _key;
      return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(options?.[key] ?? ''));
    },
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return {
    ...actual,
    Message: {
      useMessage: () => [{ success: vi.fn(), error: vi.fn(), warning: vi.fn() }, <div key='message-context' />],
    },
  };
});

vi.mock('@/renderer/hooks/assistant', () => ({
  useAssistantList: () => useAssistantListMock(),
  useAssistantEditor: (params: unknown) => useAssistantEditorMock(params),
}));

vi.mock('@/renderer/hooks/agent/useManagedAgents', () => ({
  useManagedAgentRuntimeCatalog: () => [],
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => null,
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
    hthMocks.checkAgentUpdates.mockReset().mockResolvedValue([]);
    hthMocks.syncAgentConfigs.mockReset();
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

  const renderHome = () => {
    useAssistantEditorMock.mockReturnValue({ ...useAssistantEditorMock(), editVisible: false });
    useAssistantListMock.mockReturnValue({
      ...useAssistantListMock(),
      assistants: [
        { id: 'hth-helper', name: 'HTH Helper', source: 'user', enabled: true, sort_order: 1 },
        { id: 'hth-current', name: 'Current Helper', source: 'user', enabled: true, sort_order: 2 },
        { id: 'custom', name: 'Local Helper', source: 'user', enabled: true, sort_order: 3 },
      ] as AssistantListItem[],
    });
    return render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}>
        <ConfigProvider>
          <MemoryRouter>
            <AssistantSettings />
          </MemoryRouter>
        </ConfigProvider>
      </SWRConfig>
    );
  };

  it('checks versions without synchronizing and marks updated avatars in both assistant tabs', async () => {
    hthMocks.checkAgentUpdates.mockResolvedValue([
      { assistantId: 'hth-helper', localVersion: '1.0.0', remoteVersion: '1.0.1', updateAvailable: true },
      { assistantId: 'hth-current', localVersion: '1.0.0', remoteVersion: '1.0.0', updateAvailable: false },
    ]);
    renderHome();

    const updateBadge = await screen.findByTestId('assistant-update-hth-helper');
    expect(updateBadge).toHaveAccessibleName('New version available');
    expect(updateBadge.querySelector('.arco-badge-dot')).toBeVisible();
    expect(screen.queryByTestId('assistant-update-hth-current')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-update-custom')).not.toBeInTheDocument();
    expect(hthMocks.syncAgentConfigs).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('My Assistants'));
    const cardBadge = within(screen.getByTestId('assistant-card-hth-helper')).getByTestId(
      'assistant-update-hth-helper'
    );
    expect(cardBadge.querySelector('.arco-badge-dot')).toBeVisible();
    fireEvent.mouseEnter(cardBadge);
    expect(await screen.findByText('1.0.0 → 1.0.1. Click Sync Assistants to update.')).toBeVisible();
  });

  it('keeps local assistants usable when checking versions fails', async () => {
    hthMocks.checkAgentUpdates.mockRejectedValue(new Error('Offline'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderHome();

    await waitFor(() => expect(warning).toHaveBeenCalled());
    expect(screen.getByTestId('enabled-assistant-row-custom')).toHaveTextContent('Local Helper');
    expect(screen.queryByTestId('assistant-update-hth-helper')).not.toBeInTheDocument();
    warning.mockRestore();
  });

  it('synchronizes changed assistants and clears their version badges after successful installation', async () => {
    hthMocks.checkAgentUpdates
      .mockResolvedValueOnce([
        { assistantId: 'hth-helper', localVersion: '1.0.0', remoteVersion: '1.0.1', updateAvailable: true },
      ])
      .mockResolvedValue([
        { assistantId: 'hth-helper', localVersion: '1.0.1', remoteVersion: '1.0.1', updateAvailable: false },
      ]);
    hthMocks.syncAgentConfigs.mockResolvedValue({
      success: true,
      imported: 0,
      skipped: 0,
      failed: 0,
      updated: 1,
      packages: [{ id: 'hth-helper', name: 'HTH Helper', version: '1.0.1', status: 'updated' }],
    });
    renderHome();
    await screen.findByTestId('assistant-update-hth-helper');

    fireEvent.click(screen.getByRole('button', { name: 'settings.HTH.syncAssistants' }));

    await waitFor(() => expect(screen.queryByTestId('assistant-update-hth-helper')).not.toBeInTheDocument());
    expect(hthMocks.syncAgentConfigs).toHaveBeenCalledWith({
      incremental: true,
      force: false,
      syncId: expect.any(String),
    });
    expect(useAssistantListMock().loadAssistants).toHaveBeenCalled();
  });

  it('preserves version badges when synchronizing fails', async () => {
    hthMocks.checkAgentUpdates.mockResolvedValue([
      { assistantId: 'hth-helper', localVersion: '1.0.0', remoteVersion: '1.0.1', updateAvailable: true },
    ]);
    hthMocks.syncAgentConfigs.mockRejectedValue(new Error('Download failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderHome();
    await screen.findByTestId('assistant-update-hth-helper');

    fireEvent.click(screen.getByRole('button', { name: 'settings.HTH.syncAssistants' }));

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(screen.getByTestId('assistant-update-hth-helper')).toBeInTheDocument();
    error.mockRestore();
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

  it('renders only enabled user assistants in the preferred order', () => {
    const assistants = [
      {
        id: 'cli',
        name: 'Codex',
        sort_order: 1,
        source: 'user',
        enabled: true,
        agent: { type: 'acp', source: 'builtin', acp_backend: 'codex' },
      },
      {
        id: 'custom',
        name: 'My Writer',
        sort_order: 2,
        source: 'user',
        enabled: true,
        agent: { type: 'acp', source: 'builtin', acp_backend: 'opencode' },
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
        source: 'user',
        enabled: false,
      },
      { id: 'generated', name: 'Generated', sort_order: 5, source: 'generated', enabled: true },
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
          onStartChat={vi.fn()}
        />
      </ConfigProvider>
    );

    const rows = screen.getAllByTestId(/^enabled-assistant-row-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'enabled-assistant-row-custom',
      'enabled-assistant-row-cli',
    ]);
    expect(screen.queryByTestId('enabled-assistant-row-disabled')).not.toBeInTheDocument();
    expect(screen.queryByTestId('enabled-assistant-row-official')).not.toBeInTheDocument();
    expect(screen.queryByTestId('enabled-assistant-row-generated')).not.toBeInTheDocument();
    expect(screen.getAllByText('Custom')).toHaveLength(2);
    // Runtime engine is shown with a label + logo (same "Agent: {logo}" style as
    // the My Assistants cards, i18n key `assistantRuntimeLabel`), not a bare
    // backend name. The label renders once per enabled row.
    expect(screen.getAllByTestId(/^assistant-runtime-/).length).toBe(2);
    expect(screen.queryByText('claude')).not.toBeInTheDocument();
    // Each enabled row exposes an enable switch so users can disable in place.
    expect(screen.getByTestId('switch-enabled-custom')).toBeInTheDocument();
    expect(screen.getByTestId('switch-enabled-cli')).toBeInTheDocument();
  });

  it('disables enabled-assistant dragging while search is active', () => {
    const assistants = [
      { id: 'cli', name: 'Codex', sort_order: 1, source: 'user', enabled: true },
      { id: 'custom', name: 'My Writer', sort_order: 2, source: 'user', enabled: true },
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
          onStartChat={vi.fn()}
        />
      </ConfigProvider>
    );

    expect(screen.getByTestId('enabled-reorder-search-hint')).toHaveTextContent('Clear search to reorder.');
    expect(screen.getByTestId('enabled-assistant-reorder-handle-cli')).toBeDisabled();
    expect(screen.getByTestId('enabled-assistant-reorder-handle-custom')).toBeDisabled();
  });

  it('exposes a quick-chat button on each enabled row and fires onStartChat', () => {
    const onStartChat = vi.fn();
    const onOpenDetail = vi.fn();
    const assistants = [
      {
        id: 'cli',
        name: 'Codex',
        sort_order: 1,
        source: 'user',
        enabled: true,
        agent: { type: 'acp', source: 'builtin', acp_backend: 'codex' },
      },
    ] as AssistantListItem[];

    render(
      <ConfigProvider>
        <EnabledAssistantsList
          assistants={assistants}
          assistantOrder={[]}
          localeKey='en-US'
          searchActive={false}
          onOpenDetail={onOpenDetail}
          onToggleEnabled={vi.fn()}
          onReorder={vi.fn()}
          onStartChat={onStartChat}
        />
      </ConfigProvider>
    );

    const chatButton = screen.getByTestId('btn-chat-cli');
    expect(chatButton).toBeInTheDocument();

    fireEvent.click(chatButton);
    // Clicking chat starts a conversation and must not open the detail editor.
    expect(onStartChat).toHaveBeenCalledTimes(1);
    expect(onStartChat).toHaveBeenCalledWith(expect.objectContaining({ id: 'cli' }));
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('uses the homepage avatar treatment without cropping runtime logos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('<svg></svg>') }))
    );
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
          onStartChat={vi.fn()}
        />
      </ConfigProvider>
    );

    // Wait for ThemedLogo detection to settle
    await act(async () => {
      await Promise.resolve();
    });

    const row = screen.getByTestId('enabled-assistant-row-claude');
    expect(row.querySelector('.arco-avatar-circle')).toHaveStyle({ height: '20px', width: '20px' });
    const logo = row.querySelector('img, span[role="img"]');
    expect(logo).not.toBeNull();
    expect(logo).toHaveClass('object-contain');
    vi.unstubAllGlobals();
  });
});

const categoryAssistant = (overrides: Partial<AssistantListItem>): AssistantListItem => ({
  id: 'hth-general',
  name: 'General Helper',
  source: 'user',
  enabled: true,
  sort_order: 1,
  name_i18n: {},
  description_i18n: {},
  agent_id: 'agent-1',
  agent_status: 'online',
  enabled_skills: [],
  custom_skill_names: [],
  disabled_builtin_skills: [],
  context_i18n: {},
  prompts: [],
  prompts_i18n: {},
  models: [],
  team_selectable: true,
  deletable: true,
  ...overrides,
});

const categoryAssistants = [
  categoryAssistant({ categories: ['general'] }),
  categoryAssistant({
    id: 'hth-amazon',
    name: 'Amazon Helper',
    categories: ['amazon_operations', 'marketing'],
    sort_order: 2,
  }),
  categoryAssistant({
    id: 'hth-amazon-disabled',
    name: 'Disabled Amazon Helper',
    categories: ['amazon_operations'],
    enabled: false,
    sort_order: 3,
  }),
  categoryAssistant({ id: 'manual', name: 'Local Helper', categories: ['amazon_operations'], sort_order: 4 }),
  categoryAssistant({ id: 'hth-unknown', name: 'Unknown Category', categories: ['unknown'], sort_order: 5 }),
  categoryAssistant({ id: 'hth-uncategorized', name: 'Uncategorized Helper', sort_order: 6 }),
];

const renderMyAssistants = (props: Partial<React.ComponentProps<typeof MyAssistantsList>> = {}) =>
  render(
    <ConfigProvider>
      <MyAssistantsList
        assistants={categoryAssistants}
        localeKey='en-US'
        onOpenDetail={vi.fn()}
        onDelete={vi.fn()}
        onToggleEnabled={vi.fn()}
        onStartChat={vi.fn()}
        {...props}
      />
    </ConfigProvider>
  );

describe('MyAssistantsList category tabs', () => {
  it('shows every populated category in the requested order with custom assistants last', () => {
    renderMyAssistants({
      assistants: [
        categoryAssistant({
          categories: [
            'administration',
            'hr',
            'finance',
            'market',
            'logistics',
            'customer_service',
            'design',
            'marketing',
            'dtc_operations',
            'amazon_operations',
            'general',
          ],
        }),
        categoryAssistant({ id: 'manual' }),
      ],
    });

    const tabs = within(screen.getByRole('tablist', { name: 'My Assistants' })).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'All',
      'settings.assistantCategory.general',
      'settings.assistantCategory.amazon_operations',
      'settings.assistantCategory.dtc_operations',
      'settings.assistantCategory.marketing',
      'settings.assistantCategory.design',
      'settings.assistantCategory.customer_service',
      'settings.assistantCategory.logistics',
      'settings.assistantCategory.market',
      'settings.assistantCategory.finance',
      'settings.assistantCategory.hr',
      'settings.assistantCategory.administration',
      'settings.assistantCategory.custom_assistant',
    ]);
    expect(screen.getByRole('tab', { name: 'All', selected: true })).toBeVisible();
  });

  it('hides categories with no assistants while keeping All available', () => {
    renderMyAssistants();

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'All',
      'settings.assistantCategory.general',
      'settings.assistantCategory.amazon_operations',
      'settings.assistantCategory.marketing',
      'settings.assistantCategory.custom_assistant',
    ]);
  });

  it('filters by category and restores each assistant once when All is selected again', () => {
    renderMyAssistants();
    expect(screen.getAllByTestId(/^assistant-card-/)).toHaveLength(6);

    fireEvent.click(screen.getByRole('tab', { name: 'settings.assistantCategory.amazon_operations' }));
    expect(screen.getAllByTestId(/^assistant-card-/).map((card) => card.getAttribute('data-testid'))).toEqual([
      'assistant-card-hth-amazon',
      'assistant-card-hth-amazon-disabled',
    ]);

    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getAllByTestId(/^assistant-card-/)).toHaveLength(6);
  });

  it('supports selecting a category with Enter and exposes its selected state', () => {
    renderMyAssistants();
    const marketing = screen.getByRole('tab', { name: 'settings.assistantCategory.marketing' });

    marketing.focus();
    fireEvent.keyDown(marketing, { key: 'Enter', code: 'Enter', keyCode: 13 });

    expect(marketing).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByTestId(/^assistant-card-/).map((card) => card.getAttribute('data-testid'))).toEqual([
      'assistant-card-hth-amazon',
    ]);
  });

  it('keeps manual assistants in Custom and defaults unrecognized synced categories to General', () => {
    renderMyAssistants();

    fireEvent.click(screen.getByRole('tab', { name: 'settings.assistantCategory.custom_assistant' }));
    expect(screen.getAllByTestId(/^assistant-card-/).map((card) => card.getAttribute('data-testid'))).toEqual([
      'assistant-card-manual',
    ]);

    fireEvent.click(screen.getByRole('tab', { name: 'settings.assistantCategory.general' }));
    expect(screen.getAllByTestId(/^assistant-card-/).map((card) => card.getAttribute('data-testid'))).toEqual([
      'assistant-card-hth-general',
      'assistant-card-hth-unknown',
      'assistant-card-hth-uncategorized',
    ]);
  });

  it('combines category and status filters without removing categories when there are no matches', async () => {
    renderMyAssistants();
    fireEvent.click(screen.getByRole('tab', { name: 'settings.assistantCategory.amazon_operations' }));
    fireEvent.click(screen.getByTestId('assistant-enabled-filter'));
    fireEvent.click(await screen.findByTestId('filter-option-disabled'));

    expect(screen.getAllByTestId(/^assistant-card-/).map((card) => card.getAttribute('data-testid'))).toEqual([
      'assistant-card-hth-amazon-disabled',
    ]);

    fireEvent.click(screen.getByRole('tab', { name: 'settings.assistantCategory.marketing' }));
    expect(screen.getByText('No assistants match the current filters.')).toBeVisible();
    expect(screen.queryByTestId('created-empty')).not.toBeInTheDocument();
  });

  it('retains populated category tabs when search narrows the displayed assistant list', () => {
    renderMyAssistants({
      assistants: [categoryAssistants[3]],
      categoryAssistants,
      searchActive: true,
    });
    fireEvent.click(screen.getByRole('tab', { name: 'settings.assistantCategory.amazon_operations' }));

    expect(screen.getByText('No assistants match the current filters.')).toBeVisible();
    expect(screen.queryAllByTestId(/^assistant-card-/)).toHaveLength(0);

    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getByTestId('assistant-card-manual')).toBeVisible();
  });

  it('keeps All and the creation empty state when there are no user assistants', () => {
    renderMyAssistants({ assistants: [] });

    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'All', selected: true })).toBeVisible();
    expect(screen.getByTestId('created-empty')).toBeVisible();
  });

  it('returns to All when the selected category no longer has any assistants', () => {
    const { rerender } = renderMyAssistants();
    fireEvent.click(screen.getByRole('tab', { name: 'settings.assistantCategory.amazon_operations' }));

    rerender(
      <ConfigProvider>
        <MyAssistantsList
          assistants={[categoryAssistants[3]]}
          localeKey='en-US'
          onOpenDetail={vi.fn()}
          onDelete={vi.fn()}
          onToggleEnabled={vi.fn()}
          onStartChat={vi.fn()}
        />
      </ConfigProvider>
    );

    expect(screen.queryByRole('tab', { name: 'settings.assistantCategory.amazon_operations' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All', selected: true })).toBeVisible();
    expect(screen.getByTestId('assistant-card-manual')).toBeVisible();
  });
});
