import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  getAppFilesystemName,
  getAppUserModelId,
  getDevAppName,
  getWindowsDevelopmentShortcutPath,
} from '@/common/platform';

describe('development data directory naming', () => {
  it('uses an English directory name while keeping multi-instance isolation', () => {
    vi.stubEnv('AIONUI_MULTI_INSTANCE', '');
    expect(getDevAppName()).toBe('HQBuddy-Dev');

    vi.stubEnv('AIONUI_MULTI_INSTANCE', '1');
    expect(getDevAppName()).toBe('HQBuddy-Dev-2');
  });

  it('uses the packaged executable name to separate production and packaged dev data', () => {
    expect(getAppFilesystemName(true, '/Applications/HQBuddy.app/Contents/MacOS/HQBuddy')).toBe('HQBuddy');
    expect(getAppFilesystemName(true, '/Applications/HQBuddy-Dev.app/Contents/MacOS/HQBuddy-Dev')).toBe('HQBuddy-Dev');
    expect(getAppFilesystemName(true, 'C:\\Program Files\\HQBuddy.exe')).toBe('HQBuddy');
    expect(getAppFilesystemName(true, 'C:\\Program Files\\HQBuddy-Dev.exe')).toBe('HQBuddy-Dev');
  });

  it('uses distinct Windows identities for production and development builds', () => {
    expect(getAppUserModelId(true, 'C:\\Program Files\\HQBuddy.exe')).toBe('com.hqbuddy.app');
    expect(getAppUserModelId(true, 'C:\\Program Files\\HQBuddy-Dev.exe')).toBe('com.hqbuddy.app.dev');
    expect(getAppUserModelId(false)).toBe('com.hqbuddy.app.dev');
  });

  it('registers the development notification identity under a Chinese Start Menu shortcut', () => {
    expect(getWindowsDevelopmentShortcutPath('C:\\Users\\huaqi\\AppData\\Roaming')).toBe(
      path.join(
        'C:\\Users\\huaqi\\AppData\\Roaming',
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'HQBuddy-Dev',
        '华青智能助手.lnk'
      )
    );
  });
});
