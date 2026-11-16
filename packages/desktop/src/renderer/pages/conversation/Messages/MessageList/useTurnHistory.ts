/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TMessage } from '@/common/chat/chatLib';
import { loadConversationMessagePage, DEFAULT_MESSAGE_PAGE_LIMIT } from '@/renderer/utils/chat/messagePagination';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  mergeLoadedPageWithCurrent,
  normalizeDbMessage,
  useMessagePaginationState,
  useUpdateMessageList,
  useUpdateMessagePaginationState,
} from '../hooks';

type TurnHistoryRequest = {
  messageId: string;
  before: boolean;
  after: boolean;
  isBoundary: (message: TMessage) => boolean;
};

/** Fill a partial turn on disclosure without loading an entire conversation up front. */
export function useTurnHistory(conversationId: string | undefined, beforeMerge: () => void) {
  const pagination = useMessagePaginationState();
  const setPagination = useUpdateMessagePaginationState();
  const updateMessages = useUpdateMessageList();
  const currentRef = useRef({ conversationId, pagination, beforeMerge });
  currentRef.current = { conversationId, pagination, beforeMerge };
  const requestRef = useRef<object | null>(null);
  const [status, setStatus] = useState<{ messageId?: string; loading: boolean; error: boolean }>({
    loading: false,
    error: false,
  });

  useEffect(() => {
    requestRef.current = null;
    setStatus({ loading: false, error: false });
    return () => {
      requestRef.current = null;
    };
  }, [conversationId]);

  const load = useCallback(
    async (request: TurnHistoryRequest): Promise<void> => {
      if (!conversationId || requestRef.current || (!request.before && !request.after)) return;
      const token = {};
      requestRef.current = token;
      setStatus({ messageId: request.messageId, loading: true, error: false });
      if (request.before) setPagination((current) => ({ ...current, isLoadingBefore: true }));
      const isCurrent = () => requestRef.current === token && currentRef.current.conversationId === conversationId;

      try {
        for (const direction of ['before', 'after'] as const) {
          if (!request[direction]) continue;
          const initial = currentRef.current.pagination;
          let cursor = direction === 'before' ? initial.oldestCursor : initial.newestCursor;
          let hasMore = direction === 'before' ? initial.hasMoreBefore : initial.hasMoreAfter;
          const seenCursors = new Set<string>();
          while (hasMore && cursor && !seenCursors.has(cursor) && isCurrent()) {
            seenCursors.add(cursor);
            const page = await loadConversationMessagePage(conversationId, {
              limit: DEFAULT_MESSAGE_PAGE_LIMIT,
              [direction]: cursor,
              contentMode: 'compact',
            });
            if (!isCurrent()) return;
            const messages = page.items.map(normalizeDbMessage);
            currentRef.current.beforeMerge();
            updateMessages((current) => {
              if (currentRef.current.conversationId !== conversationId) return current;
              const combined = mergeLoadedPageWithCurrent(conversationId, messages, current);
              return combined.toSorted((left, right) => (left.created_at ?? 0) - (right.created_at ?? 0));
            });
            const nextCursor = direction === 'before' ? page.oldest_cursor : page.newest_cursor;
            const nextHasMore = direction === 'before' ? page.has_more_before : page.has_more_after;
            setPagination((current) => ({
              ...current,
              ...(direction === 'before'
                ? { oldestCursor: nextCursor ?? current.oldestCursor, hasMoreBefore: nextHasMore }
                : { newestCursor: nextCursor ?? current.newestCursor, hasMoreAfter: nextHasMore }),
            }));
            if (messages.some(request.isBoundary) || !messages.length || nextCursor === cursor) break;
            cursor = nextCursor ?? undefined;
            hasMore = nextHasMore;
          }
        }
        if (isCurrent()) setStatus({ messageId: request.messageId, loading: false, error: false });
      } catch {
        if (isCurrent()) setStatus({ messageId: request.messageId, loading: false, error: true });
      } finally {
        if (isCurrent()) {
          requestRef.current = null;
          if (request.before) setPagination((current) => ({ ...current, isLoadingBefore: false }));
        }
      }
    },
    [conversationId, setPagination, updateMessages]
  );

  return { load, status };
}
