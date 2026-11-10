/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { autoCheck } = vi.hoisted(() => ({ autoCheck: vi.fn() }));

vi.mock('@/common', () => ({
  ipcBridge: {
    autoUpdate: { check: { invoke: autoCheck } },
  },
}));

import { runUpdateCheck } from '@/renderer/components/settings/checkForUpdatesShared';

const opts = { includePrerelease: false, fallbackVersion: '0.0.0', checkFailedLabel: 'failed' };

describe('runUpdateCheck', () => {
  beforeEach(() => {
    autoCheck.mockReset();
  });

  it('reports up to date when the main process returns no available update', async () => {
    // The main process omits updateInfo for unchanged or older feed versions.
    autoCheck.mockResolvedValue({ success: true });

    const outcome = await runUpdateCheck(opts);

    expect(outcome).toMatchObject({ kind: 'upToDate', currentVersion: opts.fallbackVersion, updateInfo: null });
    expect(autoCheck).toHaveBeenCalledWith({ includePrerelease: false });
  });

  it('returns the available version and notes through autoUpdateInfo', async () => {
    const updateInfo = { version: '2.1.55', releaseNotes: 'Release notes' };
    autoCheck.mockResolvedValue({ success: true, data: { updateInfo } });

    const outcome = await runUpdateCheck(opts);

    expect(outcome).toMatchObject({
      kind: 'available',
      autoUpdateAvailable: true,
      autoUpdateInfo: updateInfo,
      updateInfo: null,
    });
  });

  it('returns an unsuccessful check message', async () => {
    autoCheck.mockResolvedValue({ success: false, msg: 'Feed unavailable' });

    expect(await runUpdateCheck(opts)).toEqual({ kind: 'error', message: 'Feed unavailable' });
  });

  it('returns a rejected check error', async () => {
    autoCheck.mockRejectedValue(new Error('Connection failed'));

    expect(await runUpdateCheck(opts)).toEqual({ kind: 'error', message: 'Connection failed' });
  });

  it('uses the fallback error label when the response is absent', async () => {
    autoCheck.mockResolvedValue(undefined);

    expect(await runUpdateCheck(opts)).toEqual({ kind: 'error', message: opts.checkFailedLabel });
  });
});
