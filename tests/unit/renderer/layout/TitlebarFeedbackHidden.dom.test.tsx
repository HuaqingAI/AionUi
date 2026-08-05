/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/guid', search: '', hash: '' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    team: {
      get: { invoke: vi.fn() },
    },
  },
}));

vi.mock('@/common/config/constants', () => ({
  TEAM_MODE_ENABLED: false,
}));

vi.mock('@renderer/pages/conversation/GroupedHistory/ConversationSearchPopover', () => ({
  default: ({ renderTrigger }: { renderTrigger: (params: { onClick: () => void }) => React.ReactNode }) =>
    renderTrigger({ onClick: vi.fn() }),
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => false,
  isMacOS: () => false,
}));

vi.mock('@/renderer/components/layout/WindowControls', () => ({
  default: () => null,
}));

vi.mock('@/renderer/components/layout/Titlebar/MobileConversationBrand', () => ({
  default: () => null,
}));

import Titlebar from '@/renderer/components/layout/Titlebar';

describe('Titlebar feedback entry', () => {
  it('does not render the report issue button', () => {
    render(<Titlebar workspaceAvailable={false} />);

    expect(screen.queryByLabelText('Report Issue')).not.toBeInTheDocument();
  });
});
