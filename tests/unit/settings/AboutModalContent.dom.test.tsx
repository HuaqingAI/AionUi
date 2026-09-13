/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  quitAndInstallMock: vi.fn(),
  autoUpdateCheckMock: vi.fn(),
  updateCheckMock: vi.fn(),
  messageInfoMock: vi.fn(),
  messageErrorMock: vi.fn(),
  messageSuccessMock: vi.fn(),
  modalConfirmMock: vi.fn(),
  uploadClientLogsMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, params?: Record<string, string | number>) =>
      key === 'login.brand'
        ? '华青智能助手'
        : key === 'settings.appDescription'
          ? '一个桌面。你的 AI 智能体，真正实现协同工作。'
          : key === 'update.preparingInstall'
            ? '准备安装...'
            : key === 'settings.updateReadyInstall'
              ? `${params?.version} 已就绪, 立即安装`
              : key === 'settings.clientLogUpload.success'
                ? `${key}:${params?.bytes}`
                : key,
  }),
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Message: {
      ...actual.Message,
      info: mocks.messageInfoMock,
      error: mocks.messageErrorMock,
      success: mocks.messageSuccessMock,
    },
    Modal: { ...actual.Modal, confirm: mocks.modalConfirmMock },
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    autoUpdate: {
      quitAndInstall: {
        invoke: mocks.quitAndInstallMock,
      },
      check: { invoke: mocks.autoUpdateCheckMock },
    },
    update: {
      check: { invoke: mocks.updateCheckMock },
    },
    hth: {
      uploadClientLogs: { invoke: mocks.uploadClientLogsMock },
    },
  },
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
  openExternalUrl: vi.fn(),
}));

vi.mock('@/renderer/components/settings/SettingsModal/settingsViewContext', () => ({
  useSettingsViewMode: () => 'modal',
}));

vi.mock('@/renderer/components/settings/SettingsModal/contents/FeedbackReportModal', () => ({
  default: () => null,
}));

import AboutModalContent from '@/renderer/components/settings/SettingsModal/contents/AboutModalContent';
import { setUpdateReadyState } from '@/renderer/components/settings/updateReadyState';

describe('AboutModalContent update ready state', () => {
  beforeEach(() => {
    vi.stubGlobal('__APP_VERSION__', '2.1.13');
    mocks.quitAndInstallMock.mockResolvedValue(undefined);
    mocks.autoUpdateCheckMock.mockResolvedValue({ success: true });
    mocks.updateCheckMock.mockResolvedValue({
      success: true,
      data: { currentVersion: '2.1.13', updateAvailable: false, latest: null },
    });
    mocks.uploadClientLogsMock.mockResolvedValue({
      outcome: 'uploaded',
      date: '2026-09-10',
      fileCount: 2,
      totalBytes: 268_560,
    });
  });

  afterEach(() => {
    setUpdateReadyState({ ready: false, version: '' });
    cleanup();
    localStorage.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('replaces check update with ready-to-install when an update package is ready', async () => {
    render(<AboutModalContent />);

    expect(screen.getByRole('button', { name: 'settings.checkForUpdates' })).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('aionui-update-ready-state-changed', {
          detail: {
            ready: true,
            version: '2.1.14',
          },
        })
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: '2.1.14 已就绪, 立即安装' }));

    expect(mocks.quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it('renders the 华青智能助手 about page without prerelease or resource links', () => {
    render(<AboutModalContent />);

    expect(screen.getByText('华青智能助手')).toBeInTheDocument();
    expect(screen.getByText('一个桌面。你的 AI 智能体，真正实现协同工作。')).toBeInTheDocument();
    expect(screen.queryByText('AionUi')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.includePrereleaseUpdates')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.helpDocumentation')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.updateLog')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.bugReport')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.contactMe')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.officialWebsite')).not.toBeInTheDocument();
  });

  it('shows preparing loading state for ready auto-update install from About', async () => {
    let rejectInstall!: (error: Error) => void;
    mocks.quitAndInstallMock.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInstall = reject;
        })
    );

    render(<AboutModalContent />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('aionui-update-ready-state-changed', {
          detail: {
            ready: true,
            version: '2.1.14',
          },
        })
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: '2.1.14 已就绪, 立即安装' }));

    expect(await screen.findByRole('button', { name: '准备安装...' })).toBeDisabled();
    expect(mocks.quitAndInstallMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectInstall(new Error('prepare failed'));
    });

    expect(await screen.findByRole('button', { name: '2.1.14 已就绪, 立即安装' })).not.toBeDisabled();
  });

  it('reveals the notification card only when an update is available, with no toast', async () => {
    localStorage.setItem('update.includePrerelease', 'true');
    mocks.autoUpdateCheckMock.mockResolvedValue({
      success: true,
      data: {
        updateInfo: {
          version: '2.1.14',
          releaseNotes: 'notes',
        },
      },
    });
    const availableListener = vi.fn();
    window.addEventListener('aionui-update-available', availableListener);

    render(<AboutModalContent />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.checkForUpdates' }));

    await waitFor(() => {
      expect(availableListener).toHaveBeenCalledTimes(1);
    });
    const detail = (availableListener.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.kind).toBe('available');
    expect(detail.autoUpdateInfo.version).toBe('2.1.14');
    expect(detail.updateInfo).toBeNull();
    expect(mocks.autoUpdateCheckMock).toHaveBeenCalledWith({ includePrerelease: false });
    expect(mocks.updateCheckMock).not.toHaveBeenCalled();
    expect(mocks.messageInfoMock).not.toHaveBeenCalled();

    window.removeEventListener('aionui-update-available', availableListener);
  });

  it('shows an up-to-date toast and no card when there is no update', async () => {
    const availableListener = vi.fn();
    window.addEventListener('aionui-update-available', availableListener);

    render(<AboutModalContent />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.checkForUpdates' }));

    await waitFor(() => {
      expect(mocks.messageInfoMock).toHaveBeenCalledWith('update.alreadyLatest');
    });
    expect(mocks.autoUpdateCheckMock).toHaveBeenCalledWith({ includePrerelease: false });
    expect(mocks.updateCheckMock).not.toHaveBeenCalled();
    expect(availableListener).not.toHaveBeenCalled();

    window.removeEventListener('aionui-update-available', availableListener);
  });

  it('confirms and delegates the selected client log date through the IPC bridge', async () => {
    render(<AboutModalContent />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.clientLogUpload.action' }));

    expect(mocks.modalConfirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'settings.clientLogUpload.confirmTitle',
        content: 'settings.clientLogUpload.confirmContent',
      })
    );
    const confirmation = mocks.modalConfirmMock.mock.calls[0][0] as { onOk: () => Promise<void> };
    await act(async () => {
      await confirmation.onOk();
    });

    expect(mocks.uploadClientLogsMock).toHaveBeenCalledWith({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(mocks.messageSuccessMock).toHaveBeenCalledWith('settings.clientLogUpload.success:262.3 KB');
  });
});
