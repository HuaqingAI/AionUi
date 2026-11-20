import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@/common/theme/types';

const { changedOnMock, publishMock } = vi.hoisted(() => ({
  changedOnMock: vi.fn(() => vi.fn()),
  publishMock: vi.fn<(theme: Theme) => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    theme: {
      changed: { on: changedOnMock },
      setActive: { invoke: publishMock },
    },
  },
}));

vi.mock('@renderer/theme/builtinThemes', () => ({
  BUILTIN_THEMES: [
    { id: 'light', name: 'Light', appearance: 'light', builtin: true, created_at: 0, updated_at: 0 },
    { id: 'dark', name: 'Dark', appearance: 'dark', builtin: true, created_at: 0, updated_at: 0 },
  ] satisfies Theme[],
}));

import { configService } from '@/common/config/configService';
import useTheme from '@/renderer/hooks/system/useTheme';

const fetchMock = vi.fn<typeof fetch>();
const customTheme: Theme = {
  id: 'midnight',
  name: 'Midnight',
  appearance: 'dark',
  builtin: false,
  tokens: { '--primary': '#abc' },
  created_at: 0,
  updated_at: 0,
};

describe('useTheme persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configService.reset();
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.body.removeAttribute('arco-theme');
    document.getElementById('theme-tokens')?.remove();
    document.getElementById('theme-decoration')?.remove();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockReset().mockImplementation(async (_input, init) =>
      Response.json({
        success: true,
        data: init?.method === 'GET' ? { 'theme.activeId': 'light', 'theme.userThemes': [] } : null,
      })
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves the cached dark appearance when startup settings are unauthorized', async () => {
    localStorage.setItem('__aionui_theme', 'dark');
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const { result } = renderHook(() => useTheme());

    await act(async () => {
      await expect(configService.whenReady()).rejects.toThrow('(401)');
    });

    expect({
      appearance: result.current[0]?.appearance,
      html: document.documentElement.getAttribute('data-theme'),
      body: document.body.getAttribute('arco-theme'),
      cached: localStorage.getItem('__aionui_theme'),
    }).toEqual({ appearance: 'dark', html: 'dark', body: 'dark', cached: 'dark' });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['GET']);
  });

  it.each([
    { name: 'built-in dark', activeId: 'dark', userThemes: [] },
    { name: 'custom dark', activeId: customTheme.id, userThemes: [customTheme] },
  ])('restores the saved $name theme after authentication and on remount', async ({ activeId, userThemes }) => {
    localStorage.setItem('__aionui_theme', 'light');
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    fetchMock.mockResolvedValueOnce(
      Response.json({ success: true, data: { 'theme.activeId': activeId, 'theme.userThemes': userThemes } })
    );
    const { result, unmount } = renderHook(() => useTheme());

    await act(async () => {
      await expect(configService.whenReady()).rejects.toThrow('(401)');
    });
    await act(async () => {
      await configService.initialize();
    });

    expect({
      id: result.current[0]?.id,
      activeId: result.current[2],
      html: document.documentElement.getAttribute('data-theme'),
      body: document.body.getAttribute('arco-theme'),
      cached: localStorage.getItem('__aionui_theme'),
    }).toEqual({ id: activeId, activeId, html: 'dark', body: 'dark', cached: 'dark' });
    expect(publishMock.mock.calls.map(([theme]) => theme.id)).not.toContain('light');
    if (userThemes.length > 0) {
      expect(document.getElementById('theme-tokens')?.textContent).toContain('--primary: #abc');
    }

    unmount();
    const remounted = renderHook(() => useTheme());
    await waitFor(() => expect(remounted.result.current[2]).toBe(activeId));

    expect(remounted.result.current[0]?.id).toBe(activeId);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET']);
  });

  it('reapplies an active custom theme when its saved definition changes', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        success: true,
        data: { 'theme.activeId': customTheme.id, 'theme.userThemes': [customTheme] },
      })
    );
    const { result } = renderHook(() => useTheme());
    await waitFor(() => expect(result.current[0]?.id).toBe(customTheme.id));

    await act(async () => {
      await configService.set('theme.userThemes', [{ ...customTheme, appearance: 'light' }]);
    });

    expect(result.current[0]?.appearance).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(result.current[2]).toBe(customTheme.id);
  });

  it('saves a selected theme and updates it without waiting for a cross-window event', async () => {
    const { result } = renderHook(() => useTheme());
    await waitFor(() => expect(result.current[2]).toBe('light'));

    await act(async () => result.current[1]('dark'));

    expect({ id: result.current[0]?.id, activeId: result.current[2] }).toEqual({ id: 'dark', activeId: 'dark' });
    expect(localStorage.getItem('__aionui_theme')).toBe('dark');
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/settings/client'),
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ 'theme.activeId': 'dark' }) })
    );
  });

  it('rejects a selection when the preference cannot be saved', async () => {
    const { result } = renderHook(() => useTheme());
    await waitFor(() => expect(result.current[2]).toBe('light'));
    publishMock.mockClear();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'save failed' }, { status: 500 }));

    await expect(act(async () => result.current[1]('dark'))).rejects.toThrow('save failed');

    expect(result.current[0]?.appearance).toBe('light');
    expect(publishMock).not.toHaveBeenCalled();
  });
});
