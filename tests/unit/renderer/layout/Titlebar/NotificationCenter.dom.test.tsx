/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HTHNotificationSnapshot } from '@/common/types/hth';

const native = vi.hoisted(() => ({
  desktop: true,
  snapshot: vi.fn(),
  refresh: vi.fn(),
  detail: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  changed: null as (() => void) | null,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    hth: {
      notifications: {
        snapshot: { invoke: native.snapshot },
        refresh: { invoke: native.refresh },
        detail: { invoke: native.detail },
        markRead: { invoke: native.markRead },
        markAllRead: { invoke: native.markAllRead },
        changed: {
          on: (handler: () => void) => {
            native.changed = handler;
            return () => {
              native.changed = null;
            };
          },
        },
      },
    },
  },
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => native.desktop }));
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({ useThemeContext: () => ({ fontScale: 1 }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { total?: number }) => (params?.total ? `${key}: ${params.total}` : key),
    i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
  }),
}));

import NotificationCenter from '@/renderer/components/layout/Titlebar/NotificationCenter';

const FIRST_ID = 'ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND_ID = 'ntf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
let snapshot: HTHNotificationSnapshot;

beforeEach(() => {
  vi.clearAllMocks();
  native.desktop = true;
  snapshot = {
    context_id: 'account-a',
    state_version: 1,
    status: 'ready',
    items: [FIRST_ID, SECOND_ID].map((id, index) => ({
      id,
      title: `Notice ${index + 1}`,
      summary: '',
      version: 1,
      published_at: 1795528800,
      updated_at: 1795528800,
      is_read: false,
    })),
    unread_count: 2,
    last_synced_at: 1,
    storage_status: 'ready',
  };
  native.snapshot.mockImplementation(async () => ({ success: true, data: snapshot }));
  native.refresh.mockImplementation(async () => ({ success: true, data: snapshot }));
  native.detail.mockImplementation(async ({ id }: { id: string }) => ({
    success: true,
    data: {
      ...snapshot.items.find((item) => item.id === id),
      content: '<script>do not execute</script>\nSecond line',
      context_id: snapshot.context_id,
    },
  }));
  native.markRead.mockImplementation(async () => ({
    success: true,
    data: {
      ...snapshot,
      state_version: 2,
      unread_count: 1,
      items: [{ ...snapshot.items[0], is_read: true }, snapshot.items[1]],
    },
  }));
  native.markAllRead.mockImplementation(async () => ({
    success: true,
    data: {
      ...snapshot,
      state_version: 2,
      unread_count: 0,
      items: snapshot.items.map((item) => ({ ...item, is_read: true })),
    },
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function openCenter() {
  render(<NotificationCenter iconSize={18} strokeWidth={2.5} />);
  fireEvent.click(await screen.findByRole('button', { name: 'common.notificationCenter.unreadLabel: 2' }));
  await screen.findByRole('button', { name: 'Notice 1, common.notificationCenter.unread' });
}

describe('Desktop message center', () => {
  it('opens the list without reading messages and marks only a rendered detail as read', async () => {
    await openCenter();
    expect(native.markRead).not.toHaveBeenCalled();
    expect(native.markAllRead).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Notice 1, common.notificationCenter.unread' }));
    await screen.findByText('<script>do not execute</script> Second line', { exact: false });
    await waitFor(() => expect(native.markRead).toHaveBeenCalledWith({ id: FIRST_ID, context_id: 'account-a' }));
    expect(await screen.findByRole('button', { name: 'common.notificationCenter.unreadLabel: 1' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(document.querySelector('article script')).toBeNull();
  });

  it('marks all IDs in the displayed complete index and hides the zero badge', async () => {
    await openCenter();
    fireEvent.click(screen.getByRole('button', { name: 'common.notificationCenter.markAllRead' }));
    await waitFor(() =>
      expect(native.markAllRead).toHaveBeenCalledWith({ ids: [FIRST_ID, SECOND_ID], context_id: 'account-a' })
    );
    expect(await screen.findByRole('button', { name: 'common.notificationCenter.title' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: 'common.notificationCenter.markAllRead' })).toBeDisabled();
  });

  it('keeps unread status when detail loading fails and offers a retry', async () => {
    native.detail.mockResolvedValue({ success: false, code: 'unavailable' });
    await openCenter();
    fireEvent.click(screen.getByRole('button', { name: 'Notice 1, common.notificationCenter.unread' }));
    await screen.findByText('common.notificationCenter.errors.unavailable');
    expect(native.markRead).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'common.retry' })).toBeEnabled();
  });

  it('preserves the readable detail and unread count when saving read history fails', async () => {
    native.markRead.mockImplementation(async () => ({ success: false, code: 'storage_failed', snapshot }));
    await openCenter();
    fireEvent.click(screen.getByRole('button', { name: 'Notice 1, common.notificationCenter.unread' }));
    await screen.findByText('common.notificationCenter.errors.storage_failed');
    expect(screen.getByRole('article')).toHaveTextContent('do not execute');
    expect(screen.getByRole('button', { name: 'common.notificationCenter.unreadLabel: 2' })).toBeInTheDocument();
  });

  it('shows an error instead of an empty list when refreshing fails', async () => {
    native.refresh.mockResolvedValue({ success: false, code: 'unavailable' });
    render(<NotificationCenter iconSize={18} />);
    fireEvent.click(await screen.findByRole('button', { name: 'common.notificationCenter.unreadLabel: 2' }));
    await screen.findByText('common.notificationCenter.errors.unavailable');
    expect(screen.queryByText('common.notificationCenter.empty')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.retry' })).toBeEnabled();
  });

  it('hides the previous unread badge when the native refresh rejects without a safe snapshot', async () => {
    native.refresh.mockRejectedValueOnce(new Error('native bridge disconnected'));
    render(<NotificationCenter iconSize={18} />);
    fireEvent.click(await screen.findByRole('button', { name: 'common.notificationCenter.unreadLabel: 2' }));

    await screen.findByText('common.notificationCenter.errors.unavailable');
    expect(screen.getByRole('button', { name: 'common.notificationCenter.title' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.queryByRole('button', { name: 'common.notificationCenter.unreadLabel: 2' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Notice 1, common.notificationCenter.unread' })
    ).not.toBeInTheDocument();
  });

  it('leaves loading and hides the old badge when a native provider never answers', async () => {
    native.refresh.mockImplementationOnce(() => new Promise(() => {}));
    render(<NotificationCenter iconSize={18} />);
    const trigger = await screen.findByRole('button', { name: 'common.notificationCenter.unreadLabel: 2' });
    vi.useFakeTimers();
    fireEvent.click(trigger);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByText('common.notificationCenter.errors.unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.notificationCenter.title' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: 'common.retry' })).toBeEnabled();
  });

  it('keeps a newer pushed index when an earlier refresh later fails without a snapshot', async () => {
    let resolveRefresh!: (result: unknown) => void;
    native.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );
    render(<NotificationCenter iconSize={18} />);
    fireEvent.click(await screen.findByRole('button', { name: 'common.notificationCenter.unreadLabel: 2' }));
    snapshot = {
      ...snapshot,
      state_version: 2,
      unread_count: 1,
      items: [{ ...snapshot.items[0], title: 'Current notice' }],
    };
    await act(async () => {
      native.changed?.();
    });
    await act(async () => {
      resolveRefresh({ success: false, code: 'unavailable' });
    });

    expect(
      await screen.findByRole('button', { name: 'Current notice, common.notificationCenter.unread' })
    ).toBeInTheDocument();
    expect(screen.queryByText('common.notificationCenter.errors.unavailable')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.notificationCenter.unreadLabel: 1' })).toBeInTheDocument();
  });

  it('ignores a previous account bulk-read failure after the active account changes', async () => {
    let resolveMarkAll!: (result: unknown) => void;
    native.markAllRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMarkAll = resolve;
        })
    );
    await openCenter();
    fireEvent.click(screen.getByRole('button', { name: 'common.notificationCenter.markAllRead' }));
    snapshot = {
      ...snapshot,
      context_id: 'account-b',
      state_version: 3,
      unread_count: 1,
      items: [{ ...snapshot.items[1], title: 'Account B notice' }],
    };
    await act(async () => {
      native.changed?.();
    });
    await screen.findByRole('button', { name: 'Account B notice, common.notificationCenter.unread' });
    await act(async () => {
      resolveMarkAll({ success: false, code: 'storage_failed' });
    });

    expect(
      screen.getByRole('button', { name: 'Account B notice, common.notificationCenter.unread' })
    ).toBeInTheDocument();
    expect(screen.queryByText('common.notificationCenter.errors.storage_failed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.notificationCenter.markAllRead' })).toBeEnabled();
  });

  it('does not present or read a late detail after a newer index removes the message', async () => {
    let resolveDetail!: (result: unknown) => void;
    native.detail.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        })
    );
    await openCenter();
    fireEvent.click(screen.getByRole('button', { name: 'Notice 1, common.notificationCenter.unread' }));
    const oldItem = snapshot.items[0];
    snapshot = { ...snapshot, state_version: 2, items: [], unread_count: 0 };
    await act(async () => {
      native.changed?.();
    });
    await act(async () => {
      resolveDetail({ success: true, data: { ...oldItem, content: 'Closed content', context_id: 'account-a' } });
    });
    expect(screen.queryByText('Closed content')).not.toBeInTheDocument();
    expect(native.markRead).not.toHaveBeenCalled();
  });

  it('returns to the list without clearing the remaining unread messages', async () => {
    await openCenter();
    fireEvent.click(screen.getByRole('button', { name: 'Notice 1, common.notificationCenter.unread' }));
    await screen.findByRole('article');
    await waitFor(() => expect(native.markRead).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'common.goBack' }));
    expect(await screen.findByRole('button', { name: 'Notice 1, common.notificationCenter.read' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Notice 2, common.notificationCenter.unread' })).toBeInTheDocument();
  });

  it('uses the actual unread count for accessibility when the visual badge is capped', async () => {
    snapshot = { ...snapshot, unread_count: 120 };
    render(<NotificationCenter iconSize={18} />);
    expect(await screen.findByRole('button', { name: 'common.notificationCenter.unreadLabel: 120' })).toHaveAttribute(
      'aria-haspopup',
      'dialog'
    );
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('returns focus to the bell after closing without marking the list as read', async () => {
    await openCenter();
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    const bell = screen.getByRole('button', { name: 'common.notificationCenter.unreadLabel: 2' });
    await waitFor(() => expect(bell).toHaveFocus());
    expect(bell).toHaveAttribute('aria-expanded', 'false');
    expect(native.markRead).not.toHaveBeenCalled();
  });

  it('does not invoke native channels outside Electron', () => {
    native.desktop = false;
    const { container } = render(<NotificationCenter iconSize={18} />);
    expect(container).toBeEmptyDOMElement();
    expect(native.snapshot).not.toHaveBeenCalled();
  });
});
