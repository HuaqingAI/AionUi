/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { type PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { IMessageAcpToolCall, IMessageText, IMessageThinking, TMessage } from '@/common/chat/chatLib';
import type { MessageCursorPage } from '@/common/adapter/ipcBridge';
import { useTurnHistory } from '@/renderer/pages/conversation/Messages/MessageList/useTurnHistory';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  MessagePaginationProvider,
  mergeLoadedPageWithCurrent,
  prependHistoryMessages,
  useAddOrUpdateMessage,
  useMessageLstCache,
  useMessageList,
  useReplaceWithAnchorWindow,
  useMessagePaginationState,
} from '@/renderer/pages/conversation/Messages/hooks';

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      userCreated: {
        on: vi.fn().mockReturnValue(() => {}),
      },
      statusChanged: {
        on: vi.fn().mockReturnValue(() => {}),
      },
      turnCompleted: {
        on: vi.fn().mockReturnValue(() => {}),
      },
    },
    database: {
      getConversationMessages: {
        invoke: vi.fn(),
      },
    },
  },
}));

const CONVERSATION_ID = 'conversation-1';

function createTextMessage(msgId: string, content: string): IMessageText {
  return {
    id: `text-${msgId}-${content}`,
    type: 'text',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      content,
    },
  };
}

function createThinkingMessage(msgId: string, content: string): IMessageThinking {
  return {
    id: `thinking-${msgId}-${content}`,
    type: 'thinking',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      content,
      status: 'thinking',
    },
  };
}

function createThinkingDoneMessage(msgId: string, duration: number): IMessageThinking {
  return {
    id: `thinking-done-${msgId}`,
    type: 'thinking',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      content: '',
      duration,
      status: 'done',
    },
  };
}

function createToolCallMessage(toolCallId: string): IMessageAcpToolCall {
  return {
    id: toolCallId,
    type: 'acp_tool_call',
    msg_id: toolCallId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      session_id: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        tool_call_id: toolCallId,
        status: 'completed',
        title: 'Read file',
        kind: 'read',
      },
    },
  };
}

function TestWrapper({ children }: PropsWithChildren): JSX.Element {
  return <MessageListProvider value={[]}>{children}</MessageListProvider>;
}

function CacheWrapper({ children }: PropsWithChildren): JSX.Element {
  return (
    <MessageListLoadingProvider value={false}>
      <MessagePaginationProvider
        value={{ hasMoreBefore: false, hasMoreAfter: false, isLoadingBefore: false, isLoadingAnchor: false }}
      >
        <MessageListProvider value={[]}>{children}</MessageListProvider>
      </MessagePaginationProvider>
    </MessageListLoadingProvider>
  );
}

function useMessageHarness() {
  return {
    addOrUpdateMessage: useAddOrUpdateMessage(),
    messages: useMessageList(),
  };
}

function useAnchorMessageHarness() {
  return {
    addOrUpdateMessage: useAddOrUpdateMessage(),
    replaceWithAnchorWindow: useReplaceWithAnchorWindow(),
    messages: useMessageList(),
  };
}

function historyMessage(id: string, createdAt: number, position: 'left' | 'right' = 'left'): IMessageText {
  return {
    id,
    msg_id: 'shared-turn-message',
    turn_id: 'turn-1',
    conversation_id: CONVERSATION_ID,
    type: 'text',
    position,
    created_at: createdAt,
    content: { content: id },
  };
}

function historyPage(items: TMessage[], oldest: string, newest: string = oldest): MessageCursorPage<TMessage> {
  return {
    items,
    oldest_cursor: oldest,
    newest_cursor: newest,
    has_more_before: true,
    has_more_after: true,
  };
}

function TurnHistoryWrapper({ children }: PropsWithChildren): JSX.Element {
  return (
    <MessagePaginationProvider
      value={{
        oldestCursor: 'cursor-50',
        newestCursor: 'cursor-50',
        hasMoreBefore: true,
        hasMoreAfter: true,
        isLoadingBefore: false,
        isLoadingAnchor: false,
      }}
    >
      <MessageListProvider value={[historyMessage('middle-50', 50)]}>{children}</MessageListProvider>
    </MessagePaginationProvider>
  );
}

function useTurnHistoryHarness(conversationId: string, beforeMerge: () => void) {
  return {
    ...useTurnHistory(conversationId, beforeMerge),
    messages: useMessageList(),
    pagination: useMessagePaginationState(),
  };
}

describe('turn process history loading', () => {
  const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
  const request = {
    messageId: 'middle-50',
    before: true,
    after: false,
    isBoundary: (message: TMessage) => !message.hidden && message.position === 'right',
  };

  beforeEach(() => {
    invoke.mockReset();
  });

  it('loads older pages through the starting user message while retaining separate text segments with one msg_id', async () => {
    invoke
      .mockResolvedValueOnce(historyPage([historyMessage('progress-40', 40)], 'cursor-40'))
      .mockResolvedValueOnce(
        historyPage([historyMessage('user-20', 20, 'right'), historyMessage('progress-30', 30)], 'cursor-20')
      );
    const beforeMerge = vi.fn();
    const { result } = renderHook(() => useTurnHistoryHarness(CONVERSATION_ID, beforeMerge), {
      wrapper: TurnHistoryWrapper,
    });

    await act(async () => result.current.load(request));

    expect(result.current.messages.map((message) => message.id)).toEqual([
      'user-20',
      'progress-30',
      'progress-40',
      'middle-50',
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current.pagination).toMatchObject({ oldestCursor: 'cursor-20', isLoadingBefore: false });
  });

  it('appends the end of a searched turn in chronological order and stops at the next user', async () => {
    invoke.mockResolvedValueOnce(
      historyPage(
        [historyMessage('answer-60', 60), historyMessage('next-user-70', 70, 'right')],
        'cursor-60',
        'cursor-70'
      )
    );
    const { result } = renderHook(() => useTurnHistoryHarness(CONVERSATION_ID, vi.fn()), {
      wrapper: TurnHistoryWrapper,
    });

    await act(async () => result.current.load({ ...request, before: false, after: true }));

    expect(result.current.messages.map((message) => message.id)).toEqual(['middle-50', 'answer-60', 'next-user-70']);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.current.pagination.newestCursor).toBe('cursor-70');
  });

  it('reconciles an overlapping live segment with its persisted row while filling a turn forward', async () => {
    const persisted = {
      ...historyMessage('persisted-middle-50', 50),
      content: { content: 'middle-50' },
    };
    const nextUser = { ...historyMessage('next-user-70', 70, 'right'), msg_id: 'next-turn' };
    invoke.mockResolvedValueOnce(historyPage([persisted, nextUser], 'cursor-50', 'cursor-70'));
    const { result } = renderHook(() => useTurnHistoryHarness(CONVERSATION_ID, vi.fn()), {
      wrapper: TurnHistoryWrapper,
    });

    await act(async () => result.current.load({ ...request, before: false, after: true }));

    expect(result.current.messages.map((message) => message.id)).toEqual(['persisted-middle-50', 'next-user-70']);
    expect(result.current.messages[0].turn_id).toBe('turn-1');
  });

  it('retries a failed page from the last successfully loaded cursor without losing earlier segments', async () => {
    invoke
      .mockResolvedValueOnce(historyPage([historyMessage('progress-40', 40)], 'cursor-40'))
      .mockRejectedValueOnce(new Error('connection lost'));
    const { result } = renderHook(() => useTurnHistoryHarness(CONVERSATION_ID, vi.fn()), {
      wrapper: TurnHistoryWrapper,
    });

    await act(async () => result.current.load(request));
    expect(result.current.status).toMatchObject({ loading: false, error: true });
    invoke.mockResolvedValueOnce(historyPage([historyMessage('user-30', 30, 'right')], 'cursor-30'));
    await act(async () => result.current.load(request));

    expect(invoke).toHaveBeenLastCalledWith(expect.objectContaining({ before: 'cursor-40' }));
    expect({ ids: result.current.messages.map((message) => message.id), status: result.current.status }).toEqual({
      ids: ['user-30', 'progress-40', 'middle-50'],
      status: { messageId: 'middle-50', loading: false, error: false },
    });
  });

  it('discards an in-flight page when the user switches conversations', async () => {
    let resolvePage!: (page: MessageCursorPage<TMessage>) => void;
    invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve;
      })
    );
    const beforeMerge = vi.fn();
    const { result, rerender } = renderHook(({ id }) => useTurnHistoryHarness(id, beforeMerge), {
      initialProps: { id: CONVERSATION_ID },
      wrapper: TurnHistoryWrapper,
    });
    let loading!: Promise<void>;
    act(() => {
      loading = result.current.load(request);
    });
    rerender({ id: 'other-conversation' });
    await act(async () => {
      resolvePage(historyPage([historyMessage('old-conversation-user', 30, 'right')], 'cursor-30'));
      await loading;
    });

    expect(result.current.messages.map((message) => message.id)).toEqual(['middle-50']);
    expect(beforeMerge).not.toHaveBeenCalled();
    expect(result.current.status).toEqual({ loading: false, error: false });
  });

  it('stops if the server repeats a pagination cursor cycle', async () => {
    invoke
      .mockResolvedValueOnce(historyPage([historyMessage('progress-40', 40)], 'cursor-40'))
      .mockResolvedValueOnce(historyPage([historyMessage('progress-30', 30)], 'cursor-50'));
    const { result } = renderHook(() => useTurnHistoryHarness(CONVERSATION_ID, vi.fn()), {
      wrapper: TurnHistoryWrapper,
    });

    await act(async () => result.current.load(request));

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current.status.loading).toBe(false);
    expect(result.current.messages.map((message) => message.id)).toEqual(['progress-30', 'progress-40', 'middle-50']);
  });
});

async function flushMessageQueue(): Promise<void> {
  await act(async () => {
    vi.runAllTimers();
  });
}

describe('message merging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps text segments split when tool calls interrupt the same msg_id stream', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createTextMessage('msg-1', 'hello'));
      result.current.addOrUpdateMessage(createTextMessage('msg-1', ' world'));
    });
    await flushMessageQueue();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe('text');
    expect((result.current.messages[0] as IMessageText).content.content).toBe('hello world');

    act(() => {
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createTextMessage('msg-1', 'again'));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['text', 'acp_tool_call', 'text']);
    expect((result.current.messages[0] as IMessageText).content.content).toBe('hello world');
    expect((result.current.messages[2] as IMessageText).content.content).toBe('again');
  });

  it('keeps thinking segments split when tool calls interrupt the same msg_id stream', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'alpha'));
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'beta'));
    });
    await flushMessageQueue();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe('thinking');
    expect((result.current.messages[0] as IMessageThinking).content.content).toBe('alphabeta');

    act(() => {
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'gamma'));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['thinking', 'acp_tool_call', 'thinking']);
    expect((result.current.messages[0] as IMessageThinking).content.content).toBe('alphabeta');
    expect((result.current.messages[2] as IMessageThinking).content.content).toBe('gamma');
  });

  it('merges thinking done updates into the existing thinking message instead of appending a completion message', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'alpha'));
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createThinkingDoneMessage('msg-1', 4200));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['thinking', 'acp_tool_call']);
    expect((result.current.messages[0] as IMessageThinking).content.status).toBe('done');
    expect((result.current.messages[0] as IMessageThinking).content.duration).toBe(4200);
  });

  it('ignores non-renderable transformed stream messages', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(undefined);
    });
    await flushMessageQueue();

    expect(result.current.messages).toEqual([]);
  });

  it('keeps live-only and richer streaming messages when replacing with an anchor window', async () => {
    const { result } = renderHook(() => useAnchorMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createTextMessage('agent-1', 'partial streaming response'));
      result.current.addOrUpdateMessage(createTextMessage('agent-2', 'live tail'));
    });
    await flushMessageQueue();

    act(() => {
      result.current.replaceWithAnchorWindow(CONVERSATION_ID, [
        createTextMessage('user-anchor', 'anchor'),
        createTextMessage('agent-1', 'partial'),
      ]);
    });

    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['user-anchor', 'agent-1', 'agent-2']);
    expect((result.current.messages[1] as IMessageText).content.content).toBe('partial streaming response');
    expect((result.current.messages[2] as IMessageText).content.content).toBe('live tail');
  });

  it.each(['text', 'thinking'] as const)('retains older %s segments that share the latest segment msg_id', (type) => {
    const previous =
      type === 'text' ? createTextMessage('same-turn', 'previous') : createThinkingMessage('same-turn', 'previous');
    const current =
      type === 'text' ? createTextMessage('same-turn', 'current') : createThinkingMessage('same-turn', 'current');

    const messages = prependHistoryMessages([current], [previous, current]);

    expect(messages.map((message) => message.id)).toEqual([previous.id, current.id]);
  });

  it.each(['text', 'thinking'] as const)(
    'keeps distinct %s segments when a loaded page and the live list each contain one shared msg_id',
    (type) => {
      const persisted =
        type === 'text' ? createTextMessage('same-turn', 'progress') : createThinkingMessage('same-turn', 'progress');
      const live =
        type === 'text'
          ? createTextMessage('same-turn', 'final answer')
          : createThinkingMessage('same-turn', 'final answer');

      const messages = mergeLoadedPageWithCurrent(CONVERSATION_ID, [persisted], [live]);

      expect(messages.map((message) => message.id)).toEqual([persisted.id, live.id]);
    }
  );

  it.each(['same', 'prefix'] as const)(
    'keeps the persisted row id and live turn metadata when reconciling %s text content across ids',
    (contentKind) => {
      const persisted = {
        ...createTextMessage('same-turn', contentKind === 'same' ? 'complete answer' : 'complete'),
        id: 'persisted-answer',
      };
      const live = { ...createTextMessage('same-turn', 'complete answer'), id: 'live-answer', turn_id: 'live-turn' };

      const messages = mergeLoadedPageWithCurrent(CONVERSATION_ID, [persisted], [live]);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: 'persisted-answer',
        turn_id: 'live-turn',
        content: { content: 'complete answer' },
      });
    }
  );

  it('keeps user and assistant text separate even when their msg_id and content match', () => {
    const persisted = { ...createTextMessage('same-turn', 'same content'), id: 'user-row', position: 'right' as const };
    const live = createTextMessage('same-turn', 'same content');

    const messages = mergeLoadedPageWithCurrent(CONVERSATION_ID, [persisted], [live]);

    expect(messages.map((message) => message.id)).toEqual([persisted.id, live.id]);
  });

  it('keeps persisted text segments intact when one live segment has an ambiguous shared msg_id', async () => {
    const { result } = renderHook(() => useAnchorMessageHarness(), { wrapper: TestWrapper });
    act(() => {
      result.current.addOrUpdateMessage(createTextMessage('same-turn', 'live answer'));
    });
    await flushMessageQueue();

    act(() => {
      result.current.replaceWithAnchorWindow(CONVERSATION_ID, [
        createTextMessage('same-turn', 'persisted progress'),
        createToolCallMessage('tool-1'),
        createTextMessage('same-turn', 'persisted answer'),
      ]);
    });

    const text = result.current.messages.filter((message) => message.type === 'text');
    expect(text.map((message) => message.content.content)).toEqual([
      'persisted progress',
      'persisted answer',
      'live answer',
    ]);
  });

  it('keeps unmatched live segments when an anchor window matches another segment by row id', async () => {
    const { result } = renderHook(() => useAnchorMessageHarness(), { wrapper: TestWrapper });
    const progress = createTextMessage('same-turn', 'progress');
    const answer = createTextMessage('same-turn', 'answer');
    act(() => {
      result.current.addOrUpdateMessage(progress);
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(answer);
    });
    await flushMessageQueue();

    act(() => {
      result.current.replaceWithAnchorWindow(CONVERSATION_ID, [answer]);
    });

    expect(result.current.messages).toHaveLength(3);
    expect(
      result.current.messages
        .filter((message) => message.type === 'text')
        .map((message) => message.content.content)
        .toSorted()
    ).toEqual(['answer', 'progress']);
  });

  it('requests compact tool content when hydrating historical messages', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    renderHook(() => useMessageLstCache(CONVERSATION_ID), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith({
      conversation_id: CONVERSATION_ID,
      limit: 50,
      content_mode: 'compact',
    });
  });

  it('flips a pending user message to finish when message.statusChanged arrives for it', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    let emitUserCreated: ((payload: any) => void) | undefined;
    let emitStatusChanged: ((payload: any) => void) | undefined;
    vi.mocked(ipcBridge.conversation.userCreated.on).mockImplementation((cb: any) => {
      emitUserCreated = cb;
      return () => {};
    });
    vi.mocked(ipcBridge.conversation.statusChanged.on).mockImplementation((cb: any) => {
      emitStatusChanged = cb;
      return () => {};
    });

    function useCacheAndListHarness() {
      useMessageLstCache(CONVERSATION_ID);
      return { messages: useMessageList() };
    }

    const { result } = renderHook(() => useCacheAndListHarness(), { wrapper: CacheWrapper });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitUserCreated?.({
        conversation_id: CONVERSATION_ID,
        msg_id: 'msg-midturn-1',
        client_msg_id: 'client-1',
        content: 'sent mid-turn',
        position: 'right',
        status: 'pending',
        hidden: false,
        created_at: Date.now(),
      });
    });

    expect(
      (result.current.messages.find((m) => m.msg_id === 'msg-midturn-1') as IMessageText | undefined)?.status
    ).toBe('pending');

    act(() => {
      emitStatusChanged?.({
        user_id: 'user-1',
        conversation_id: CONVERSATION_ID,
        msg_id: 'msg-midturn-1',
        status: 'finish',
      });
    });

    expect(
      (result.current.messages.find((m) => m.msg_id === 'msg-midturn-1') as IMessageText | undefined)?.status
    ).toBe('finish');
  });

  it('ignores message.statusChanged for a different conversation', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    let emitUserCreated: ((payload: any) => void) | undefined;
    let emitStatusChanged: ((payload: any) => void) | undefined;
    vi.mocked(ipcBridge.conversation.userCreated.on).mockImplementation((cb: any) => {
      emitUserCreated = cb;
      return () => {};
    });
    vi.mocked(ipcBridge.conversation.statusChanged.on).mockImplementation((cb: any) => {
      emitStatusChanged = cb;
      return () => {};
    });

    function useCacheAndListHarness() {
      useMessageLstCache(CONVERSATION_ID);
      return { messages: useMessageList() };
    }

    const { result } = renderHook(() => useCacheAndListHarness(), { wrapper: CacheWrapper });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitUserCreated?.({
        conversation_id: CONVERSATION_ID,
        msg_id: 'msg-midturn-2',
        content: 'sent mid-turn',
        position: 'right',
        status: 'pending',
        hidden: false,
        created_at: Date.now(),
      });
    });

    act(() => {
      emitStatusChanged?.({
        user_id: 'user-1',
        conversation_id: 'other-conversation',
        msg_id: 'msg-midturn-2',
        status: 'finish',
      });
    });

    expect(
      (result.current.messages.find((m) => m.msg_id === 'msg-midturn-2') as IMessageText | undefined)?.status
    ).toBe('pending');
  });

  it('reconciles a pending badge with the DB row when a turn completes for this conversation', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockResolvedValueOnce({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    let emitUserCreated: ((payload: any) => void) | undefined;
    let emitTurnCompleted: ((payload: any) => void) | undefined;
    vi.mocked(ipcBridge.conversation.userCreated.on).mockImplementation((cb: any) => {
      emitUserCreated = cb;
      return () => {};
    });
    vi.mocked(ipcBridge.conversation.turnCompleted.on).mockImplementation((cb: any) => {
      emitTurnCompleted = cb;
      return () => {};
    });

    function useCacheAndListHarness() {
      useMessageLstCache(CONVERSATION_ID);
      return { messages: useMessageList() };
    }

    const { result } = renderHook(() => useCacheAndListHarness(), { wrapper: CacheWrapper });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitUserCreated?.({
        conversation_id: CONVERSATION_ID,
        msg_id: 'msg-midturn-3',
        content: 'sent mid-turn',
        position: 'right',
        status: 'pending',
        hidden: false,
        created_at: Date.now(),
      });
    });

    expect(
      (result.current.messages.find((m) => m.msg_id === 'msg-midturn-3') as IMessageText | undefined)?.status
    ).toBe('pending');

    // The reconcile reload returns the DB's authoritative 'finish' row — the
    // missed live statusChanged event never arrived, so this is the only
    // path that heals the badge.
    invoke.mockResolvedValueOnce({
      items: [
        {
          id: 'msg-midturn-3',
          msg_id: 'msg-midturn-3',
          conversation_id: CONVERSATION_ID,
          type: 'text',
          position: 'right',
          status: 'finish',
          hidden: false,
          created_at: Date.now(),
          content: { content: 'sent mid-turn' },
        },
      ],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    invoke.mockClear();

    act(() => {
      emitTurnCompleted?.({ session_id: CONVERSATION_ID, turn_id: 'turn-1' });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalled();
    expect(
      (result.current.messages.find((m) => m.msg_id === 'msg-midturn-3') as IMessageText | undefined)?.status
    ).toBe('finish');
  });

  it('does not reload on turnCompleted when there is no pending right-position message', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    let emitTurnCompleted: ((payload: any) => void) | undefined;
    vi.mocked(ipcBridge.conversation.turnCompleted.on).mockImplementation((cb: any) => {
      emitTurnCompleted = cb;
      return () => {};
    });

    renderHook(() => useMessageLstCache(CONVERSATION_ID), { wrapper: CacheWrapper });

    await act(async () => {
      await Promise.resolve();
    });

    invoke.mockClear();

    act(() => {
      emitTurnCompleted?.({ session_id: CONVERSATION_ID, turn_id: 'turn-1' });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).not.toHaveBeenCalled();
  });

  it('ignores turnCompleted for a different conversation even with a pending row', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    let emitUserCreated: ((payload: any) => void) | undefined;
    let emitTurnCompleted: ((payload: any) => void) | undefined;
    vi.mocked(ipcBridge.conversation.userCreated.on).mockImplementation((cb: any) => {
      emitUserCreated = cb;
      return () => {};
    });
    vi.mocked(ipcBridge.conversation.turnCompleted.on).mockImplementation((cb: any) => {
      emitTurnCompleted = cb;
      return () => {};
    });

    function useCacheAndListHarness() {
      useMessageLstCache(CONVERSATION_ID);
      return { messages: useMessageList() };
    }

    renderHook(() => useCacheAndListHarness(), { wrapper: CacheWrapper });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitUserCreated?.({
        conversation_id: CONVERSATION_ID,
        msg_id: 'msg-midturn-4',
        content: 'sent mid-turn',
        position: 'right',
        status: 'pending',
        hidden: false,
        created_at: Date.now(),
      });
    });

    invoke.mockClear();

    act(() => {
      emitTurnCompleted?.({ session_id: 'other-conversation', turn_id: 'turn-1' });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).not.toHaveBeenCalled();
  });
});
