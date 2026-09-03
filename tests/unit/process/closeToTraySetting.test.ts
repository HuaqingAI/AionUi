/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { httpRequestMock, processConfigMock } = vi.hoisted(() => ({
  httpRequestMock: vi.fn(),
  processConfigMock: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: httpRequestMock,
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: processConfigMock,
}));

import { readCloseToTraySetting } from '@/process/utils/closeToTraySetting';

describe('readCloseToTraySetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processConfigMock.get.mockResolvedValue(undefined);
    processConfigMock.set.mockResolvedValue(undefined);
    httpRequestMock.mockResolvedValue(undefined);
  });

  it('enables close to tray by default when no saved setting exists', async () => {
    await expect(readCloseToTraySetting()).resolves.toBe(true);
  });

  it('preserves an explicitly disabled local setting', async () => {
    processConfigMock.get.mockResolvedValue(false);

    await expect(readCloseToTraySetting()).resolves.toBe(false);
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it('keeps close to tray enabled when the backend setting cannot be read', async () => {
    httpRequestMock.mockRejectedValue(new Error('backend unavailable'));

    await expect(readCloseToTraySetting()).resolves.toBe(true);
  });

  it('keeps close to tray enabled when the local setting cannot be read', async () => {
    processConfigMock.get.mockRejectedValue(new Error('storage unavailable'));

    await expect(readCloseToTraySetting()).resolves.toBe(true);
  });
});
