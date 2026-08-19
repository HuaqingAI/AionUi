import { describe, expect, it, vi } from 'vitest';
import { getAppFilesystemName, getDevAppName } from '@/common/platform';

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
});
