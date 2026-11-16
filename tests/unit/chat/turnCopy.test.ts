/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildTurnClipboardText, collectAiCopyRows } from '@/renderer/utils/chat/turnCopy';
import { groupMessageTurns, type TurnTimelineItem } from '@/renderer/pages/conversation/Messages/MessageList/turns';

const user = (id: string) => ({ id, type: 'text', position: 'right', content: { content: 'q' } });
const aiText = (id: string, content: string) => ({ id, type: 'text', position: 'left', content: { content } });
const tool = (id: string) => ({ id, type: 'tool_call', position: 'left', content: {} });
const thinking = (id: string) => ({ id, type: 'thinking', position: 'left', content: { content: 'hmm' } });

describe('collectAiCopyRows', () => {
  it('puts the row on a simple single-text turn and carries its text', () => {
    const { copyRowIds, turnTextsById } = collectAiCopyRows([user('u1'), aiText('a1', 'hello')], false);
    expect([...copyRowIds]).toEqual(['a1']);
    expect(turnTextsById.get('a1')).toEqual(['hello']);
  });

  it('collects EVERY text segment of a turn split by tool calls and thinking', () => {
    // The bug: copying the turn only yielded segment B; A was lost.
    const { copyRowIds, turnTextsById } = collectAiCopyRows(
      [user('u1'), aiText('a1', 'part A'), tool('t1'), thinking('th1'), aiText('a2', 'part B')],
      false
    );
    expect([...copyRowIds]).toEqual(['a2']);
    expect(turnTextsById.get('a2')).toEqual(['part A', 'part B']);
  });

  it('keeps turns separated by user messages independent', () => {
    const { copyRowIds, turnTextsById } = collectAiCopyRows(
      [user('u1'), aiText('a1', 'first'), user('u2'), aiText('b1', 'second-1'), tool('t1'), aiText('b2', 'second-2')],
      false
    );
    expect([...copyRowIds]).toEqual(['a1', 'b2']);
    expect(turnTextsById.get('a1')).toEqual(['first']);
    expect(turnTextsById.get('b2')).toEqual(['second-1', 'second-2']);
  });

  it('withholds the final turn while streaming, texts included', () => {
    const { copyRowIds, turnTextsById } = collectAiCopyRows(
      [user('u1'), aiText('a1', 'done turn'), user('u2'), aiText('b1', 'still streaming')],
      true
    );
    expect([...copyRowIds]).toEqual(['a1']);
    expect(turnTextsById.has('b1')).toBe(false);
  });

  it('ignores pseudo entries without breaking the turn', () => {
    const { turnTextsById } = collectAiCopyRows(
      [
        user('u1'),
        aiText('a1', 'part A'),
        { id: 's1', type: 'tool_summary', position: 'left', content: {} },
        aiText('a2', 'part B'),
      ],
      false
    );
    expect(turnTextsById.get('a2')).toEqual(['part A', 'part B']);
  });

  it('skips empty text segments', () => {
    const { turnTextsById } = collectAiCopyRows([user('u1'), aiText('a1', '  '), aiText('a2', 'real')], false);
    expect(turnTextsById.get('a2')).toEqual(['real']);
  });
});

describe('buildTurnClipboardText', () => {
  it('joins segments with a blank line', () => {
    expect(buildTurnClipboardText(['part A', 'part B'])).toBe('part A\n\npart B');
  });

  it('strips think tags and skill-suggest blocks per segment', () => {
    const joined = buildTurnClipboardText([
      '<think>draft</think>answer',
      'tail [SKILL_SUGGEST]{"skills":[]}[/SKILL_SUGGEST]',
    ]);
    expect(joined).not.toContain('draft');
    expect(joined).not.toContain('SKILL_SUGGEST');
    expect(joined).toContain('answer');
    expect(joined).toContain('tail');
  });

  it('drops segments that clean down to nothing', () => {
    expect(buildTurnClipboardText(['<think>only draft</think>', 'kept'])).toBe('kept');
  });
});

const turnUser = (id: string): TurnTimelineItem => ({ id, type: 'text', position: 'right', content: { content: id } });
const text = (id: string, turn_id?: string): TurnTimelineItem => ({
  id,
  type: 'text',
  position: 'left',
  turn_id,
  content: { content: id },
});
const turnTool = (id: string, turn_id?: string): TurnTimelineItem => ({ id, type: 'acp_tool_call', turn_id });
const ids = (items: readonly TurnTimelineItem[]): string[] => items.map((item) => item.id);

describe('groupMessageTurns', () => {
  it('keeps all intermediate messages together and retains consecutive final answer blocks', () => {
    const turns = groupMessageTurns(
      [
        turnUser('question'),
        text('progress'),
        turnTool('check'),
        { id: 'thought', type: 'thinking' },
        text('answer'),
        text('tail'),
      ],
      { isProcessing: false }
    );

    expect(ids(turns[1].processItems)).toEqual(['progress', 'check', 'thought']);
    expect(ids(turns[1].finalItems)).toEqual(['answer', 'tail']);
    expect(turns[0].kind).toBe('standalone');
  });

  it('does not add a process for a plain text reply', () => {
    const turns = groupMessageTurns([turnUser('question'), text('answer')], { isProcessing: false });

    expect(turns[1].processItems).toEqual([]);
    expect(ids(turns[1].finalItems)).toEqual(['answer']);
  });

  it('ignores an empty trailing text frame without hiding the actual answer', () => {
    const turns = groupMessageTurns(
      [turnUser('question'), text('answer'), { ...text('empty'), content: { content: '  ' } }],
      { isProcessing: false }
    );

    expect(ids(turns[1].finalItems)).toEqual(['answer']);
    expect(turns[1].processItems).toEqual([]);
    expect(ids(turns[1].items)).toEqual(['answer', 'empty']);
  });

  it('keeps the live turn open while earlier replies remain final', () => {
    const turns = groupMessageTurns(
      [turnUser('one'), text('answer-one'), turnUser('two'), text('progress'), turnTool('running')],
      {
        isProcessing: true,
      }
    );

    expect(ids(turns[1].finalItems)).toEqual(['answer-one']);
    expect(turns[3]).toMatchObject({ state: 'running', isRunning: true, finalItems: [] });
    expect(ids(turns[3].processItems)).toEqual(['progress', 'running']);
  });

  it('does not mistake mid-turn follow-ups for completion', () => {
    const items = [
      turnUser('first'),
      text('progress', 'turn-a'),
      turnUser('follow-up'),
      text('more-progress', 'turn-a'),
    ];
    const turns = groupMessageTurns(items, { isProcessing: true, activeTurnId: 'turn-a' });

    expect(turns.filter((turn) => turn.kind === 'turn').map((turn) => turn.isRunning)).toEqual([true, true]);
    expect(turns.filter((turn) => turn.kind === 'turn').flatMap((turn) => turn.finalItems)).toEqual([]);
    expect(ids(turns.filter((turn) => turn.kind === 'standalone').flatMap((turn) => turn.items))).toEqual([
      'first',
      'follow-up',
    ]);
  });

  it('only promotes the last display segment of a completed real turn to its answer', () => {
    const turns = groupMessageTurns(
      [turnUser('first'), text('progress', 'turn-a'), turnUser('follow-up'), text('answer', 'turn-a')],
      { isProcessing: false, getTurnState: () => 'completed' }
    );

    expect(ids(turns[1].processItems)).toEqual(['progress']);
    expect(turns[1].finalItems).toEqual([]);
    expect(ids(turns[3].finalItems)).toEqual(['answer']);
  });

  it('keeps a late tool attached to its original turn instead of the current answer', () => {
    const turns = groupMessageTurns(
      [
        turnUser('one'),
        turnTool('first-tool', 'turn-a'),
        text('first-answer', 'turn-a'),
        turnUser('two'),
        text('second-answer', 'turn-b'),
        turnTool('late-tool', 'turn-a'),
      ],
      { isProcessing: true, activeTurnId: 'turn-b', getTurnState: (id) => (id === 'turn-a' ? 'completed' : 'running') }
    );

    expect(ids(turns[1].items)).toEqual(['first-tool', 'late-tool', 'first-answer']);
    expect(ids(turns[3].items)).toEqual(['second-answer']);
    expect(ids(turns[1].finalItems)).toEqual(['first-answer']);
  });

  it.each(['ask', 'permission', 'acp_permission'])('keeps %s outside a running process', (type) => {
    const turns = groupMessageTurns([turnUser('question'), turnTool('check'), { id: 'confirmation', type }], {
      isProcessing: true,
    });

    expect(ids(turns[1].finalItems)).toEqual(['confirmation']);
    expect(ids(turns[1].processItems)).toEqual(['check']);
  });

  it('keeps an error visible and does not present progress text as a successful final answer', () => {
    const turns = groupMessageTurns(
      [
        turnUser('question'),
        text('progress'),
        turnTool('check'),
        { id: 'failure', type: 'tips', content: { type: 'error' } },
      ],
      { isProcessing: false }
    );

    expect(turns[1].state).toBe('error');
    expect(ids(turns[1].finalItems)).toEqual(['failure']);
    expect(ids(turns[1].processItems)).toEqual(['progress', 'check']);
  });

  it('does not promote a stopped or partially loaded reply to a successful final answer', () => {
    const items = [turnUser('question'), text('progress', 'turn-a')];
    const stopped = groupMessageTurns(items, { isProcessing: false, getTurnState: () => 'stopped' });
    const partial = groupMessageTurns(items, { isProcessing: false, hasMoreAfter: true });

    expect(stopped[1]).toMatchObject({ state: 'stopped', finalItems: [] });
    expect(partial[1]).toMatchObject({ state: 'incomplete', finalItems: [] });
  });

  it('does not treat cached completion as proof that an anchor window contains the final answer', () => {
    const turns = groupMessageTurns([text('progress', 'turn-a')], {
      isProcessing: false,
      hasMoreAfter: true,
      getTurnState: () => 'completed',
    });

    expect(turns[0]).toMatchObject({ state: 'incomplete', finalItems: [] });
    expect(ids(turns[0].processItems)).toEqual(['progress']);
  });

  it('keeps a partial turn open when its anchor window ends with a same-turn follow-up', () => {
    const turns = groupMessageTurns([text('progress', 'turn-a'), { ...turnUser('followup'), turn_id: 'turn-a' }], {
      isProcessing: false,
      hasMoreAfter: true,
      getTurnState: () => 'completed',
    });

    expect(turns[0]).toMatchObject({ state: 'incomplete', finalItems: [] });
  });

  it('recognizes a loaded user boundary even when later pages are missing', () => {
    const turns = groupMessageTurns([text('answer'), turnUser('next-question')], {
      isProcessing: false,
      hasMoreAfter: true,
    });

    expect(ids(turns[0].finalItems)).toEqual(['answer']);
  });

  it('keeps the previous answer visible while waiting for the next turn to emit its first message', () => {
    const turns = groupMessageTurns([turnUser('question'), text('answer'), turnUser('next-question')], {
      isProcessing: true,
      activeTurnId: 'next-turn',
    });

    expect(turns[1].isRunning).toBe(false);
    expect(ids(turns[1].finalItems)).toEqual(['answer']);
  });

  it('retains a tool-only reply without inventing a final answer from earlier progress', () => {
    const turns = groupMessageTurns([turnUser('question'), text('progress'), turnTool('last-tool')], {
      isProcessing: false,
    });

    expect(turns[1].finalItems).toEqual([]);
    expect(ids(turns[1].processItems)).toEqual(['progress', 'last-tool']);
  });

  it('keeps artifacts and teammate notifications visible independently', () => {
    const turns = groupMessageTurns(
      [
        text('answer'),
        { id: 'artifact', type: 'artifact' },
        { ...text('teammate'), content: { content: 'notice', teammateMessage: true } },
      ],
      { isProcessing: false }
    );

    expect(turns.slice(1).map((turn) => turn.kind)).toEqual(['standalone', 'standalone']);
    expect(ids(turns.flatMap((turn) => turn.finalItems))).toEqual(['answer', 'artifact', 'teammate']);
  });

  it('folds status notifications together with the rest of the process', () => {
    const items = [
      turnUser('question'),
      text('progress'),
      { id: 'status', type: 'agent_status' },
      turnTool('check'),
      text('answer'),
    ];
    const turns = groupMessageTurns(items, { isProcessing: false });

    expect(turns).toHaveLength(2);
    expect(ids(turns[1].processItems)).toEqual(['progress', 'status', 'check']);
    expect(ids(turns[1].finalItems)).toEqual(['answer']);
  });

  it('keeps every interrupted segment of a live legacy turn open', () => {
    const turns = groupMessageTurns(
      [turnUser('question'), text('progress'), { id: 'artifact', type: 'artifact' }, text('more-progress')],
      { isProcessing: true }
    );

    expect(turns.filter((turn) => turn.kind === 'turn').map((turn) => turn.isRunning)).toEqual([true, true]);
    expect(turns.filter((turn) => turn.kind === 'turn').flatMap((turn) => turn.finalItems)).toEqual([]);
  });

  it('keeps a final answer visible when a status notification arrives after it', () => {
    const turns = groupMessageTurns(
      [
        turnTool('check'),
        text('answer'),
        { id: 'status', type: 'agent_status', content: { status: 'session_active' } },
      ],
      { isProcessing: false }
    );

    expect(ids(turns[0].processItems)).toEqual(['check', 'status']);
    expect(ids(turns[0].finalItems)).toEqual(['answer']);
  });

  it('keeps an agent connection error visible outside the process', () => {
    const turns = groupMessageTurns(
      [turnTool('check'), { id: 'failure', type: 'agent_status', content: { status: 'error' } }],
      { isProcessing: false }
    );

    expect(turns[0].state).toBe('error');
    expect(ids(turns[0].processItems)).toEqual(['check']);
    expect(ids(turns[0].finalItems)).toEqual(['failure']);
  });

  it('lets authoritative idle state end a turn whose cached completion was missed', () => {
    const turns = groupMessageTurns([turnUser('question'), turnTool('check', 'turn-a'), text('answer', 'turn-a')], {
      isProcessing: false,
      getTurnState: () => 'running',
    });

    expect(turns[1]).toMatchObject({ state: 'completed', isRunning: false });
    expect(ids(turns[1].finalItems)).toEqual(['answer']);
  });

  it('preserves original source ids for collapsed search targets and resolves summary turn ownership', () => {
    const summary: TurnTimelineItem = {
      id: 'summary',
      type: 'tool_summary',
      sourceMessageIds: ['stored-tool'],
      messages: [turnTool('stored-tool', 'turn-a')],
    };
    const turns = groupMessageTurns([summary, text('answer', 'turn-a')], {
      isProcessing: false,
      resolveTurnId: (item) => item.messages?.[0]?.turn_id,
    });

    expect(turns[0].turnId).toBe('turn-a');
    expect(turns[0].sourceMessageIds).toEqual(['summary', 'stored-tool', 'answer']);
  });

  it('returns no rows for an empty timeline', () => {
    expect(groupMessageTurns([], { isProcessing: false })).toEqual([]);
  });
});
