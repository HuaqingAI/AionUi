/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, setContextMenu } = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
  setContextMenu: vi.fn(),
}));

vi.mock('@/common/electronSafe', () => ({
  electronApp: { isPackaged: false, dock: { show: vi.fn(), hide: vi.fn() } },
  electronMenu: { buildFromTemplate: vi.fn((template: unknown[]) => template) },
  electronNativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  electronTray: class {
    setToolTip = vi.fn();
    setContextMenu = setContextMenu;
    destroy = vi.fn();
    on(event: string, handler: () => void) {
      handlers.set(event, handler);
    }
  },
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    database: { getUserConversations: { invoke: () => Promise.resolve({ items: [] }) } },
    conversation: { activeCount: { invoke: () => Promise.resolve({ count: 0 }) } },
  },
}));
vi.mock('@process/services/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/common/config/constants', () => ({ DESKTOP_PET_FEATURE_ENABLED: false }));

import { createOrUpdateTray, destroyTray, setTrayMainWindow } from '@/process/utils/tray';

const mainWindow = {
  isDestroyed: vi.fn(() => false),
  isMinimized: vi.fn(() => false),
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  hide: vi.fn(),
};

describe('tray window controls', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    handlers.clear();
    mainWindow.isDestroyed.mockReturnValue(false);
    mainWindow.isMinimized.mockReturnValue(false);
    setTrayMainWindow(mainWindow as unknown as BrowserWindow);
    createOrUpdateTray();
    await vi.waitFor(() => expect(setContextMenu).toHaveBeenCalled());
  });

  afterEach(() => {
    destroyTray();
  });

  it('shows and focuses the window on double click', () => {
    handlers.get('double-click')!();

    expect(mainWindow.show).toHaveBeenCalledOnce();
    expect(mainWindow.focus).toHaveBeenCalledOnce();
    expect(mainWindow.hide).not.toHaveBeenCalled();
  });

  it('restores a minimized window before showing it', () => {
    mainWindow.isMinimized.mockReturnValue(true);
    handlers.get('double-click')!();

    expect(mainWindow.restore).toHaveBeenCalledOnce();
    expect(mainWindow.show).toHaveBeenCalledOnce();
    expect(mainWindow.restore.mock.invocationCallOrder[0]).toBeLessThan(mainWindow.show.mock.invocationCallOrder[0]);
  });

  it('ignores double clicks when the main window has been destroyed', () => {
    mainWindow.isDestroyed.mockReturnValue(true);
    handlers.get('double-click')!();

    expect(mainWindow.show).not.toHaveBeenCalled();
    expect(mainWindow.focus).not.toHaveBeenCalled();
  });

  it('refreshes the context menu on right click without changing window visibility', async () => {
    setContextMenu.mockClear();
    handlers.get('right-click')!();

    await vi.waitFor(() => expect(setContextMenu).toHaveBeenCalledOnce());
    expect(mainWindow.show).not.toHaveBeenCalled();
    expect(mainWindow.hide).not.toHaveBeenCalled();
  });
});
