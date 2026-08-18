import { describe, expect, it, vi } from 'vitest';
import { getDevAppName } from '@/common/platform';

describe('development data directory naming', () => {
  it('uses an English directory name while keeping multi-instance isolation', () => {
    vi.stubEnv('AIONUI_MULTI_INSTANCE', '');
    expect(getDevAppName()).toBe('HQBuddy-Dev');

    vi.stubEnv('AIONUI_MULTI_INSTANCE', '1');
    expect(getDevAppName()).toBe('HQBuddy-Dev-2');
  });
});
