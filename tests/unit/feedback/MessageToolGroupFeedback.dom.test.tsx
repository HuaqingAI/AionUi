/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Verifies failed tool calls keep their error content while hiding their
 * Butler diagnosis and feedback actions.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

// Stub heavy dependencies that MessageToolGroup pulls in so this test can
// render in pure jsdom without the whole app tree.
vi.mock('@renderer/components/chat/CollapsibleContent', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@renderer/components/Markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@renderer/components/media/LocalImageView', () => ({
  default: () => null,
}));
vi.mock('@/renderer/components/base/FileChangesPanel', () => ({
  default: () => null,
}));
vi.mock('@/renderer/hooks/file/useDiffPreviewHandlers', () => ({
  useDiffPreviewHandlers: () => ({ openDiff: () => {}, openFile: () => {} }),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: { respondToConfirmation: { invoke: vi.fn() } },
    conversation: { respondToConfirmation: { invoke: vi.fn() } },
  },
}));

import MessageToolGroup from '@/renderer/pages/conversation/Messages/components/MessageToolGroup';
import type { IMessageToolGroup } from '@/common/chat/chatLib';

const buildToolGroup = (status: IMessageToolGroup['content'][number]['status']): IMessageToolGroup =>
  ({
    id: 'tg-1',
    type: 'tool_group',
    content: [
      {
        call_id: 'c1',
        description: 'ran something',
        name: 'Read',
        render_output_as_markdown: false,
        status,
        result_display: 'ENOENT: no such file',
      },
    ],
  }) as IMessageToolGroup;

describe('MessageToolGroup error actions', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not render FeedbackButton on successful tool calls', () => {
    render(<MessageToolGroup message={buildToolGroup('Success')} />);
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
  });

  it('does not render FeedbackButton on canceled tool calls', () => {
    render(<MessageToolGroup message={buildToolGroup('Canceled')} />);
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
  });

  it('hides the Butler diagnosis and feedback actions when status=Error', () => {
    render(<MessageToolGroup message={buildToolGroup('Error')} />);
    expect(screen.getByText('ENOENT: no such file')).toBeInTheDocument();
    expect(screen.queryByText('settings.talkToButler.solveWithButler')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
  });
});
