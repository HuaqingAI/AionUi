import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IConversationTurnCompletedEvent, IResponseMessage } from '@/common/adapter/ipcBridge';
import { transformMessage } from '@/common/chat/chatLib';
import {
  createConversationTurnIndex,
  resolveConversationMessageTurnId,
} from '@/renderer/services/runtime/conversationTurnIndex';
import type { TConversationRuntimeSummary } from '@/common/config/storage';
import {
  getConversationRuntimeViewSnapshot,
  hydrateSucceeded,
  localSendAccepted,
  localSendStarted,
  localStopAcknowledged,
  localStopRequested,
  resetConversationRuntimeViewStoreForTest,
  turnCompleted,
} from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';

const idleRuntime = (): TConversationRuntimeSummary => ({
  state: 'idle',
  can_send_message: true,
  has_task: true,
  task_status: 'finished',
  is_processing: false,
  pending_confirmations: 0,
  turn_id: null,
});

const runningRuntime = (turn_id: string): TConversationRuntimeSummary => ({
  state: 'running',
  can_send_message: false,
  has_task: true,
  task_status: 'running',
  is_processing: true,
  pending_confirmations: 0,
  turn_id,
});

const cancellingRuntime = (turn_id: string): TConversationRuntimeSummary => ({
  state: 'cancelling',
  can_send_message: true,
  has_task: true,
  task_status: 'running',
  is_processing: false,
  pending_confirmations: 0,
  turn_id,
});

describe('conversationRuntimeViewStore turn id contract', () => {
  beforeEach(() => {
    resetConversationRuntimeViewStoreForTest();
  });

  it('ignores a stale turn.completed for a turn that is no longer active (codex background exec)', () => {
    // codex ends its prompt turn while unified exec keeps the command running;
    // the trailing CLI-initiated turn's completion lands AFTER the user's next
    // turn started and used to clear that new turn's pending gate.
    localSendStarted('conv-1');
    localSendAccepted('conv-1', 'turn-new', runningRuntime('turn-new'), 'msg-1');
    expect(getConversationRuntimeViewSnapshot('conv-1').activeTurnId).toBe('turn-new');

    const logs = turnCompleted('conv-1', 'turn-orphan', idleRuntime());

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.activeTurnId).toBe('turn-new');
    expect(view.isProcessing).toBe(true);
    expect(view.canSendMessage).toBe(false);
    expect(logs.map((l) => l.event)).toContain('turn_completed_ignored_for_other_turn');
  });

  it('still applies turn.completed for the active turn', () => {
    localSendStarted('conv-1');
    localSendAccepted('conv-1', 'turn-1', runningRuntime('turn-1'), 'msg-1');

    const logs = turnCompleted('conv-1', 'turn-1', idleRuntime());

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.canSendMessage).toBe(true);
    expect(view.isProcessing).toBe(false);
    expect(logs.map((l) => l.event)).toContain('turn_completed_applied');
  });

  it('keeps idle when turn.completed arrives before local send accepted', () => {
    localSendStarted('conv-1');
    turnCompleted('conv-1', 'turn-1', idleRuntime());
    localSendAccepted('conv-1', 'turn-1', runningRuntime('turn-1'), 'msg-1');

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('idle');
    expect(view.isProcessing).toBe(false);
    expect(view.canSendMessage).toBe(true);
    expect(view.localSubmitting).toBe(false);
    expect(view.activeTurnId).toBeNull();
  });

  it('keeps idle when a stale running hydrate arrives after turn.completed', () => {
    localSendStarted('conv-1');
    localSendAccepted('conv-1', 'turn-1', runningRuntime('turn-1'), 'msg-1');
    turnCompleted('conv-1', 'turn-1', idleRuntime());
    const logs = hydrateSucceeded('conv-1', runningRuntime('turn-1'));

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('idle');
    expect(view.isProcessing).toBe(false);
    expect(view.canSendMessage).toBe(true);
    expect(view.activeTurnId).toBeNull();
    expect(logs[0]).toMatchObject({
      event: 'runtime_hydrated',
      data: {
        stale_after_completed: true,
        source: 'hydrate',
      },
    });
  });

  it('keeps idle when a stale stop acknowledgement arrives after turn.completed', () => {
    hydrateSucceeded('conv-1', runningRuntime('turn-1'));
    localStopRequested('conv-1', 'turn-1');
    turnCompleted('conv-1', 'turn-1', idleRuntime());
    const logs = localStopAcknowledged('conv-1', 'turn-1', runningRuntime('turn-1'));

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('idle');
    expect(view.isProcessing).toBe(false);
    expect(view.canSendMessage).toBe(true);
    expect(view.localStopping).toBe(false);
    expect(view.activeTurnId).toBeNull();
    expect(logs[0]).toMatchObject({
      event: 'local_stop_acknowledged',
      data: {
        stale_after_completed: true,
        source: 'stop_response',
      },
    });
  });

  it('uses send response runtime summary as authoritative active turn', () => {
    localSendStarted('conv-1');
    localSendAccepted('conv-1', 'turn-1', runningRuntime('turn-1'), 'msg-1');

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('running');
    expect(view.isProcessing).toBe(true);
    expect(view.canSendMessage).toBe(false);
    expect(view.localSubmitting).toBe(false);
    expect(view.activeTurnId).toBe('turn-1');
  });

  it('keeps cancelling runtime gated from new sends', () => {
    hydrateSucceeded('conv-1', cancellingRuntime('turn-cancel'));

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('cancelling');
    expect(view.isProcessing).toBe(true);
    expect(view.canSendMessage).toBe(false);
    expect(view.activeTurnId).toBe('turn-cancel');
  });

  it('ignores stale stop ack for an older turn', () => {
    hydrateSucceeded('conv-1', runningRuntime('turn-2'));
    localStopRequested('conv-1', 'turn-1');
    localStopAcknowledged('conv-1', 'turn-1', runningRuntime('turn-2'));

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.activeTurnId).toBe('turn-2');
    expect(view.isProcessing).toBe(true);
    expect(view.localStopping).toBe(false);
  });

  it('uses cancel response runtime summary as authoritative state', () => {
    hydrateSucceeded('conv-1', runningRuntime('turn-1'));
    localStopRequested('conv-1', 'turn-1');
    localStopAcknowledged('conv-1', 'turn-1', runningRuntime('turn-2'));

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.activeTurnId).toBe('turn-2');
    expect(view.isProcessing).toBe(true);
    expect(view.localStopping).toBe(false);
  });
});

function frame(type: string, turnId: string, data: unknown = {}, msgId = turnId): IResponseMessage {
  return { type, turn_id: turnId, msg_id: msgId, conversation_id: 'conversation-1', data };
}

function completed(
  turnId: string,
  state: IConversationTurnCompletedEvent['state'] = 'ai_waiting_input'
): IConversationTurnCompletedEvent {
  return {
    session_id: 'conversation-1',
    turn_id: turnId,
    status: 'finished',
    state,
    detail: '',
    can_send_message: true,
    runtime: {
      state: 'idle',
      can_send_message: true,
      has_task: false,
      is_processing: false,
      pending_confirmations: 0,
      turn_id: null,
      supports_midturn_delivery: false,
    },
    workspace: '',
    model: { platform: '', name: '', use_model: '' },
    last_message: { id: 'persisted-final', type: 'text', content: null, created_at: 20 },
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('conversation turn metadata', () => {
  it('keeps the server turn id when a text frame becomes a renderer message', () => {
    const message = transformMessage(frame('content', 'turn-1', 'reply'));
    expect(message?.turn_id).toBe('turn-1');
    expect(transformMessage({ ...frame('content', '', 'reply'), turn_id: undefined })?.turn_id).toBeUndefined();
  });

  it('associates an accepted user message with its turn without a stream frame', () => {
    const index = createConversationTurnIndex();
    index.accepted('conversation-1', 'turn-1', 'canonical-user-message', 10);
    const snapshot = index.getSnapshot('conversation-1');
    expect(resolveConversationMessageTurnId({ type: 'text', msg_id: 'canonical-user-message' }, snapshot)).toBe(
      'turn-1'
    );
    expect(snapshot.records.get('turn-1')?.startedAt).toBe(10);
  });

  it('keeps a late tool result in its original turn while preserving the new turn message id', () => {
    const index = createConversationTurnIndex();
    index.stream(frame('acp_tool_call', 'turn-1', { update: { tool_call_id: 'exec-1' } }));
    index.completed(completed('turn-1'), 20);
    index.stream(frame('acp_tool_call', 'turn-2', { update: { tool_call_id: 'exec-1' } }, 'turn-2-message'));
    const snapshot = index.getSnapshot('conversation-1');
    expect(
      resolveConversationMessageTurnId(
        { type: 'acp_tool_call', turn_id: 'turn-2', content: { update: { tool_call_id: 'exec-1' } } },
        snapshot
      )
    ).toBe('turn-1');
    expect(snapshot.messageTurnIds.get('turn-2-message')).toBe('turn-2');
    expect(snapshot.records.get('turn-1')?.state).toBe('completed');
  });

  it('does not reopen a completed turn when late start or content frames arrive', () => {
    const index = createConversationTurnIndex();
    index.stream({ ...frame('start', 'turn-1'), created_at: 10 });
    index.completed(completed('turn-1', 'stopped'), 20);
    index.stream(frame('start', 'turn-1'), 30);
    index.stream(frame('content', 'turn-1', 'late content'), 40);
    expect(index.getSnapshot('conversation-1').records.get('turn-1')).toEqual({
      turnId: 'turn-1',
      state: 'stopped',
      startedAt: 10,
      completedAt: 20,
      lastMessageId: 'persisted-final',
    });
  });

  it('does not invent a start time when only a completion was observed', () => {
    const index = createConversationTurnIndex();
    index.completed(completed('turn-1', 'error'), 20);
    expect(index.getSnapshot('conversation-1').records.get('turn-1')?.startedAt).toBeUndefined();
    expect(index.getSnapshot('conversation-1').records.get('turn-1')?.state).toBe('error');
  });

  it('does not treat waiting for confirmation as normal completion', () => {
    const index = createConversationTurnIndex();
    index.accepted('conversation-1', 'turn-1', 'user-1', 10);
    index.completed(completed('turn-1', 'ai_waiting_confirmation'), 20);
    expect(index.getSnapshot('conversation-1').records.get('turn-1')?.state).toBe('running');
  });

  it('restores metadata only in the same backend and account scope, without persisting bodies', () => {
    const storage = memoryStorage();
    const save = vi.spyOn(storage, 'setItem');
    const index = createConversationTurnIndex(storage);
    index.setScope('backend/account-1');
    index.stream(frame('start', 'turn-1'), 10);
    index.stream(frame('content', 'turn-1', 'private body'), 11);
    index.completed(completed('turn-1'), 20);
    index.setScope('backend/account-2');
    expect(index.getSnapshot('conversation-1').records.size).toBe(0);
    index.setScope('backend/account-1');
    expect(index.getSnapshot('conversation-1').records.get('turn-1')?.completedAt).toBe(20);
    expect(save.mock.calls.some(([, payload]) => payload.includes('private body'))).toBe(false);
  });

  it('does not publish or write storage again for subsequent tokens with unchanged metadata', () => {
    const storage = memoryStorage();
    const save = vi.spyOn(storage, 'setItem');
    const index = createConversationTurnIndex(storage);
    index.setScope('scope');
    index.stream(frame('content', 'turn-1', 'first'));
    const listener = vi.fn();
    index.subscribe(listener);
    save.mockClear();
    index.stream(frame('content', 'turn-1', 'second'));
    expect(listener).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps live grouping available when local storage is corrupt or unavailable', () => {
    const storage = {
      getItem: () => 'invalid JSON',
      setItem: () => {
        throw new Error('storage unavailable');
      },
    };
    const index = createConversationTurnIndex(storage);
    index.setScope('scope');
    index.accepted('conversation-1', 'turn-1', 'user-1', 10);
    index.completed(completed('turn-1'), 20);
    expect(index.getSnapshot('conversation-1').records.get('turn-1')?.state).toBe('completed');
    expect(index.getSnapshot('missing').records.size).toBe(0);
  });
});
