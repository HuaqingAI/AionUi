/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ICronJob } from '@/common/adapter/ipcBridge';
import ScheduledTasksPage from '@/renderer/pages/cron/ScheduledTasksPage';

let jobs: ICronJob[] = [];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { error?: string }) => (options?.error ? `Last execution error: ${options.error}` : key),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@renderer/pages/cron/useCronJobs', () => ({
  useAllCronJobs: () => ({ jobs, loading: false, pauseJob: vi.fn(), resumeJob: vi.fn() }),
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  systemSettings: { setKeepAwake: { invoke: vi.fn() } },
}));

vi.mock('@/common/config/configService', () => ({
  configService: { get: () => false, setLocal: vi.fn() },
}));

vi.mock('@renderer/pages/conversation/hooks/useConversationAssistants', () => ({
  useConversationAssistants: () => ({ presetAssistants: [] }),
}));

vi.mock('@renderer/utils/model/agentLogo', () => ({
  useAgentLogos: () => ({}),
}));

vi.mock('@/renderer/pages/cron/ScheduledTasksPage/jobAgentMeta', () => ({
  getJobAgentMeta: () => ({ name: 'News assistant', emoji: '🤖' }),
}));

vi.mock('@/renderer/components/base/TalkToButlerButton', () => ({ default: () => null }));
vi.mock('@/renderer/components/base', () => ({ AionSearchInput: () => null }));
vi.mock('@/renderer/pages/cron/ScheduledTasksPage/CreateTaskDialog', () => ({ default: () => null }));

afterEach(cleanup);

describe('ScheduledTasksPage error details', () => {
  it.each([
    {
      status: 'error' as const,
      error: 'This token cannot access model gpt-6-sol',
      hint: 'Last execution error: This token cannot access model gpt-6-sol',
    },
    { status: 'missed' as const, error: undefined, hint: 'cron.status.error' },
  ])('keeps the page mounted when hovering a $status warning', async ({ status, error, hint }) => {
    jobs = [
      {
        id: 'daily-news',
        name: 'Daily news',
        enabled: true,
        schedule: { kind: 'cron', expr: '0 9 * * *', description: 'Daily at 9 AM' },
        target: { payload: { kind: 'message', text: 'Summarize the news' }, execution_mode: 'existing' },
        metadata: {
          conversation_id: 'news-conversation',
          agent_type: 'opencode',
          created_by: 'user',
          created_at: 0,
          updated_at: 0,
        },
        state: {
          last_status: status,
          last_error: error,
          run_count: 1,
          retry_count: 0,
          max_retries: 1,
          queue_enabled: false,
        },
      },
    ];

    render(
      <MemoryRouter>
        <ScheduledTasksPage />
      </MemoryRouter>
    );

    fireEvent.mouseEnter(screen.getByLabelText(hint));

    expect(await screen.findByRole('tooltip')).toHaveTextContent(hint);
    expect(screen.getByRole('heading', { name: 'cron.scheduledTasks' })).toBeInTheDocument();
    expect(screen.getByText('Daily news')).toBeInTheDocument();
  });
});
