/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { navigateMock, locationMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  locationMock: { pathname: '/settings/system' },
}));

vi.mock('@/common', () => ({
  ipcBridge: { hth: { logout: { invoke: vi.fn() } } },
}));

vi.mock('@/renderer/components/layout/FlexFullContainer', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/hooks/system/useExtI18n', () => ({
  useExtI18n: () => ({ resolveExtTabName: vi.fn() }),
}));

vi.mock('@/renderer/hooks/system/useExtensionSettingsTabs', () => ({
  useExtensionSettingsTabs: () => [],
}));

vi.mock('@/renderer/utils/platform', () => ({
  resolveExtensionAssetUrl: vi.fn(),
}));

vi.mock('@/renderer/utils/ui/siderTooltip', () => ({
  getSiderTooltipProps: () => ({}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'settings.groupAiCore': 'AI Core',
          'settings.groupApp': 'App',
          'settings.groupAbout': 'Other',
          'settings.agents': 'Agents',
          'settings.skills': 'Skills',
          'settings.tools': 'Tools',
          'settings.appearancePanel': 'Appearance',
          'settings.system': 'System',
          'settings.archived.title': 'Archived',
          'settings.archived.navLabel': 'Archived conversations',
          'settings.about': 'About',
          'settings.hth.logout': 'Log out',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => locationMock,
  useNavigate: () => navigateMock,
}));

vi.mock('@arco-design/web-react', () => ({
  Message: {
    useMessage: () => [{ success: vi.fn(), error: vi.fn() }, null],
  },
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@icon-park/react', () => {
  const Icon = () => <span aria-hidden='true' />;
  return {
    Computer: Icon,
    Inbox: Icon,
    Info: Icon,
    Lightning: Icon,
    LinkCloud: Icon,
    Logout: Icon,
    Puzzle: Icon,
    Robot: Icon,
    Speed: Icon,
    System: Icon,
    Toolkit: Icon,
  };
});

import SettingsSider from '@/renderer/pages/settings/components/SettingsSider';
import { getBuiltinSettingsNavItems } from '@/renderer/pages/settings/components/SettingsPageWrapper';

describe('SettingsSider archived conversations entry', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    locationMock.pathname = '/settings/system';
  });

  it('shows archived conversations in its own settings group', () => {
    render(<SettingsSider />);

    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.getByText('Archived conversations')).toBeInTheDocument();
  });

  it('opens the archived conversations page from the settings sidebar', () => {
    render(<SettingsSider />);

    fireEvent.click(document.querySelector('[data-settings-id="archived"]')!);

    expect(navigateMock).toHaveBeenCalledWith('/settings/archived', { replace: true });
  });

  it('includes archived conversations in the mobile settings navigation', () => {
    const archivedItem = getBuiltinSettingsNavItems((key) => key).find((item) => item.id === 'archived');

    expect(archivedItem).toMatchObject({
      label: 'settings.archived.navLabel',
      path: 'archived',
    });
  });
});
