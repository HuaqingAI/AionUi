/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ isDesktop: true, isMac: false }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'login.brand') return '华青智能助手';
      if (key === 'login.hth.description') return '华青智能助手 requires your HTH account before assistants can be used.';
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

vi.mock('@renderer/utils/platform', () => ({
  isElectronDesktop: () => platform.isDesktop,
  isMacOS: () => platform.isMac,
}));

import HTHLogin from '@renderer/pages/HTHLogin';

describe('HTHLogin', () => {
  afterEach(() => {
    platform.isDesktop = true;
    platform.isMac = false;
  });

  it('renders the titlebar with the 华青智能助手 wordmark and shared HTH logo', async () => {
    render(<HTHLogin />);

    const brand = await screen.findByTestId('hth-login-titlebar-brand');

    expect(within(brand).getByText('华青智能助手')).toBeInTheDocument();
    expect(within(brand).getByRole('img', { name: '华青智能助手' })).toBeInTheDocument();
    expect(screen.getByText('华青智能助手 requires your HTH account before assistants can be used.')).toBeInTheDocument();
    expect(screen.queryByText('AionUi')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  it('renders custom window controls on Windows and Linux desktop runtimes', async () => {
    render(<HTHLogin />);

    expect(await screen.findByTestId('window-controls')).toBeInTheDocument();
  });

  it('uses the macOS titlebar layout without custom window controls', async () => {
    platform.isMac = true;
    const { container } = render(<HTHLogin />);

    await screen.findByTestId('hth-login-titlebar-brand');

    expect(container.querySelector('[class*="loginTitlebarMac"]')).toBeInTheDocument();
    expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument();
  });
});
