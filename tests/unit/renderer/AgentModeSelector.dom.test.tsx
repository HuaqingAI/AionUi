/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import AgentModeSelector from '@/renderer/components/agent/AgentModeSelector';
import enUS from '@/renderer/services/i18n/locales/en-US/agentMode.json';
import zhCN from '@/renderer/services/i18n/locales/zh-CN/agentMode.json';

const { useAcpConfigOptionsMock } = vi.hoisted(() => ({
  useAcpConfigOptionsMock: vi.fn(),
}));

vi.mock('@/renderer/hooks/agent/useAcpConfigOptions', () => ({
  classifyConfigSetError: () => 'unknown',
  useAcpConfigOptions: useAcpConfigOptionsMock,
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/components/agent/MarqueePillLabel', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

const menuContext = React.createContext<((key: string) => void) | null>(null);

vi.mock('@icon-park/react', () => ({
  Down: () => <span aria-hidden='true'>v</span>,
  Loading: ({ className }: { className?: string }) => <span aria-hidden='true' className={className} />,
  Robot: ({ className }: { className?: string }) => <span aria-hidden='true' className={className} />,
}));

vi.mock('@arco-design/web-react', () => {
  const Menu = Object.assign(
    ({ children, onClickMenuItem }: { children?: React.ReactNode; onClickMenuItem?: (key: string) => void }) => (
      <menuContext.Provider value={onClickMenuItem ?? null}>{children}</menuContext.Provider>
    ),
    {
      ItemGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
      Item: ({ children }: { children?: React.ReactNode }) => {
        const onClickMenuItem = React.useContext(menuContext);
        const child = React.isValidElement(children) ? children : null;
        const itemKey = child?.props?.['data-mode-value'] as string | undefined;
        return (
          <button type='button' onClick={() => itemKey && onClickMenuItem?.(itemKey)}>
            {children}
          </button>
        );
      },
    }
  );
  return {
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type='button' {...props}>
        {children}
      </button>
    ),
    Dropdown: ({ children, droplist }: { children?: React.ReactNode; droplist?: React.ReactNode }) => (
      <>
        {children}
        {droplist}
      </>
    ),
    Menu,
    Message: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    Tooltip: ({ children, content }: { children?: React.ReactNode; content?: React.ReactNode }) => (
      <span data-tooltip-content={typeof content === 'string' ? content : undefined}>{children}</span>
    ),
  };
});

const modeI18n = createInstance();

const runtimeMode = () => ({
  id: 'mode',
  category: 'mode',
  currentValue: 'default',
  options: [
    { value: 'default', label: 'Default', description: 'Ask before sensitive changes' },
    { value: 'bypassPermissions', label: 'Bypass Permissions', description: 'Run without permission prompts' },
  ],
});

describe('AgentModeSelector', () => {
  beforeAll(async () => {
    await modeI18n.use(initReactI18next).init({
      lng: 'zh-CN',
      fallbackLng: 'en-US',
      resources: {
        'en-US': { translation: { agentMode: enUS } },
        'zh-CN': { translation: { agentMode: zhCN } },
      },
      interpolation: { escapeValue: false },
    });
  });

  beforeEach(async () => {
    await modeI18n.changeLanguage('zh-CN');
    vi.clearAllMocks();
    useAcpConfigOptionsMock.mockImplementation(() => ({
      setStatus: { state: 'idle' },
      isLoading: false,
      mode: runtimeMode(),
      model: null,
      thoughtLevel: null,
      reload: vi.fn(),
      setConfigOption: vi.fn(),
    }));
  });

  it('keeps observed runtime mode after rerender when initialMode is stale', async () => {
    const { rerender } = render(
      <AgentModeSelector
        backend='claude'
        conversation_id='conv-1'
        compact
        initialMode='bypassPermissions'
        modeLabelFormatter={(mode) => (mode.value === 'default' ? '默认' : '全自动')}
        compactLabelPrefix='权限'
      />
    );

    await waitFor(() => expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'default'));

    rerender(
      <AgentModeSelector
        backend='claude'
        conversation_id='conv-1'
        compact
        initialMode='bypassPermissions'
        modeLabelFormatter={(mode) => (mode.value === 'default' ? '默认' : '全自动')}
        compactLabelPrefix='权限'
      />
    );

    await waitFor(() => expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'default'));
    expect(screen.getByText('权限 · 默认')).toBeInTheDocument();
  });

  // A switch the backend accepted but has not applied yet (codex always, claude/agy
  // mid-turn) must not move the pill onto the requested mode: the pill answers "what
  // permission is governing right now", and showing the target would tell the user a
  // tightening had landed when it had not. The target rides alongside instead, and the
  // "权限 · " prefix is dropped to pay for the extra width (the shield icon already says
  // it is the permission pill).
  it('shows a pending target without moving the pill off the mode still in force', async () => {
    useAcpConfigOptionsMock.mockImplementation(() => ({
      setStatus: { state: 'idle' },
      isLoading: false,
      mode: runtimeMode(),
      model: null,
      thoughtLevel: null,
      reload: vi.fn(),
      setConfigOption: vi.fn(),
      pendingValues: { mode: 'bypassPermissions' },
    }));

    render(
      <AgentModeSelector
        backend='claude'
        conversation_id='conv-1'
        compact
        modeLabelFormatter={(mode) => (mode.value === 'default' ? '默认' : '全自动')}
        compactLabelPrefix='权限'
      />
    );

    await waitFor(() => expect(screen.getByText('默认 → 全自动')).toBeInTheDocument());
    expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'default');
  });

  // Picking a mode the backend defers must NOT be reported as a failure, and must not
  // move the pill: the old code threw `config_not_observed` for anything that did not
  // read back as the requested value, which is exactly what a deferred switch looks like.
  it('treats a deferred switch as pending rather than an error', async () => {
    const { Message } = (await import('@arco-design/web-react')) as unknown as {
      Message: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
    };
    // The backend answers with the mode still in force, not the one just requested.
    const setConfigOption = vi.fn().mockResolvedValue([{ id: 'mode', current_value: 'default' }]);
    useAcpConfigOptionsMock.mockImplementation(() => ({
      setStatus: { state: 'idle' },
      isLoading: false,
      mode: runtimeMode(),
      model: null,
      thoughtLevel: null,
      reload: vi.fn(),
      setConfigOption,
      pendingValues: {},
    }));

    render(
      <AgentModeSelector
        backend='claude'
        conversation_id='conv-1'
        compact
        modeLabelFormatter={(mode) => (mode.value === 'default' ? '默认' : '全自动')}
        compactLabelPrefix='权限'
      />
    );

    fireEvent.click(screen.getByText('全自动'));

    await waitFor(() => expect(setConfigOption).toHaveBeenCalledWith('mode', 'bypassPermissions'));
    await waitFor(() => expect(Message.info).toHaveBeenCalled());
    expect(Message.error).not.toHaveBeenCalled();
    expect(Message.success).not.toHaveBeenCalled();
    expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'default');
  });

  it('keeps compact mode selector hidden while runtime mode is initializing', () => {
    useAcpConfigOptionsMock.mockImplementation(() => ({
      setStatus: { state: 'idle' },
      isLoading: true,
      mode: null,
      model: null,
      thoughtLevel: null,
      reload: vi.fn(),
      setConfigOption: vi.fn(),
    }));

    render(
      <AgentModeSelector
        backend='claude'
        conversation_id='conv-1'
        compact
        modeLabelFormatter={(mode) => (mode.value === 'default' ? '默认' : '全自动')}
        compactLabelPrefix='权限'
      />
    );

    expect(screen.queryByTestId('agent-mode-selector-claude')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runtime-selector-loading-indicator')).not.toBeInTheDocument();
  });

  it('renders setting progress at the compact trailing edge instead of using Arco button loading', async () => {
    useAcpConfigOptionsMock.mockImplementation(() => ({
      setStatus: { state: 'setting' },
      isLoading: false,
      mode: runtimeMode(),
      model: null,
      thoughtLevel: null,
      reload: vi.fn(),
      setConfigOption: vi.fn(),
    }));

    render(
      <AgentModeSelector
        backend='claude'
        conversation_id='conv-1'
        compact
        modeLabelFormatter={(mode) => (mode.value === 'default' ? '默认' : '全自动')}
        compactLabelPrefix='权限'
      />
    );

    const button = screen.getByTestId('agent-mode-selector-claude');
    const loading = screen.getByTestId('runtime-selector-loading-indicator');

    expect(button).not.toHaveAttribute('loading');
    expect(button).toHaveTextContent('权限 · 默认');
    expect(loading.parentElement?.lastElementChild).toBe(loading);
  });

  it('does not persist runtime mode changes to global agent preferences', async () => {
    const setConfigOption = vi.fn().mockResolvedValue(undefined);
    useAcpConfigOptionsMock.mockImplementation(() => ({
      setStatus: { state: 'idle' },
      isLoading: false,
      mode: runtimeMode(),
      model: null,
      thoughtLevel: null,
      reload: vi.fn(),
      setConfigOption,
    }));

    render(<AgentModeSelector backend='claude' conversation_id='conv-1' />);

    fireEvent.click(screen.getByText('Bypass Permissions'));

    await waitFor(() => {
      expect(setConfigOption).toHaveBeenCalledWith('mode', 'bypassPermissions');
    });
  });

  it('passes set-only runtime preparation to runtime config options', () => {
    const beforeRuntimeSet = vi.fn().mockResolvedValue(undefined);

    render(<AgentModeSelector backend='claude' conversation_id='conv-1' beforeRuntimeSet={beforeRuntimeSet} />);

    expect(useAcpConfigOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ prepareSetRuntime: beforeRuntimeSet })
    );
  });

  it('falls back to the raw mode value when the current value matches no option', async () => {
    // Regression: an out-of-catalog current value (e.g. backend mode-vocabulary
    // drift such as codex "agent-full-access" vs catalog "full-access") used to
    // render an empty label — the compact pill showed a bare "权限 · ".
    useAcpConfigOptionsMock.mockImplementation(() => ({
      setStatus: { state: 'idle' },
      isLoading: false,
      mode: {
        id: 'mode',
        category: 'mode',
        currentValue: 'agent-full-access',
        options: [
          { value: 'read-only', label: 'Read Only', description: null },
          { value: 'auto', label: 'Default', description: null },
          { value: 'full-access', label: 'Full Access', description: null },
        ],
      },
      model: null,
      thoughtLevel: null,
      reload: vi.fn(),
      setConfigOption: vi.fn(),
    }));

    render(<AgentModeSelector backend='codex' conversation_id='conv-1' compact compactLabelPrefix='权限' />);

    await waitFor(() =>
      expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'agent-full-access')
    );
    expect(screen.getByTestId('agent-mode-selector-codex')).toHaveTextContent('权限 · agent-full-access');
  });

  it('shows runtime mode descriptions in option tooltips', () => {
    render(<AgentModeSelector backend='claude' conversation_id='conv-1' />);

    expect(screen.queryByText('Run without permission prompts')).not.toBeInTheDocument();
    expect(screen.getByText('Bypass Permissions').closest('[data-tooltip-content]')).toHaveAttribute(
      'data-tooltip-content',
      'Run without permission prompts'
    );
  });

  it.each([
    ['build', 'Build', 'The default agent. Executes tools based on configured permissions.', 'build'],
    ['plan', 'Plan', 'Plan mode. Disallows all edit tools.', 'plan'],
    [
      'read-only',
      'Read Only',
      'Codex can read files in the current workspace. Approval is required to edit files or access the internet.',
      'codexReadOnly',
    ],
    [
      'auto',
      'Auto',
      'Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files. (Identical to Agent mode)',
      'codexAuto',
    ],
    [
      'full-access',
      'Full Access',
      'Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.',
      'codexFullAccess',
    ],
  ] as const)('translates the observed %s mode tooltip into the display language', (value, label, description, key) => {
    useAcpConfigOptionsMock.mockReturnValue({
      setStatus: { state: 'idle' },
      mode: { ...runtimeMode(), currentValue: value, options: [{ value, label, description }] },
    });

    render(<AgentModeSelector backend='codex' conversation_id='conv-1' />);

    expect(screen.getByText(label).closest('[data-tooltip-content]')).toHaveAttribute(
      'data-tooltip-content',
      zhCN.descriptions[key]
    );
  });

  it('translates persisted mode descriptions before a conversation is created', () => {
    useAcpConfigOptionsMock.mockReturnValue({ setStatus: { state: 'idle' }, mode: null });

    render(
      <AgentModeSelector
        backend='opencode'
        onModeSelect={vi.fn()}
        dynamicModes={[
          {
            value: 'build',
            label: 'Build',
            description: 'The default agent. Executes tools based on configured permissions.',
          },
        ]}
      />
    );

    expect(screen.getByText('Build').closest('[data-tooltip-content]')).toHaveAttribute(
      'data-tooltip-content',
      zhCN.descriptions.build
    );
  });

  it('updates existing mode tooltips when the display language changes', async () => {
    const description =
      'Codex can read files in the current workspace. Approval is required to edit files or access the internet.';
    useAcpConfigOptionsMock.mockReturnValue({
      setStatus: { state: 'idle' },
      mode: {
        ...runtimeMode(),
        currentValue: 'read-only',
        options: [{ value: 'read-only', label: 'Read Only', description }],
      },
    });

    render(<AgentModeSelector backend='codex' conversation_id='conv-1' />);

    expect(screen.getByText('Read Only').closest('[data-tooltip-content]')).toHaveAttribute(
      'data-tooltip-content',
      zhCN.descriptions.codexReadOnly
    );

    await act(async () => {
      await modeI18n.changeLanguage('en-US');
    });

    expect(screen.getByText('Read Only').closest('[data-tooltip-content]')).toHaveAttribute(
      'data-tooltip-content',
      description
    );
  });

  it('preserves custom descriptions even when their mode ID matches a built-in mode', () => {
    const description = 'Build with the organization-specific deployment workflow';
    useAcpConfigOptionsMock.mockReturnValue({
      setStatus: { state: 'idle' },
      mode: {
        ...runtimeMode(),
        currentValue: 'build',
        options: [{ value: 'build', label: 'Custom Build', description }],
      },
    });

    render(<AgentModeSelector backend='opencode' conversation_id='conv-1' />);

    expect(screen.getByText('Custom Build').closest('[data-tooltip-content]')).toHaveAttribute(
      'data-tooltip-content',
      description
    );
  });

  it('keeps modes without descriptions free of tooltips', () => {
    useAcpConfigOptionsMock.mockReturnValue({
      setStatus: { state: 'idle' },
      mode: {
        ...runtimeMode(),
        currentValue: 'build',
        options: [{ value: 'build', label: 'Build' }],
      },
    });

    render(<AgentModeSelector backend='opencode' conversation_id='conv-1' />);

    expect(screen.getByText('Build').closest('[data-tooltip-content]')).toBeNull();
  });
});
