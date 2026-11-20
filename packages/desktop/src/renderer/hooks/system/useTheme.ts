/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import { ipcBridge } from '@/common';
import { resolveActiveTheme } from '@/common/theme/resolveTheme';
import { applyTheme, seedElectronTheme, setActiveTheme } from '@/renderer/utils/theme/applyTheme';
import { getSystemPrefersDark } from '@/renderer/utils/theme/systemAppearance';
import { startSystemThemeWatcher } from '@/renderer/utils/theme/systemThemeWatcher';
import { BUILTIN_THEMES } from '@renderer/theme/builtinThemes';
import { LIGHT_THEME_ID } from '@/common/theme/constants';
import type { Theme } from '@/common/theme/types';
import { useCallback, useEffect, useRef, useState } from 'react';

const APPEARANCE_CACHE_KEY = '__aionui_theme';

function cacheAppearance(theme: Theme): void {
  try {
    localStorage.setItem(APPEARANCE_CACHE_KEY, theme.appearance);
  } catch {
    /* noop */
  }
}

function getPersistedActiveId(): string {
  return (configService.get('theme.activeId') as string) || LIGHT_THEME_ID;
}

function readCachedTheme(): Theme {
  let activeId = LIGHT_THEME_ID;
  try {
    activeId = localStorage.getItem(APPEARANCE_CACHE_KEY) || LIGHT_THEME_ID;
  } catch {
    /* noop */
  }
  return resolveActiveTheme(activeId, BUILTIN_THEMES);
}

/**
 * Returns [resolvedActiveTheme, selectThemeById, rawActiveId]. `rawActiveId` may be the
 * `system` sentinel while the resolved theme is the Light/Dark builtin — the gallery
 * highlights cards by `rawActiveId`.
 */
const useTheme = (): [Theme | null, (activeId: string) => Promise<void>, string | null] => {
  const [active, setActive] = useState<Theme | null>(readCachedTheme);
  const [activeId, setActiveId] = useState<string | null>(null);
  const selectingTheme = useRef(false);

  useEffect(() => {
    let mounted = true;
    const restoreTheme = () => {
      if (!mounted || selectingTheme.current) return;
      const selectedId = getPersistedActiveId();
      const userThemes = configService.get('theme.userThemes') ?? [];
      const resolved = resolveActiveTheme(selectedId, [...BUILTIN_THEMES, ...userThemes], getSystemPrefersDark());
      applyTheme(resolved);
      setActive(resolved);
      setActiveId(selectedId);
      cacheAppearance(resolved);
      // Seed other Electron surfaces without writing the preference back.
      void seedElectronTheme(resolved).catch(() => {});
    };
    const offActiveId = configService.subscribe('theme.activeId', restoreTheme);
    const offUserThemes = configService.subscribe('theme.userThemes', restoreTheme);
    void configService
      .whenReady()
      .then(restoreTheme)
      .catch((error) => {
        console.error('init theme failed', error);
        if (!mounted) return;
        const fallback = readCachedTheme();
        applyTheme(fallback);
        setActive(fallback);
        setActiveId(fallback.id);
      });
    const off = ipcBridge.theme.changed.on((t: Theme) => {
      applyTheme(t);
      if (mounted) {
        setActive((prev) => (prev?.id === t.id ? prev : t));
        // Best-effort: config was persisted before the broadcast, fall back to the resolved id.
        setActiveId((configService.get('theme.activeId') as string) || t.id);
      }
      cacheAppearance(t);
    });
    const offSystemWatch = startSystemThemeWatcher();
    return () => {
      mounted = false;
      offActiveId();
      offUserThemes();
      off?.();
      offSystemWatch();
    };
  }, []);

  const select = useCallback(async (selectedId: string) => {
    // setActiveTheme publishes only after persistence succeeds. Its optimistic
    // config notification must not broadcast the selection ahead of that write.
    selectingTheme.current = true;
    try {
      const resolved = await setActiveTheme(selectedId);
      setActive(resolved);
      setActiveId(selectedId);
      cacheAppearance(resolved);
    } finally {
      selectingTheme.current = false;
    }
  }, []);

  return [active, select, activeId];
};

export default useTheme;
