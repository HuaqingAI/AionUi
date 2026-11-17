/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HTHSyncProgressEvent, HTHSyncResult } from '@/common/types/hth';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Message, Modal } from '@arco-design/web-react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ isDesktop: true, isMac: false }));
const hthMocks = vi.hoisted(() => ({
  authStatus: vi.fn().mockResolvedValue({ loggedIn: false, baseUrl: '' }),
  openDefaultBrowserSettings: vi.fn().mockResolvedValue(true),
  startLogin: vi.fn(),
  syncAgentConfigs: vi.fn(),
  progressListener: null as ((event: HTHSyncProgressEvent) => void) | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'login.brand') return '华青智能助手';
      if (key === 'login.hth.description')
        return '华青智能助手 requires your HTH account before assistants can be used.';
      return key;
    },
  }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    hth: {
      authStatus: { invoke: hthMocks.authStatus },
      syncAgentConfigs: { invoke: hthMocks.syncAgentConfigs },
      syncAgentConfigsProgress: {
        on: vi.fn((listener: (event: HTHSyncProgressEvent) => void) => {
          hthMocks.progressListener = listener;
          return () => {
            hthMocks.progressListener = null;
          };
        }),
      },
      startLogin: { invoke: hthMocks.startLogin },
      openDefaultBrowserSettings: { invoke: hthMocks.openDefaultBrowserSettings },
    },
  },
}));

vi.mock('@renderer/components/layout/WindowControls', () => ({
  default: () => <div data-testid='window-controls' />,
}));

vi.mock('@renderer/utils/platform', () => ({
  isElectronDesktop: () => platform.isDesktop,
  isMacOS: () => platform.isMac,
}));

import HTHLogin from '@renderer/pages/HTHLogin';
import HTHLoginSyncProgress from '@renderer/components/assistant/HTHLoginSyncProgress';

describe('HTHLogin', () => {
  beforeEach(() => {
    vi.spyOn(Message, 'info').mockImplementation(() => undefined);
    vi.spyOn(Message, 'warning').mockImplementation(() => undefined);
    vi.spyOn(Message, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    platform.isDesktop = true;
    platform.isMac = false;
    hthMocks.authStatus.mockReset().mockResolvedValue({ loggedIn: false, baseUrl: '' });
    hthMocks.openDefaultBrowserSettings.mockClear();
    hthMocks.startLogin.mockReset();
    hthMocks.syncAgentConfigs.mockClear();
    vi.restoreAllMocks();
    navigate.mockClear();
  });

  it('renders the titlebar with the 华青智能助手 wordmark and shared HTH logo', async () => {
    render(<HTHLogin />);

    const brand = await screen.findByTestId('hth-login-titlebar-brand');

    expect(within(brand).getByText('华青智能助手')).toBeInTheDocument();
    expect(within(brand).getByRole('img', { name: '华青智能助手' })).toBeInTheDocument();
    expect(
      screen.getByText('华青智能助手 requires your HTH account before assistants can be used.')
    ).toBeInTheDocument();
    expect(screen.queryByText('AionUi')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  it('renders custom window controls on Windows and Linux desktop runtimes', async () => {
    render(<HTHLogin />);

    expect(await screen.findByTestId('window-controls')).toBeInTheDocument();
  });

  it('uses the macOS titlebar layout without custom window controls', async () => {
    platform.isMac = true;
    const { container } = render(<HTHLogin />);

    await screen.findByTestId('hth-login-titlebar-brand');

    expect(container.querySelector('[class*="loginTitlebarMac"]')).toBeInTheDocument();
    expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument();
  });

  it('opens default apps settings when no default browser is configured', async () => {
    hthMocks.startLogin.mockResolvedValue({ outcome: 'default-browser-unavailable' });
    const modalConfirm = vi.spyOn(Modal, 'confirm').mockImplementation(() => undefined);
    render(<HTHLogin />);

    fireEvent.click(await screen.findByRole('button', { name: 'login.hth.loginWithDingTalk' }));

    await waitFor(() => {
      expect(modalConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'login.hth.defaultBrowserUnavailable',
          okText: 'login.hth.openDefaultBrowserSettings',
        })
      );
    });
    const modalOptions = modalConfirm.mock.calls[0]?.[0];
    await modalOptions?.onOk?.();
    expect(hthMocks.openDefaultBrowserSettings).toHaveBeenCalledOnce();
  });

  it('shows assistant sync progress after login and enters the main page only after sync finishes', async () => {
    hthMocks.authStatus
      .mockResolvedValueOnce({ loggedIn: false })
      .mockResolvedValue({ loggedIn: true, baseUrl: 'https://login.test', email: 'progress@test', lastLoginAt: 1 });
    hthMocks.startLogin.mockResolvedValue({ outcome: 'started' });
    let finishSync!: (result: HTHSyncResult) => void;
    hthMocks.syncAgentConfigs.mockReturnValue(
      new Promise<HTHSyncResult>((resolve) => {
        finishSync = resolve;
      })
    );
    render(
      <>
        <HTHLogin />
        <HTHLoginSyncProgress />
      </>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'login.hth.loginWithDingTalk' }));

    expect(await screen.findByTestId('assistant-sync-progress-modal')).toBeInTheDocument();
    await waitFor(() => expect(hthMocks.syncAgentConfigs).toHaveBeenCalledOnce());
    const { syncId } = hthMocks.syncAgentConfigs.mock.calls[0][0] as { syncId: string };
    act(() =>
      hthMocks.progressListener?.({
        syncId,
        stage: 'syncing_assistants',
        total: 3,
        completed: 1,
        synced: 1,
        failed: 0,
        currentAssistant: { id: 'sales', name: 'Sales Assistant' },
      })
    );
    expect(screen.getByTestId('assistant-sync-progress-current')).toHaveTextContent('Sales Assistant');
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => finishSync({ success: true, imported: 3, skipped: 0, failed: 0, packages: [] }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/guid', { replace: true }));
    expect(screen.queryByTestId('assistant-sync-progress-modal')).not.toBeInTheDocument();
  });

  it('dismisses login sync progress and still enters the main page after an ordinary sync error', async () => {
    hthMocks.authStatus
      .mockResolvedValueOnce({ loggedIn: false })
      .mockResolvedValue({ loggedIn: true, baseUrl: 'https://login.test', email: 'failure@test', lastLoginAt: 2 });
    hthMocks.startLogin.mockResolvedValue({ outcome: 'started' });
    hthMocks.syncAgentConfigs.mockRejectedValue(new Error('Network unavailable'));
    const warning = vi.spyOn(Message, 'warning');
    render(
      <>
        <HTHLogin />
        <HTHLoginSyncProgress />
      </>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'login.hth.loginWithDingTalk' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/guid', { replace: true }));
    expect(warning).toHaveBeenCalledWith('settings.HTH.syncFailed');
    expect(screen.queryByTestId('assistant-sync-progress-modal')).not.toBeInTheDocument();
  });

  it('returns to login when synchronization reports that authentication is no longer valid', async () => {
    hthMocks.authStatus
      .mockResolvedValueOnce({ loggedIn: false })
      .mockResolvedValue({ loggedIn: true, baseUrl: 'https://login.test', email: 'unauthorized@test', lastLoginAt: 3 });
    hthMocks.startLogin.mockResolvedValue({ outcome: 'started' });
    hthMocks.syncAgentConfigs.mockResolvedValue({ success: false, errorCode: 'hth-unauthorized' });
    render(<HTHLogin />);
    fireEvent.click(await screen.findByRole('button', { name: 'login.hth.loginWithDingTalk' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/hth-login', { replace: true }));
    expect(navigate).not.toHaveBeenCalledWith('/guid', { replace: true });
  });
});
