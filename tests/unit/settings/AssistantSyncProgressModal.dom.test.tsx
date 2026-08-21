/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import AssistantSyncProgressModal from '@/renderer/pages/settings/AssistantSettings/home/AssistantSyncProgressModal';
import { ConfigProvider } from '@arco-design/web-react';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (typeof options?.defaultValue !== 'string') return key;
      return options.defaultValue.replace(/\{\{(\w+)\}\}/g, (_match, optionKey: string) =>
        String(options[optionKey] ?? '')
      );
    },
  }),
}));

describe('AssistantSyncProgressModal', () => {
  it('shows total, completed syncs, failures, and the active assistant', () => {
    render(
      <ConfigProvider>
        <AssistantSyncProgressModal
          visible
          progress={{
            syncId: 'manual-sync-1',
            stage: 'syncing_assistants',
            total: 12,
            completed: 8,
            synced: 7,
            failed: 1,
            currentAssistant: { id: 'assistant-sales', name: 'Sales Analysis Assistant' },
          }}
        />
      </ConfigProvider>
    );

    expect(screen.getByTestId('assistant-sync-progress-modal')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-sync-progress-total')).toHaveTextContent('12');
    expect(screen.getByTestId('assistant-sync-progress-synced')).toHaveTextContent('7');
    expect(screen.getByTestId('assistant-sync-progress-failed')).toHaveTextContent('1');
    expect(screen.getByTestId('assistant-sync-progress-current')).toHaveTextContent('Sales Analysis Assistant');
    expect(screen.getByTestId('assistant-sync-progress-processed')).toHaveTextContent('Processed 8 / 12');
  });

  it('keeps the progress meter hidden while the assistant list is being fetched', () => {
    render(
      <ConfigProvider>
        <AssistantSyncProgressModal
          visible
          progress={{
            stage: 'preparing',
            total: 0,
            completed: 0,
            synced: 0,
            failed: 0,
          }}
        />
      </ConfigProvider>
    );

    expect(screen.queryByTestId('assistant-sync-progress-processed')).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-sync-progress-current')).toHaveTextContent('Preparing synchronization');
  });
});
