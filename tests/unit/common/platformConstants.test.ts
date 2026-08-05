/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { HTH_PLATFORM_ID, isHTHPlatform } from '@/common/utils/platformConstants';

describe('platformConstants', () => {
  describe('HTH_PLATFORM_ID', () => {
    it('is defined as "hth"', () => {
      expect(HTH_PLATFORM_ID).toBe('hth');
    });
  });

  describe('isHTHPlatform', () => {
    it('returns true for hth platform', () => {
      expect(isHTHPlatform('hth')).toBe(true);
      expect(isHTHPlatform(HTH_PLATFORM_ID)).toBe(true);
    });

    it('returns false for other platforms', () => {
      expect(isHTHPlatform('openai')).toBe(false);
      expect(isHTHPlatform('anthropic')).toBe(false);
      expect(isHTHPlatform('bedrock')).toBe(false);
      expect(isHTHPlatform('custom')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isHTHPlatform('')).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isHTHPlatform(null as any)).toBe(false);
      expect(isHTHPlatform(undefined as any)).toBe(false);
    });

    it('is case-sensitive', () => {
      expect(isHTHPlatform('HTH')).toBe(false);
      expect(isHTHPlatform('HTH')).toBe(false);
    });
  });
});
