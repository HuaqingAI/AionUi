/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildTurnClipboardText } from '@/renderer/utils/chat/turnCopy';

/** The fields shared by stored messages and the tool/file timeline summaries. */
export type TurnTimelineItem = {
  id: string;
  type: string;
  position?: string;
  turn_id?: string;
  msg_id?: string;
  status?: string;
  content?: unknown;
  messages?: readonly TurnTimelineItem[];
  sourceMessageIds?: readonly string[];
};

export type MessageTurnState = 'running' | 'completed' | 'stopped' | 'error' | 'incomplete';

export type MessageTurn<T> = {
  /** Stable display segment identity; several segments may belong to one turn. */
  id: string;
  turnId?: string;
  kind: 'turn' | 'standalone';
  items: T[];
  processItems: T[];
  /** The final answer and messages that require attention outside the process. */
  finalItems: T[];
  sourceMessageIds: string[];
  state: MessageTurnState;
  isRunning: boolean;
  /** Another display segment contains the rest of this same assistant turn. */
  hasLaterSegment?: boolean;
};

export type GroupMessageTurnsOptions<T> = {
  isProcessing: boolean;
  activeTurnId?: string | null;
  hasMoreAfter?: boolean;
  resolveTurnId?: (item: T) => string | undefined;
  getTurnState?: (turnId: string) => Exclude<MessageTurnState, 'incomplete'> | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUserMessage = (item: TurnTimelineItem): boolean => item.position === 'right';

const isIndependentMessage = (item: TurnTimelineItem): boolean =>
  item.type === 'artifact' || (isRecord(item.content) && item.content.teammateMessage === true);

const requiresAttention = (item: TurnTimelineItem): boolean =>
  item.type === 'permission' ||
  item.type === 'acp_permission' ||
  item.type === 'ask' ||
  (item.type === 'agent_status' && isRecord(item.content) && item.content.status === 'error') ||
  (item.type === 'tips' && isRecord(item.content) && ['error', 'warning'].includes(String(item.content.type)));

const isErrorMessage = (item: TurnTimelineItem): boolean =>
  isRecord(item.content) &&
  ((item.type === 'tips' && item.content.type === 'error') ||
    (item.type === 'agent_status' && item.content.status === 'error'));

const isAssistantText = (item: TurnTimelineItem): boolean =>
  item.type === 'text' &&
  item.position !== 'right' &&
  isRecord(item.content) &&
  typeof item.content.content === 'string' &&
  buildTurnClipboardText([item.content.content]).length > 0;

const isToolMessage = (item: TurnTimelineItem): boolean =>
  ['tool_call', 'tool_group', 'tool_summary', 'acp_tool_call', 'acp_terminal_output', 'file_summary'].includes(
    item.type
  );

const collectSourceMessageIds = (items: readonly TurnTimelineItem[]): string[] => {
  const ids = new Set<string>();
  for (const item of items) {
    ids.add(item.id);
    for (const id of item.sourceMessageIds ?? []) ids.add(id);
    for (const child of item.messages ?? []) {
      ids.add(child.id);
      for (const id of child.sourceMessageIds ?? []) ids.add(id);
    }
  }
  return [...ids];
};

/**
 * Project an immutable timeline into user rows and collapsible assistant turns.
 * Explicit runtime turn identities take precedence over legacy user boundaries.
 * A user's mid-turn follow-up remains visible and splits only the display segment,
 * while all segments keep the real turn's running/completion state.
 */
export function groupMessageTurns<T extends TurnTimelineItem>(
  items: readonly T[],
  options: GroupMessageTurnsOptions<T>
): MessageTurn<T>[] {
  const groups: MessageTurn<T>[] = [];
  const latestByTurnId = new Map<string, MessageTurn<T>>();
  const boundaryByGroup = new Map<MessageTurn<T>, string>();
  const latestByBoundary = new Map<string, MessageTurn<T>>();
  let current: MessageTurn<T> | undefined;
  let userBoundaryId = 'start';
  let latestUserTurnId: string | undefined;

  for (const item of items) {
    if (isUserMessage(item) || isIndependentMessage(item)) {
      groups.push({
        id: `row:${item.id}`,
        kind: 'standalone',
        items: [item],
        processItems: [],
        finalItems: [item],
        sourceMessageIds: collectSourceMessageIds([item]),
        state: 'completed',
        isRunning: false,
      });
      if (isUserMessage(item)) {
        userBoundaryId = item.id;
        latestUserTurnId = options.resolveTurnId?.(item) ?? item.turn_id;
      }
      current = undefined;
      continue;
    }

    const turnId = options.resolveTurnId?.(item) ?? item.turn_id;
    // Background tools can publish their exit snapshot after another turn has
    // started. Their original turn remains the owner of the existing tool card.
    const previousOwner = turnId && isToolMessage(item) ? latestByTurnId.get(turnId) : undefined;
    if (previousOwner && previousOwner !== current && current?.turnId !== turnId) {
      let insertAt = previousOwner.items.length;
      while (insertAt > 0 && isAssistantText(previousOwner.items[insertAt - 1])) insertAt--;
      previousOwner.items.splice(insertAt, 0, item);
      continue;
    }

    if (!current || (turnId && current.turnId && current.turnId !== turnId)) {
      current = {
        id: `turn:${turnId ?? userBoundaryId}:${item.id}`,
        ...(turnId ? { turnId } : {}),
        kind: 'turn',
        items: [],
        processItems: [],
        finalItems: [],
        sourceMessageIds: [],
        state: 'completed',
        isRunning: false,
      };
      groups.push(current);
      boundaryByGroup.set(current, userBoundaryId);
      latestByBoundary.set(userBoundaryId, current);
    } else if (turnId && !current.turnId) {
      current.turnId = turnId;
    }
    current.items.push(item);
    if (current.turnId) latestByTurnId.set(current.turnId, current);
  }

  const lastAssistantGroup = groups.findLast((group) => group.kind === 'turn');
  for (const group of groups) {
    if (group.kind === 'standalone') continue;

    const observedState = group.turnId ? options.getTurnState?.(group.turnId) : undefined;
    const isLastLegacyTurn = boundaryByGroup.get(group) === userBoundaryId;
    group.isRunning =
      options.isProcessing &&
      (group.turnId && options.activeTurnId
        ? group.turnId === options.activeTurnId
        : group.turnId
          ? group === lastAssistantGroup && (isLastLegacyTurn || group.turnId === latestUserTurnId)
          : isLastLegacyTurn);
    // A cached start can survive a missed completion event or an application
    // restart. The current runtime, rather than that observation, owns liveness.
    const knownState = observedState === 'running' && !group.isRunning ? undefined : observedState;
    const hasError = group.items.some(isErrorMessage);
    const hasLaterSegment = group.turnId
      ? latestByTurnId.get(group.turnId) !== group
      : latestByBoundary.get(boundaryByGroup.get(group) ?? '') !== group;
    group.hasLaterSegment = hasLaterSegment;
    const hasUnloadedTail =
      options.hasMoreAfter &&
      group === lastAssistantGroup &&
      (isLastLegacyTurn || (group.turnId && group.turnId === latestUserTurnId));
    group.state = hasError
      ? 'error'
      : group.isRunning
        ? 'running'
        : hasUnloadedTail && (!knownState || knownState === 'completed')
          ? 'incomplete'
          : (knownState ?? 'completed');

    const finalTextIds = new Set<string>();
    if (group.state === 'completed' && !group.isRunning && !hasLaterSegment) {
      // Keep the entire trailing answer, even when a provider gives consecutive
      // text blocks different identifiers. Tool output after progress text is
      // not sufficient evidence that the earlier text was a final answer.
      for (let i = group.items.length - 1; i >= 0; i--) {
        const item = group.items[i];
        if (requiresAttention(item)) continue;
        if (item.type === 'agent_status') continue;
        if (item.type === 'text' && !isAssistantText(item)) continue;
        if (!isAssistantText(item)) break;
        finalTextIds.add(item.id);
      }
    }

    group.finalItems = group.items.filter((item) => requiresAttention(item) || finalTextIds.has(item.id));
    group.processItems = group.items.filter(
      (item) =>
        !requiresAttention(item) && !finalTextIds.has(item.id) && (item.type !== 'text' || isAssistantText(item))
    );
    group.sourceMessageIds = collectSourceMessageIds(group.items);
  }

  return groups;
}
