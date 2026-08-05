/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Render test for the LocalAgents settings surface. Its purpose is to lock in
 * that LocalAgents reads the management view (`useManagedAgents`) and renders
 * the narrowed diagnostics list for visible local runtimes.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

// t() echoes the key so section labels/buttons are assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

const { messageSuccess, messageWarning, messageError } = vi.hoisted(() => ({
  messageSuccess: vi.fn(),
  messageWarning: vi.fn(),
  messageError: vi.fn(),
}));
vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return {
    ...actual,
    Message: {
      useMessage: () => [
        {
          success: messageSuccess,
          warning: messageWarning,
          error: messageError,
        },
        null,
      ],
      success: messageSuccess,
      warning: messageWarning,
      error: messageError,
    },
  };
});

// Controlled management-view data; assert LocalAgents consumes THIS hook.
const useManagedAgents = vi.fn();
vi.mock('@renderer/hooks/agent/useManagedAgents', () => ({
  useManagedAgents: () => useManagedAgents(),
}));

// Bridge is only touched by user-action handlers, not on render - stub the
// shape the handlers reference so the import resolves.
vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      createCustomAgent: { invoke: vi.fn() },
      updateCustomAgent: { invoke: vi.fn() },
      deleteCustomAgent: { invoke: vi.fn() },
      setAgentEnabled: { invoke: vi.fn() },
      checkManagedAgentHealthById: { invoke: vi.fn() },
    },
    runtime: {
      statusChanged: { on: vi.fn(() => vi.fn()) },
      localStatusChanged: { on: vi.fn(() => vi.fn()) },
    },
    // Bound-assistant avatar stacks fetch the assistant list via SWR.
    assistants: {
      list: { invoke: vi.fn().mockResolvedValue([]) },
    },
  },
}));

// Keep the test focused on LocalAgents' own logic - stub heavy children.
vi.mock('@/renderer/components/base/AionModal', () => ({
  default: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? <div data-testid='aion-modal'>{children}</div> : null,
}));
vi.mock('@renderer/pages/settings/AgentSettings/InlineAgentEditor', () => ({
  default: () => <div data-testid='inline-agent-editor' />,
}));
vi.mock('@renderer/pages/settings/AgentSettings/AgentHubModal', () => ({ AgentHubModal: () => null }));

import LocalAgents from '@renderer/pages/settings/AgentSettings/LocalAgents';
import AgentModalContent from '@renderer/components/settings/SettingsModal/contents/AgentModalContent';
import { SettingsViewModeProvider } from '@renderer/components/settings/SettingsModal/settingsViewContext';
import { ipcBridge } from '@/common';
import { MemoryRouter } from 'react-router-dom';
import { getBoundAssistants } from '@renderer/pages/settings/AgentSettings/BoundAssistants';
import type { Assistant } from '@/common/types/agent/assistantTypes';

const makeAgents = () => [
  {
    id: 'codex',
    name: 'Codex',
    agent_type: 'acp',
    agent_source: 'builtin',
    backend: 'codex',
    enabled: true,
    available: true,
    installed: true,
    status: 'online',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    agent_type: 'acp',
    agent_source: 'builtin',
    backend: 'opencode',
    enabled: true,
    available: false,
    installed: false,
    status: 'missing',
  },
  {
    id: 'aionrs',
    name: 'Aion CLI',
    agent_type: 'aionrs',
    agent_source: 'internal',
    backend: 'aionrs',
    enabled: true,
    available: true,
    installed: true,
    status: 'online',
  },
  {
    id: 'acp-claude',
    name: 'Claude Code',
    agent_type: 'acp',
    agent_source: 'builtin',
    backend: 'claude',
    enabled: true,
    available: false,
    installed: false,
    status: 'missing',
  },
  {
    id: 'acp-kimi',
    name: 'Kimi',
    agent_type: 'acp',
    agent_source: 'builtin',
    backend: 'kimi',
    enabled: true,
    available: false,
    installed: false,
    status: 'missing',
  },
  {
    id: 'openclaw-gateway',
    name: 'OpenClaw Gateway',
    agent_type: 'openclaw-gateway',
    agent_source: 'builtin',
    backend: 'openclaw-gateway',
    enabled: true,
    available: false,
    installed: false,
    status: 'missing',
  },
  {
    id: 'custom-1',
    name: 'My Agent',
    agent_type: 'acp',
    agent_source: 'custom',
    command: 'sh',
    enabled: true,
    available: true,
    installed: true,
    status: 'offline',
  },
];

describe('LocalAgents', () => {
  it('runs the health probe and shows a success toast after a visible-agent test connection succeeds', async () => {
    const refreshCatalog = vi.fn().mockResolvedValue(undefined);
    useManagedAgents.mockReturnValue({ agents: makeAgents(), revalidate: vi.fn(), refreshCatalog });
    vi.mocked(ipcBridge.acpConversation.checkManagedAgentHealthById.invoke).mockResolvedValue({
      ...makeAgents()[0],
      status: 'online',
    });

    render(<LocalAgents />);

    fireEvent.click(screen.getByTestId('agent-row-test-codex'));

    await waitFor(() => {
      expect(ipcBridge.acpConversation.checkManagedAgentHealthById.invoke).toHaveBeenCalledWith({ id: 'codex' });
    });
    await waitFor(() => {
      expect(refreshCatalog).toHaveBeenCalled();
      expect(messageSuccess).toHaveBeenCalledWith('settings.agentManagement.testConnectionOnline');
    });
  });

  it('warns with the auth guidance when a test connection reports auth_required', async () => {
    const refreshCatalog = vi.fn().mockResolvedValue(undefined);
    useManagedAgents.mockReturnValue({ agents: makeAgents(), revalidate: vi.fn(), refreshCatalog });
    vi.mocked(ipcBridge.acpConversation.checkManagedAgentHealthById.invoke).mockResolvedValue({
      ...makeAgents()[0],
      status: 'offline',
      last_check_error_code: 'auth_required',
    });

    render(<LocalAgents />);

    fireEvent.click(screen.getByTestId('agent-row-test-codex'));

    await waitFor(() => {
      expect(messageWarning).toHaveBeenCalledWith('settings.agentManagement.errorCodes.auth_required');
    });
  });

  it('reads the managed-agents view and renders only Codex and OpenCode in the official section', () => {
    useManagedAgents.mockReturnValue({
      agents: makeAgents(),
      revalidate: vi.fn(),
      refreshCatalog: vi.fn(),
    });

    render(<LocalAgents />);

    expect(useManagedAgents).toHaveBeenCalled();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('OpenCode')).toBeTruthy();
    expect(screen.queryByText('Aion CLI')).toBeNull();
    expect(screen.queryByText('Claude Code')).toBeNull();
    expect(screen.queryByText('Kimi')).toBeNull();
    expect(screen.getByText('My Agent')).toBeTruthy();
    expect(screen.queryByText('OpenClaw Gateway')).toBeNull();
  });

  it('shows the empty state when no visible local agents are present', () => {
    useManagedAgents.mockReturnValue({
      agents: makeAgents().filter(
        (agent) => agent.backend !== 'codex' && agent.backend !== 'opencode' && agent.agent_source !== 'custom'
      ),
      revalidate: vi.fn(),
      refreshCatalog: vi.fn(),
    });

    render(<LocalAgents />);

    expect(screen.getByText('settings.agentManagement.localAgentsEmpty')).toBeTruthy();
    expect(screen.getByText('settings.agentManagement.customAgents')).toBeTruthy();
    expect(screen.getByText('settings.agentManagement.customEmpty')).toBeTruthy();
  });

  it('keeps the custom agent controls while removing setup guidance and unavailable filter controls', () => {
    useManagedAgents.mockReturnValue({
      agents: makeAgents(),
      revalidate: vi.fn(),
      refreshCatalog: vi.fn(),
    });

    render(<LocalAgents />);

    expect(screen.getByText('settings.agentManagement.localAgentsDescription')).toBeTruthy();
    expect(screen.queryByText('settings.agentManagement.localAgentsSetupLink')).toBeNull();
    expect(screen.getByTestId('btn-add-custom-agent')).toBeTruthy();
    expect(screen.getByTestId('agent-management-custom-header')).toBeTruthy();
    expect(screen.getByTestId('agent-management-custom-section')).toBeTruthy();
    expect(screen.getByText('My Agent')).toBeTruthy();
    expect(screen.queryByTestId('settings-tab-unavailable')).toBeNull();
  });

  it('shows a lightweight refresh hint while the management view is revalidating', () => {
    useManagedAgents.mockReturnValue({
      agents: makeAgents(),
      isRefreshing: true,
      revalidate: vi.fn(),
      refreshCatalog: vi.fn(),
    });

    render(<LocalAgents />);

    expect(screen.getByText('settings.agentManagement.refreshingStatuses')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
  });

  it('does not render the market-install CTA in the diagnostics-only agent page', () => {
    useManagedAgents.mockReturnValue({
      agents: makeAgents(),
      revalidate: vi.fn(),
      refreshCatalog: vi.fn(),
    });

    render(<LocalAgents />);

    expect(screen.queryByText('settings.agentManagement.installFromMarket')).toBeNull();
    expect(screen.queryByText('settings.agentManagement.discoverMoreAgents')).toBeNull();
  });

  it('binds assistants to managed agents by agent_id instead of runtime backend', () => {
    const agents = makeAgents();
    const codexAgent = agents.find((agent) => agent.id === 'codex')!;
    const claudeAgent = agents.find((agent) => agent.id === 'acp-claude')!;
    const assistants: Assistant[] = [
      {
        id: 'assistant-on-claude-runtime',
        source: 'generated',
        name: 'Claude Runtime',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 1,
        agent_id: 'acp-other-claude',
        preset_agent_type: 'claude',
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
      },
      {
        id: 'assistant-on-claude-agent',
        source: 'generated',
        name: 'Claude Agent',
        name_i18n: {},
        description_i18n: {},
        enabled: true,
        sort_order: 2,
        agent_id: 'acp-claude',
        preset_agent_type: 'claude',
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
      },
    ];

    expect(getBoundAssistants(claudeAgent, assistants).map((assistant) => assistant.id)).toEqual([
      'assistant-on-claude-agent',
    ]);
    expect(getBoundAssistants(codexAgent, assistants)).toEqual([]);
  });

  it('renders agent management as a single diagnostics page without local/remote tabs', () => {
    useManagedAgents.mockReturnValue({
      agents: makeAgents(),
      revalidate: vi.fn(),
      refreshCatalog: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/settings/agents?tab=remote']}>
        <SettingsViewModeProvider value='page'>
          <AgentModalContent />
        </SettingsViewModeProvider>
      </MemoryRouter>
    );

    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.queryByText('settings.agentManagement.localAgents')).toBeNull();
  });

  it('surfaces custom-agent toggle failures to the user', async () => {
    const refreshCatalog = vi.fn().mockResolvedValue(undefined);
    useManagedAgents.mockReturnValue({
      agents: makeAgents(),
      revalidate: vi.fn(),
      refreshCatalog,
    });
    vi.mocked(ipcBridge.acpConversation.setAgentEnabled.invoke).mockRejectedValueOnce({
      backendMessage: 'permission denied',
    });

    render(<LocalAgents />);

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(ipcBridge.acpConversation.setAgentEnabled.invoke).toHaveBeenCalledWith({
        id: 'custom-1',
        enabled: false,
      });
      expect(messageError).toHaveBeenCalledWith('permission denied');
    });
    expect(refreshCatalog).not.toHaveBeenCalled();
  });

  it('renders only all and available tabs, and the available tab excludes hidden online agents', () => {
    useManagedAgents.mockReturnValue({
      agents: makeAgents(),
      revalidate: vi.fn(),
      refreshCatalog: vi.fn(),
    });

    render(<LocalAgents />);

    const allTab = screen.getByTestId('settings-tab-all');
    const availableTab = screen.getByTestId('settings-tab-available');
    expect(allTab.tagName).toBe('BUTTON');
    expect(screen.queryByTestId('settings-tab-unavailable')).toBeNull();

    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('OpenCode')).toBeInTheDocument();
    expect(screen.queryByText('Aion CLI')).toBeNull();

    fireEvent.click(availableTab);
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.queryByText('OpenCode')).toBeNull();
    expect(screen.queryByText('Aion CLI')).toBeNull();
  });
});
