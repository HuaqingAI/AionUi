/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type {
  HTHNotificationDetailView,
  HTHNotificationErrorCode,
  HTHNotificationResult,
  HTHNotificationSnapshot,
} from '@/common/types/hth';
import { useCallback, useEffect, useRef, useState } from 'react';

const INITIAL_SNAPSHOT: HTHNotificationSnapshot = {
  context_id: '',
  state_version: -1,
  status: 'idle',
  items: [],
  unread_count: null,
  last_synced_at: null,
  storage_status: 'ready',
};

// Native bridge providers normally resolve failures, but an unavailable provider
// must also let the window leave its loading state.
async function requestNotification<T>(request: Promise<HTHNotificationResult<T>>): Promise<HTHNotificationResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<HTHNotificationResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ success: false, code: 'unavailable' }), 15_000);
      }),
    ]);
  } catch {
    return { success: false, code: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

export function useNotificationCenter() {
  const [snapshot, setSnapshot] = useState(INITIAL_SNAPSHOT);
  const snapshotRef = useRef(snapshot);
  const [visible, setVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HTHNotificationDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<HTHNotificationErrorCode | null>(null);
  const [marking, setMarking] = useState(false);
  const mounted = useRef(false);
  const selection = useRef(0);
  const snapshotRequest = useRef(0);
  const refreshRequest = useRef(0);
  const markRequest = useRef(0);

  const adoptSnapshot = useCallback((next: HTHNotificationSnapshot) => {
    if (!mounted.current || next.state_version < snapshotRef.current.state_version) return false;
    if (next.context_id !== snapshotRef.current.context_id) {
      selection.current++;
      refreshRequest.current++;
      markRequest.current++;
      setSelectedId(null);
      setDetail(null);
      setDetailLoading(false);
      setMarking(false);
      setRefreshing(false);
      setError(null);
    }
    snapshotRef.current = next;
    setSnapshot(next);
    return true;
  }, []);

  const applyResult = useCallback(
    (result: HTHNotificationResult<HTHNotificationSnapshot>, startedAtVersion: number) => {
      if (result.success === true) return adoptSnapshot(result.data);
      if (result.snapshot) return adoptSnapshot(result.snapshot);
      if (snapshotRef.current.state_version !== startedAtVersion) return false;
      return adoptSnapshot({
        ...snapshotRef.current,
        status: 'unavailable',
        items: [],
        unread_count: null,
        error_code: result.code,
      });
    },
    [adoptSnapshot]
  );

  useEffect(() => {
    mounted.current = true;
    const readSnapshot = async () => {
      const requestId = ++snapshotRequest.current;
      const version = snapshotRef.current.state_version;
      const result = await requestNotification(ipcBridge.hth.notifications.snapshot.invoke());
      if (!mounted.current || requestId !== snapshotRequest.current) return;
      if (applyResult(result, version) && result.success === false) setError(result.code);
    };
    const unsubscribe = ipcBridge.hth.notifications.changed.on(() => void readSnapshot());
    void readSnapshot();
    return () => {
      mounted.current = false;
      selection.current++;
      unsubscribe();
    };
  }, [applyResult]);

  useEffect(() => {
    if (!selectedId) return;
    const current = snapshot.items.find((item) => item.id === selectedId);
    if (snapshot.status !== 'ready' || !current || (detail && detail.context_id !== snapshot.context_id)) {
      selection.current++;
      setDetail(null);
      setDetailLoading(false);
      setError(snapshot.error_code ?? 'not_found');
    } else if (detail && current.version > detail.version) {
      selection.current++;
      setDetail(null);
      setError('stale_context');
    }
  }, [snapshot, selectedId, detail]);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequest.current;
    const version = snapshotRef.current.state_version;
    setRefreshing(true);
    setError(null);
    const result = await requestNotification(ipcBridge.hth.notifications.refresh.invoke());
    if (!mounted.current || requestId !== refreshRequest.current) return;
    const applied = applyResult(result, version);
    if (requestId === refreshRequest.current) {
      if (applied) setError(result.success === true ? null : result.code);
      setRefreshing(false);
    }
  }, [applyResult]);

  const open = useCallback(() => {
    selection.current++;
    setSelectedId(null);
    setDetail(null);
    setVisible(true);
    void refresh();
  }, [refresh]);

  const close = useCallback(() => {
    selection.current++;
    refreshRequest.current++;
    setRefreshing(false);
    setVisible(false);
    setSelectedId(null);
    setDetail(null);
    setError(null);
  }, []);

  const back = useCallback(() => {
    selection.current++;
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
    setError(null);
  }, []);

  const select = useCallback(
    async (id: string) => {
      const context = snapshotRef.current.context_id;
      const requestId = ++selection.current;
      setSelectedId(id);
      setDetail(null);
      setError(null);
      setDetailLoading(true);
      const result = await requestNotification(ipcBridge.hth.notifications.detail.invoke({ id, context_id: context }));
      if (!mounted.current || requestId !== selection.current || context !== snapshotRef.current.context_id) return;
      if (result.success === false) {
        if (result.snapshot) adoptSnapshot(result.snapshot);
        if (requestId === selection.current) setError(result.code);
      } else {
        const current = snapshotRef.current;
        const item = current.items.find((entry) => entry.id === id);
        if (
          current.status === 'ready' &&
          context === current.context_id &&
          item &&
          result.data.version >= item.version
        ) {
          setDetail(result.data);
        } else {
          setError('not_found');
        }
      }
      setDetailLoading(false);
    },
    [adoptSnapshot]
  );

  const markDisplayed = useCallback(
    async (displayed: HTHNotificationDetailView) => {
      const current = snapshotRef.current;
      const item = current.items.find((entry) => entry.id === displayed.id);
      if (current.status !== 'ready' || current.context_id !== displayed.context_id || !item || item.is_read) {
        return;
      }
      const requestId = selection.current;
      const operation = ++markRequest.current;
      setMarking(true);
      const result = await requestNotification(
        ipcBridge.hth.notifications.markRead.invoke({ id: displayed.id, context_id: displayed.context_id })
      );
      if (!mounted.current || snapshotRef.current.context_id !== displayed.context_id) return;
      const applied = applyResult(result, current.state_version);
      if (applied && requestId === selection.current) setError(result.success === true ? null : result.code);
      if (operation === markRequest.current) setMarking(false);
    },
    [applyResult]
  );

  const markAllRead = useCallback(async () => {
    const current = snapshotRef.current;
    if (current.status !== 'ready') return;
    const requestId = selection.current;
    const operation = ++markRequest.current;
    setMarking(true);
    setError(null);
    const result = await requestNotification(
      ipcBridge.hth.notifications.markAllRead.invoke({
        ids: current.items.map((item) => item.id),
        context_id: current.context_id,
      })
    );
    if (!mounted.current || current.context_id !== snapshotRef.current.context_id) return;
    const applied = applyResult(result, current.state_version);
    if (applied && requestId === selection.current) setError(result.success === true ? null : result.code);
    if (operation === markRequest.current) setMarking(false);
  }, [applyResult]);

  return {
    snapshot,
    visible,
    refreshing,
    selectedId,
    detail,
    detailLoading,
    error,
    marking,
    open,
    close,
    back,
    refresh,
    select,
    markDisplayed,
    markAllRead,
  };
}
