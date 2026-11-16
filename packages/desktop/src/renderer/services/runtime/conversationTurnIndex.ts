/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IConversationTurnCompletedEvent, IResponseMessage } from '@/common/adapter/ipcBridge';
import { useCallback, useSyncExternalStore } from 'react';

export type ConversationTurnRecord = {
  turnId: string;
  state: 'running' | 'completed' | 'stopped' | 'error';
  startedAt?: number;
  completedAt?: number;
  lastMessageId?: string;
};

export type ConversationTurnSnapshot = {
  records: ReadonlyMap<string, ConversationTurnRecord>;
  messageTurnIds: ReadonlyMap<string, string>;
  toolTurnIds: ReadonlyMap<string, string>;
  backendTurnIds: ReadonlyMap<string, string>;
};

type TurnMessage = {
  type: string;
  turn_id?: string;
  msg_id?: string;
  backend_turn_id?: string;
  content?: unknown;
};
type TurnIndexStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const EMPTY_CONVERSATION_TURN_SNAPSHOT: ConversationTurnSnapshot = {
  records: new Map(),
  messageTurnIds: new Map(),
  toolTurnIds: new Map(),
  backendTurnIds: new Map(),
};

const STORAGE_PREFIX = 'aionui.conversation-turns.v1:';
const MAX_CACHED_CONVERSATIONS = 50;
const MAX_CACHED_TURNS = 100;
const MAX_CACHED_LINKS = 4000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isIdentifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function toolKeys(type: string, content: unknown): string[] {
  if (type === 'tool_group' && Array.isArray(content)) {
    return content.flatMap((item: unknown) =>
      isRecord(item) && isIdentifier(item.call_id) ? [`call:${item.call_id}`] : []
    );
  }
  if (!isRecord(content)) return [];
  if (type === 'acp_tool_call') {
    const update = isRecord(content.update) ? content.update : content;
    return isIdentifier(update.tool_call_id) ? [`acp:${update.tool_call_id}`] : [];
  }
  if (type === 'tool_call' && isIdentifier(content.call_id)) return [`call:${content.call_id}`];
  if (type === 'acp_terminal_output' && isIdentifier(content.terminal_id)) return [`terminal:${content.terminal_id}`];
  return [];
}

/** Resolve stable server identifiers; a tool update keeps its original turn even when it arrives late. */
export function resolveConversationMessageTurnId(
  message: TurnMessage,
  snapshot: ConversationTurnSnapshot
): string | undefined {
  for (const key of toolKeys(message.type, message.content)) {
    const originalTurn = snapshot.toolTurnIds.get(key);
    if (originalTurn) return originalTurn;
  }
  return (
    message.turn_id ||
    (message.msg_id ? snapshot.messageTurnIds.get(message.msg_id) : undefined) ||
    (message.backend_turn_id ? snapshot.backendTurnIds.get(message.backend_turn_id) : undefined)
  );
}

function parseLinks(value: unknown): Map<string, string> {
  if (!Array.isArray(value)) return new Map();
  return new Map(
    value
      .slice(-MAX_CACHED_LINKS)
      .filter(
        (entry): entry is [string, string] => Array.isArray(entry) && entry.length === 2 && entry.every(isIdentifier)
      )
  );
}

function parseSnapshot(value: unknown): ConversationTurnSnapshot {
  if (!isRecord(value)) return EMPTY_CONVERSATION_TURN_SNAPSHOT;
  const records = new Map<string, ConversationTurnRecord>();
  if (Array.isArray(value.records)) {
    for (const record of value.records.slice(-MAX_CACHED_TURNS)) {
      if (
        !isRecord(record) ||
        !isIdentifier(record.turnId) ||
        !['running', 'completed', 'stopped', 'error'].includes(String(record.state))
      ) {
        continue;
      }
      records.set(record.turnId, {
        turnId: record.turnId,
        state: record.state as ConversationTurnRecord['state'],
        ...(isTimestamp(record.startedAt) ? { startedAt: record.startedAt } : {}),
        ...(isTimestamp(record.completedAt) ? { completedAt: record.completedAt } : {}),
        ...(isIdentifier(record.lastMessageId) ? { lastMessageId: record.lastMessageId } : {}),
      });
    }
  }
  return {
    records,
    messageTurnIds: parseLinks(value.messageTurnIds),
    toolTurnIds: parseLinks(value.toolTurnIds),
    backendTurnIds: parseLinks(value.backendTurnIds),
  };
}

/** Collect UI-only metadata without storing message bodies or changing backend history. */
export function createConversationTurnIndex(storage?: TurnIndexStorage) {
  const conversations = new Map<string, ConversationTurnSnapshot>();
  const listeners = new Set<() => void>();
  let scope: string | null = null;

  const getSnapshot = (conversationId: string): ConversationTurnSnapshot =>
    conversations.get(conversationId) ?? EMPTY_CONVERSATION_TURN_SNAPSHOT;
  const notify = () => listeners.forEach((listener) => listener());
  const persist = () => {
    if (!scope) return;
    try {
      const target = storage ?? globalThis.localStorage;
      target.setItem(
        STORAGE_PREFIX + scope,
        JSON.stringify({
          version: 1,
          conversations: [...conversations].slice(-MAX_CACHED_CONVERSATIONS).map(([id, snapshot]) => [
            id,
            {
              records: [...snapshot.records.values()].slice(-MAX_CACHED_TURNS),
              messageTurnIds: [...snapshot.messageTurnIds].slice(-MAX_CACHED_LINKS),
              toolTurnIds: [...snapshot.toolTurnIds].slice(-MAX_CACHED_LINKS),
              backendTurnIds: [...snapshot.backendTurnIds].slice(-MAX_CACHED_LINKS),
            },
          ]),
        })
      );
    } catch {
      // Storage is best-effort; a full or unavailable cache must not affect a live turn.
    }
  };
  const publish = (conversationId: string, snapshot: ConversationTurnSnapshot) => {
    const bounded: ConversationTurnSnapshot = {
      records:
        snapshot.records.size > MAX_CACHED_TURNS
          ? new Map([...snapshot.records].slice(-MAX_CACHED_TURNS))
          : snapshot.records,
      messageTurnIds:
        snapshot.messageTurnIds.size > MAX_CACHED_LINKS
          ? new Map([...snapshot.messageTurnIds].slice(-MAX_CACHED_LINKS))
          : snapshot.messageTurnIds,
      toolTurnIds:
        snapshot.toolTurnIds.size > MAX_CACHED_LINKS
          ? new Map([...snapshot.toolTurnIds].slice(-MAX_CACHED_LINKS))
          : snapshot.toolTurnIds,
      backendTurnIds:
        snapshot.backendTurnIds.size > MAX_CACHED_LINKS
          ? new Map([...snapshot.backendTurnIds].slice(-MAX_CACHED_LINKS))
          : snapshot.backendTurnIds,
    };
    conversations.delete(conversationId);
    conversations.set(conversationId, bounded);
    if (conversations.size > MAX_CACHED_CONVERSATIONS) {
      const oldest = conversations.keys().next().value;
      if (oldest !== undefined) conversations.delete(oldest);
    }
    persist();
    notify();
  };

  return {
    getSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setScope(nextScope: string | null) {
      if (scope === nextScope) return;
      scope = nextScope;
      conversations.clear();
      if (scope) {
        try {
          const target = storage ?? globalThis.localStorage;
          const cached: unknown = JSON.parse(target.getItem(STORAGE_PREFIX + scope) ?? 'null');
          if (isRecord(cached) && cached.version === 1 && Array.isArray(cached.conversations)) {
            for (const entry of cached.conversations.slice(-MAX_CACHED_CONVERSATIONS)) {
              if (Array.isArray(entry) && entry.length === 2 && isIdentifier(entry[0])) {
                conversations.set(entry[0], parseSnapshot(entry[1]));
              }
            }
          }
        } catch {
          // Old or malformed local data falls back to server history grouping.
        }
      }
      notify();
    },
    accepted(conversationId: string, turnId: string, msgId?: string, at = Date.now()) {
      if (!conversationId || !turnId) return;
      const current = getSnapshot(conversationId);
      const existing = current.records.get(turnId);
      const records = new Map(current.records);
      if (!existing) records.set(turnId, { turnId, state: 'running', startedAt: at });
      const messageTurnIds = new Map(current.messageTurnIds);
      if (msgId && !messageTurnIds.has(msgId)) messageTurnIds.set(msgId, turnId);
      publish(conversationId, { ...current, records, messageTurnIds });
    },
    stream(message: IResponseMessage, at = Date.now()) {
      if (!message.conversation_id) return;
      const current = getSnapshot(message.conversation_id);
      const turnId = resolveConversationMessageTurnId({ ...message, content: message.data }, current);
      if (!turnId) return;
      const keys = toolKeys(message.type, message.data);
      const existing = current.records.get(turnId);
      const startsTurn = message.type === 'start' && !existing;
      const endsTurn = (message.type === 'finish' || message.type === 'error') && existing?.completedAt === undefined;
      if (
        !startsTurn &&
        !endsTurn &&
        keys.every((key) => current.toolTurnIds.has(key)) &&
        (!message.msg_id || current.messageTurnIds.has(message.msg_id)) &&
        (!message.backend_turn_id || current.backendTurnIds.has(message.backend_turn_id))
      ) {
        return;
      }
      const records = new Map(current.records);
      const messageTurnIds = new Map(current.messageTurnIds);
      const toolTurnIds = new Map(current.toolTurnIds);
      const backendTurnIds = new Map(current.backendTurnIds);
      let changed = false;
      for (const key of keys) {
        if (!toolTurnIds.has(key)) {
          toolTurnIds.set(key, turnId);
          changed = true;
        }
      }
      // The msg_id of a trailing tool update may belong to a different host turn.
      if (message.msg_id && !messageTurnIds.has(message.msg_id)) {
        messageTurnIds.set(message.msg_id, message.turn_id ?? turnId);
        changed = true;
      }
      if (message.backend_turn_id && !backendTurnIds.has(message.backend_turn_id)) {
        backendTurnIds.set(message.backend_turn_id, message.turn_id ?? turnId);
        changed = true;
      }
      if (startsTurn) {
        records.set(turnId, {
          turnId,
          state: 'running',
          startedAt: isTimestamp(message.created_at) ? message.created_at : at,
        });
        changed = true;
      } else if (endsTurn) {
        records.set(turnId, {
          ...existing,
          turnId,
          state: message.type === 'error' ? 'error' : 'completed',
          completedAt: at,
        });
        changed = true;
      }
      if (changed) publish(message.conversation_id, { records, messageTurnIds, toolTurnIds, backendTurnIds });
    },
    completed(event: IConversationTurnCompletedEvent, at = Date.now()) {
      if (!event.session_id || !event.turn_id || event.status !== 'finished') return;
      if (['ai_generating', 'ai_waiting_confirmation', 'initializing'].includes(event.state)) return;
      const current = getSnapshot(event.session_id);
      const existing = current.records.get(event.turn_id);
      const records = new Map(current.records);
      records.set(event.turn_id, {
        ...existing,
        turnId: event.turn_id,
        state: event.state === 'error' ? 'error' : event.state === 'stopped' ? 'stopped' : 'completed',
        completedAt: existing?.completedAt ?? at,
        ...(event.last_message?.type === 'text' && event.last_message.id
          ? { lastMessageId: event.last_message.id }
          : {}),
      });
      publish(event.session_id, { ...current, records });
    },
    deleted(conversationId: string) {
      if (conversations.delete(conversationId)) {
        persist();
        notify();
      }
    },
  };
}

const conversationTurnIndex = createConversationTurnIndex();

/** Observe every conversation while the application is open, including background turns. */
export function observeConversationTurns(scope: string): () => void {
  conversationTurnIndex.setScope(scope);
  const unsubscribeStream = ipcBridge.conversation.responseStream.on((message) =>
    conversationTurnIndex.stream(message)
  );
  const unsubscribeCompleted = ipcBridge.conversation.turnCompleted.on((event) =>
    conversationTurnIndex.completed(event)
  );
  const unsubscribeDeleted = ipcBridge.conversation.listChanged.on((event) => {
    if (event.action === 'deleted') conversationTurnIndex.deleted(event.conversation_id);
  });
  return () => {
    unsubscribeStream();
    unsubscribeCompleted();
    unsubscribeDeleted();
    conversationTurnIndex.setScope(null);
  };
}

/** Associate the canonical user message with its accepted host turn. */
export function recordConversationTurnAccepted(conversationId: string, turnId: string, msgId?: string): void {
  conversationTurnIndex.accepted(conversationId, turnId, msgId);
}

/** Subscribe to immutable turn metadata for one conversation. */
export function useConversationTurnIndex(conversationId: string): ConversationTurnSnapshot {
  const getSnapshot = useCallback(() => conversationTurnIndex.getSnapshot(conversationId), [conversationId]);
  return useSyncExternalStore(conversationTurnIndex.subscribe, getSnapshot, getSnapshot);
}
