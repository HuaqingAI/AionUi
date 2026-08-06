/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AutoUpdateStatus } from '@/common/update/updateTypes';

const mocks = vi.hoisted(() => ({
  autoStatusHandler: null as ((evt: AutoUpdateStatus) => void) | null,
  autoUpdateCheckMock: vi.fn(),
  autoUpdateRestoreDownloadedMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/renderer/components/base/AionModal', () => ({
  default: ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? <div>{children}</div> : null,
}));

vi.mock('@/renderer/components/Markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    autoUpdate: {
      check: { invoke: mocks.autoUpdateCheckMock },
      restoreDownloaded: { invoke: mocks.autoUpdateRestoreDownloadedMock },
      download: { invoke: vi.fn() },
      quitAndInstall: { invoke: vi.fn() },
      status: {
        on: vi.fn((handler: (evt: AutoUpdateStatus) => void) => {
          mocks.autoStatusHandler = handler;
          return vi.fn();
        }),
      },
    },
    update: {
      check: { invoke: vi.fn() },
      download: { invoke: vi.fn() },
      downloadProgress: { on: vi.fn(() => vi.fn()) },
      consumeInstallerLastFailure: { invoke: vi.fn().mockResolvedValue({ success: true, data: null }) },
      open: { on: vi.fn(() => vi.fn()) },
    },
    shell: {
      openExternal: { invoke: vi.fn() },
      openFile: { invoke: vi.fn() },
      showItemInFolder: { invoke: vi.fn() },
    },
  },
}));

import UpdateModal from '@/renderer/components/settings/UpdateModal';

describe('UpdateModal manual install fallback', () => {
  beforeEach(() => {
    vi.stubGlobal('__APP_VERSION__', '2.1.15');
    mocks.autoStatusHandler = null;
    mocks.autoUpdateCheckMock.mockResolvedValue({ success: true });
    mocks.autoUpdateRestoreDownloadedMock.mockResolvedValue({ success: true, data: { ready: false } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not expose release notes when auto-update status opens the notification', async () => {
    render(<UpdateModal />);

    await waitFor(() => {
      expect(mocks.autoStatusHandler).toBeTruthy();
    });

    await act(async () => {
      mocks.autoStatusHandler?.({
        status: 'available',
        version: '2.1.14',
        currentVersion: '2.1.13',
      });
    });

    expect(screen.queryByText('update.releaseLog')).not.toBeInTheDocument();
    expect(screen.queryByText('notes')).not.toBeInTheDocument();
    expect(screen.getByText(/2\.1\.13/)).toBeInTheDocument();
  });
});
