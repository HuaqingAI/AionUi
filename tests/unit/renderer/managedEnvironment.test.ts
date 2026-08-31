import { describe, expect, it, vi } from 'vitest';

const { isManagedEnvironmentReadyInvokeMock } = vi.hoisted(() => ({
  isManagedEnvironmentReadyInvokeMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    systemSettings: {
      isManagedEnvironmentReady: {
        invoke: isManagedEnvironmentReadyInvokeMock,
      },
    },
  },
}));

import { assertManagedEnvironmentReady, ManagedEnvironmentNotReadyError } from '@/renderer/utils/managedEnvironment';

describe('managed environment readiness', () => {
  it('allows sending when the main process reports a ready environment', async () => {
    isManagedEnvironmentReadyInvokeMock.mockResolvedValue(true);

    await expect(assertManagedEnvironmentReady()).resolves.toBeUndefined();
  });

  it('blocks sending while the environment is still initializing', async () => {
    isManagedEnvironmentReadyInvokeMock.mockResolvedValue(false);

    await expect(assertManagedEnvironmentReady()).rejects.toBeInstanceOf(ManagedEnvironmentNotReadyError);
  });
});
