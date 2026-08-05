/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'login.brand') return 'HTHBuddy';
      if (key === 'login.hth.description') return 'HTHBuddy requires your HTH account before assistants can be used.';
      return key;
    },
  }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    hth: {
      authStatus: { invoke: vi.fn().mockResolvedValue({ loggedIn: false, baseUrl: '' }) },
      syncAgentConfigs: { invoke: vi.fn() },
      startLogin: { invoke: vi.fn() },
    },
  },
}));

vi.mock('@renderer/components/layout/WindowControls', () => ({
  default: () => <div data-testid='window-controls' />,
}));

import HTHLogin from '@renderer/pages/HTHLogin';

describe('HTHLogin', () => {
  it('renders the titlebar with the HTHBuddy wordmark and shared HTH logo', async () => {
    render(<HTHLogin />);

    const brand = await screen.findByTestId('hth-login-titlebar-brand');

    expect(within(brand).getByText('HTHBuddy')).toBeInTheDocument();
    expect(within(brand).getByRole('img', { name: 'HTHBuddy' })).toBeInTheDocument();
    expect(screen.getByText('HTHBuddy requires your HTH account before assistants can be used.')).toBeInTheDocument();
    expect(screen.queryByText('AionUi')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(navigate).not.toHaveBeenCalled();
    });
  });
});
