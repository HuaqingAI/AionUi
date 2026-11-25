/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HTHNotificationSummary } from '@/common/types/hth';
import { HTHClientNotificationService } from '@/process/services/hth/client/clientNotificationService';

vi.mock('electron', () => ({ app: {} }));

const FIRST_ID = `ntf_${'1'.repeat(32)}`;
const SECOND_ID = `ntf_${'2'.repeat(32)}`;
const access = { baseUrl: 'https://notifications.example.com', token: 'desktop-secret' };
const first: HTHNotificationSummary = {
  id: FIRST_ID,
  title: 'Maintenance',
  summary: 'Planned service update',
  version: 1,
  published_at: 100,
  updated_at: 100,
};

function response(data: unknown): Response {
  return Response.json({ success: true, data });
}

function feed(items: HTHNotificationSummary[] = [first], viewerScope = 'user:42'): Response {
  return response({ viewer_scope: viewerScope, items, total: items.length });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(fetchMock = vi.fn(async (): Promise<Response> => feed())) {
  const getAccess = vi.fn(async () => access);
  const readStore = {
    load: vi.fn(async () => ({ ids: [] as string[], recovered: false })),
    merge: vi.fn(async (_scope: string, ids: string[]) => ({ ids, recovered: false })),
  };
  const onChanged = vi.fn();
  const service = new HTHClientNotificationService({
    getAccess,
    readStore,
    fetch: fetchMock as typeof fetch,
    onChanged,
  });
  return { service, getAccess, fetchMock, readStore, onChanged };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('desktop notification feed', () => {
  it('uses the desktop bearer with a complete index and never marks opening the list as read', async () => {
    const items = Array.from({ length: 101 }, (_, index) => ({
      ...first,
      id: `ntf_${index.toString(16).padStart(32, '0')}`,
    }));
    const { service, fetchMock, readStore } = fixture(vi.fn(async () => feed(items)));

    const result = await service.refresh();
    expect(result).toMatchObject({ success: true, data: { unread_count: 101, items: expect.any(Array) } });
    expect(fetchMock.mock.calls[0]).toMatchObject([
      new URL('/api/aionui/notifications', access.baseUrl),
      { headers: { Authorization: 'Bearer desktop-secret' }, redirect: 'error' },
    ]);
    expect(readStore.merge).not.toHaveBeenCalled();
  });

  it('fetches details before a separate explicit reading confirmation', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => feed());
    const { service, readStore } = fixture(fetchMock);
    const result = await service.refresh();
    if (!result.success) throw new Error(result.code);
    fetchMock.mockResolvedValueOnce(response({ ...first, content: '<b>Plain text</b>' }));

    expect(await service.detail({ id: FIRST_ID, context_id: result.data.context_id })).toMatchObject({
      success: true,
      data: { content: '<b>Plain text</b>' },
    });
    expect(readStore.merge).not.toHaveBeenCalled();
    expect(await service.markRead({ id: FIRST_ID, context_id: result.data.context_id })).toMatchObject({
      success: true,
      data: { unread_count: 0 },
    });
  });

  it('preserves local reads while a background index is in flight and excludes later arrivals from bulk reads', async () => {
    const pending = deferred<Response>();
    const { service, fetchMock } = fixture();
    const initial = await service.refresh();
    if (!initial.success) throw new Error(initial.code);
    fetchMock.mockReturnValueOnce(pending.promise);
    const refresh = service.refresh(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await service.markAllRead({ ids: [FIRST_ID], context_id: initial.data.context_id });
    pending.resolve(feed([first, { ...first, id: SECOND_ID }]));

    expect(await refresh).toMatchObject({ success: true, data: { unread_count: 1 } });
    expect(await service.snapshot()).toMatchObject({
      success: true,
      data: { items: [expect.objectContaining({ is_read: true }), expect.objectContaining({ is_read: false })] },
    });
  });

  it('rejects an old account response and uses a different persistent scope for the next account', async () => {
    const pending = deferred<Response>();
    const { service, fetchMock, getAccess, readStore } = fixture(vi.fn(() => pending.promise));
    const old = service.refresh();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    getAccess.mockResolvedValue({ ...access, token: 'next-account' });
    pending.resolve(feed());
    expect(await old).toMatchObject({ success: false, code: 'stale_context' });
    fetchMock.mockResolvedValue(feed([], 'user:43'));
    await service.refresh();

    expect(readStore.load).toHaveBeenCalledWith(JSON.stringify([access.baseUrl, 'user:43']));
    expect(readStore.load).not.toHaveBeenCalledWith(JSON.stringify([access.baseUrl, 'user:42']));
  });

  it('does not resurrect an unavailable message from an index started before its detail 404', async () => {
    const oldIndex = deferred<Response>();
    const { service, fetchMock } = fixture();
    const initial = await service.refresh();
    if (!initial.success) throw new Error(initial.code);
    fetchMock.mockReturnValueOnce(oldIndex.promise);
    const refresh = service.refresh(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(feed([]));

    expect(await service.detail({ id: FIRST_ID, context_id: initial.data.context_id })).toMatchObject({
      success: false,
      code: 'not_found',
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    oldIndex.resolve(feed());
    expect(await refresh).toMatchObject({ success: false, code: 'stale_context' });
    expect(await service.snapshot()).toMatchObject({ success: true, data: { items: [], unread_count: 0 } });
  });

  it('rejects a detail that arrives after a newer index removed the message', async () => {
    const oldDetail = deferred<Response>();
    const { service, fetchMock, readStore } = fixture();
    const initial = await service.refresh();
    if (!initial.success) throw new Error(initial.code);
    fetchMock.mockReturnValueOnce(oldDetail.promise);
    const detail = service.detail({ id: FIRST_ID, context_id: initial.data.context_id });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fetchMock.mockResolvedValueOnce(feed([]));
    await service.refresh();
    oldDetail.resolve(response({ ...first, content: 'Old content' }));

    expect(await detail).toMatchObject({ success: false, code: 'stale_context' });
    expect(readStore.merge).not.toHaveBeenCalled();
  });

  it('does not let a stale detail 404 remove a newer version already confirmed by an index', async () => {
    const oldDetail = deferred<Response>();
    const { service, fetchMock } = fixture();
    const initial = await service.refresh();
    if (!initial.success) throw new Error(initial.code);
    fetchMock.mockReturnValueOnce(oldDetail.promise);
    const detail = service.detail({ id: FIRST_ID, context_id: initial.data.context_id });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fetchMock.mockResolvedValueOnce(feed([{ ...first, version: 2 }]));
    await service.refresh();
    oldDetail.resolve(new Response(null, { status: 404 }));

    expect(await detail).toMatchObject({ success: false, code: 'stale_context' });
    expect(await service.snapshot()).toMatchObject({
      success: true,
      data: { items: [expect.objectContaining({ version: 2 })] },
    });
  });

  it('retains reading state across editing and close/reopen of the same ID', async () => {
    const { service, fetchMock } = fixture();
    const initial = await service.refresh();
    if (!initial.success) throw new Error(initial.code);
    await service.markRead({ id: FIRST_ID, context_id: initial.data.context_id });
    fetchMock.mockResolvedValueOnce(feed([]));
    await service.refresh();
    fetchMock.mockResolvedValueOnce(feed([{ ...first, version: 2, title: 'Edited' }]));

    expect(await service.refresh()).toMatchObject({ success: true, data: { unread_count: 0 } });
  });

  it('reports persistence failure without claiming a message was read', async () => {
    const { service, readStore } = fixture();
    const initial = await service.refresh();
    if (!initial.success) throw new Error(initial.code);
    readStore.merge.mockRejectedValueOnce(new Error('disk full'));

    expect(await service.markRead({ id: FIRST_ID, context_id: initial.data.context_id })).toMatchObject({
      success: false,
      code: 'storage_failed',
      snapshot: {
        items: [expect.objectContaining({ is_read: false })],
        storage_status: 'unavailable',
        unread_count: 1,
      },
    });
  });

  it.each([
    ['duplicate IDs', { viewer_scope: 'user:42', items: [first, first], total: 2 }],
    ['truncated total', { viewer_scope: 'user:42', items: [first], total: 100 }],
    ['invalid publication time', { viewer_scope: 'user:42', items: [{ ...first, published_at: 0 }], total: 1 }],
    ['invalid scope', { viewer_scope: '../account', items: [first], total: 1 }],
  ])('returns an explicit failure for %s without a partial unread count', async (_name, data) => {
    const { service } = fixture(vi.fn(async () => response(data)));

    expect(await service.refresh()).toMatchObject({
      success: false,
      code: 'invalid_response',
      snapshot: { unread_count: null, items: [] },
    });
  });

  it('clears active content on network failure instead of displaying an offline announcement cache', async () => {
    const { service, fetchMock } = fixture();
    await service.refresh();
    fetchMock.mockRejectedValueOnce(new Error('network offline'));

    expect(await service.refresh()).toMatchObject({
      success: false,
      code: 'unavailable',
      snapshot: { status: 'unavailable', items: [], unread_count: null },
    });
  });

  it('returns a safe snapshot result when reading the authentication file fails', async () => {
    const { service, getAccess, fetchMock } = fixture();
    await service.refresh();
    getAccess.mockRejectedValueOnce(new Error('authentication file unavailable'));

    expect(await service.snapshot()).toMatchObject({
      success: false,
      code: 'unavailable',
      snapshot: { items: [], unread_count: null },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('honors Retry-After before attempting another automatic request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }));
    const { service } = fixture(fetchMock);
    service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it('polls every ten minutes while visible and resumes immediately without mounting any UI', async () => {
    vi.useFakeTimers();
    const { service, fetchMock } = fixture();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    service.setVisible(false);
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    service.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    service.stop();
  });

  it('keeps failure retries at one, two and five minutes then restores ten-minute polling after success', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn(async () => feed())
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'));
    const { service } = fixture(fetchMock);
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    service.stop();
  });

  it.each([401, 403, 404])('pauses automatic requests after HTTP %s and permits an explicit retry', async (status) => {
    vi.useFakeTimers();
    const { service, fetchMock } = fixture(vi.fn(async () => new Response(null, { status })));
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(feed());

    expect(await service.refresh()).toMatchObject({ success: true, data: { status: 'ready' } });
    service.stop();
  });

  it('ends a timed out request with a serializable failure', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const { service } = fixture(fetchMock);
    const result = service.refresh();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await result).toMatchObject({ success: false, code: 'unavailable' });
  });
});
