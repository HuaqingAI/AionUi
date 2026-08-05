/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SiderFooter from '@renderer/components/layout/Sider/SiderFooter';

const ipcMocks = vi.hoisted(() => ({
  quotaSummaryInvoke: vi.fn(),
  refreshQuotaSummaryInvoke: vi.fn(),
  showQuotaPromptIfSummaryExhausted: vi.fn(),
  turnCompletedHandler: undefined as undefined | (() => void),
  turnCompletedUnsubscribe: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/common', () => {
  const hth = {
    quotaSummary: {
      invoke: ipcMocks.quotaSummaryInvoke,
    },
    refreshQuotaSummary: {
      invoke: ipcMocks.refreshQuotaSummaryInvoke,
    },
  };

  return {
    ipcBridge: {
      hth,
      conversation: {
        turnCompleted: {
          on: (handler: () => void) => {
            ipcMocks.turnCompletedHandler = handler;
            return ipcMocks.turnCompletedUnsubscribe;
          },
        },
      },
    },
  };
});

vi.mock('@renderer/pages/conversation/platforms/quotaErrorPrompt', () => ({
  showQuotaPromptIfSummaryExhausted: ipcMocks.showQuotaPromptIfSummaryExhausted,
}));

const siderTooltipProps = {
  disabled: true,
};

describe('SiderFooter quota refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMocks.turnCompletedHandler = undefined;
    ipcMocks.showQuotaPromptIfSummaryExhausted.mockResolvedValue(false);
    ipcMocks.quotaSummaryInvoke.mockResolvedValue(null);
    ipcMocks.refreshQuotaSummaryInvoke.mockResolvedValue({
      wallet: {
        remain_quota: 1,
        used_quota: 0,
      },
      subscriptions: [],
      total_available: 1,
      refreshed_at: 1800000000,
    });
  });

  it('refreshes model quota after a conversation turn completes', async () => {
    render(
      <SiderFooter
        isMobile={false}
        isSettings={false}
        collapsed={false}
        theme='light'
        siderTooltipProps={siderTooltipProps}
        onSettingsClick={vi.fn()}
        onThemeToggle={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(ipcMocks.refreshQuotaSummaryInvoke).toHaveBeenCalledTimes(1);
    });

    ipcMocks.turnCompletedHandler?.();

    await waitFor(() => {
      expect(ipcMocks.refreshQuotaSummaryInvoke).toHaveBeenCalledTimes(2);
    });
    expect(ipcMocks.showQuotaPromptIfSummaryExhausted).toHaveBeenCalledWith(expect.any(Object), expect.any(Function));
  });
});
