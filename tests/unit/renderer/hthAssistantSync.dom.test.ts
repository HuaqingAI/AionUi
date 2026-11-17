import type { HTHSyncProgressEvent, HTHSyncResult } from '@/common/types/hth';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  mutate: vi.fn().mockResolvedValue(undefined),
  navigate: vi.fn(),
  exchange: vi.fn(),
  progress: null as ((event: HTHSyncProgressEvent) => void) | null,
  deepLink: null as ((event: { action: string; params: Record<string, string> }) => void) | null,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    hth: {
      syncAgentConfigs: { invoke: mocks.sync },
      exchangeLoginCode: { invoke: mocks.exchange },
      syncAgentConfigsProgress: {
        on: (listener: (event: HTHSyncProgressEvent) => void) => {
          mocks.progress = listener;
          return () => {
            mocks.progress = null;
          };
        },
      },
    },
    deepLink: {
      received: {
        on: (listener: NonNullable<typeof mocks.deepLink>) => {
          mocks.deepLink = listener;
          return () => {
            mocks.deepLink = null;
          };
        },
      },
    },
  },
}));
vi.mock('swr', () => ({ mutate: mocks.mutate }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@arco-design/web-react', () => ({ Message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const status = { loggedIn: true, baseUrl: 'https://gateway.test', email: 'user@test', lastLoginAt: 1 };
const result: HTHSyncResult = { success: true, imported: 1, skipped: 0, failed: 0, packages: [] };

beforeEach(() => {
  vi.resetModules();
  mocks.sync.mockReset().mockResolvedValue(result);
  mocks.mutate.mockClear();
  mocks.navigate.mockClear();
  mocks.exchange.mockReset().mockResolvedValue(status);
  mocks.progress = null;
  mocks.deepLink = null;
});

describe('HTH assistant synchronization during startup and login', () => {
  it('invalidates old account update hints and revalidates when the account changes', async () => {
    const { setHTHAssistantSyncScope } = await import('@/renderer/services/runtime/hthAssistantSync');
    setHTHAssistantSyncScope(status);
    expect(mocks.mutate).toHaveBeenCalledWith('hth.assistantUpdates', undefined, { revalidate: true });
    mocks.mutate.mockClear();
    setHTHAssistantSyncScope(status);
    expect(mocks.mutate).not.toHaveBeenCalled();
    setHTHAssistantSyncScope({ ...status, email: 'other@test' });
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });

  it('starts incrementally without waiting and only once per account across navigation', async () => {
    const { startHTHAssistantBackgroundSync } = await import('@/renderer/services/runtime/hthAssistantSync');
    let finish!: (value: HTHSyncResult) => void;
    mocks.sync.mockReturnValue(
      new Promise<HTHSyncResult>((resolve) => {
        finish = resolve;
      })
    );

    expect(startHTHAssistantBackgroundSync(status)).toBeUndefined();
    startHTHAssistantBackgroundSync(status);
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledExactlyOnceWith({ incremental: true, background: true }));
    expect(mocks.mutate).not.toHaveBeenCalled();
    finish(result);
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('assistants.list'));
    startHTHAssistantBackgroundSync(status);
    expect(mocks.sync).toHaveBeenCalledOnce();
  });

  it('contains background errors without navigating or retrying on every route', async () => {
    const { startHTHAssistantBackgroundSync } = await import('@/renderer/services/runtime/hthAssistantSync');
    mocks.sync.mockRejectedValue(new Error('Network unavailable'));
    startHTHAssistantBackgroundSync(status);
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith('hth.assistantUpdates'));
    startHTHAssistantBackgroundSync(status);
    expect(mocks.sync).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('does not run before authentication and runs independently for another account', async () => {
    const { startHTHAssistantBackgroundSync } = await import('@/renderer/services/runtime/hthAssistantSync');
    startHTHAssistantBackgroundSync({ loggedIn: false });
    expect(mocks.sync).not.toHaveBeenCalled();
    startHTHAssistantBackgroundSync(status);
    startHTHAssistantBackgroundSync({ ...status, email: 'other@test' });
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
  });

  it('shares one forced login sync and filters its progress events by sync id', async () => {
    const service = await import('@/renderer/services/runtime/hthAssistantSync');
    let finish!: (value: HTHSyncResult) => void;
    mocks.sync.mockReturnValue(
      new Promise<HTHSyncResult>((resolve) => {
        finish = resolve;
      })
    );
    const first = service.syncHTHAssistantsAfterLogin(status);
    expect(service.syncHTHAssistantsAfterLogin(status)).toBe(first);
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledOnce());
    const syncId = service.getHTHLoginSyncProgress()!.syncId;
    const progress: HTHSyncProgressEvent = {
      syncId,
      stage: 'syncing_assistants',
      total: 2,
      completed: 1,
      synced: 1,
      failed: 0,
    };
    mocks.progress?.({ ...progress, syncId: 'unrelated' });
    expect(service.getHTHLoginSyncProgress()!.stage).toBe('preparing');
    mocks.progress?.(progress);
    expect(service.getHTHLoginSyncProgress()).toEqual(progress);
    finish(result);
    await first;
    expect(service.getHTHLoginSyncProgress()).toBeNull();
    service.startHTHAssistantBackgroundSync(status);
    expect(mocks.sync).toHaveBeenCalledOnce();
  });

  it('clears the login overlay after failure and rejects unauthenticated callers', async () => {
    const service = await import('@/renderer/services/runtime/hthAssistantSync');
    await expect(service.syncHTHAssistantsAfterLogin({ loggedIn: false })).rejects.toThrow('HTH login is required');
    expect(mocks.sync).not.toHaveBeenCalled();
    mocks.sync.mockRejectedValue(new Error('Sync failed'));
    await expect(service.syncHTHAssistantsAfterLogin(status)).rejects.toThrow('Sync failed');
    expect(service.getHTHLoginSyncProgress()).toBeNull();
    expect(mocks.progress).toBeNull();
  });

  it('shows the same login progress for protocol callbacks and waits before navigating', async () => {
    const service = await import('@/renderer/services/runtime/hthAssistantSync');
    const { useDeepLink } = await import('@/renderer/hooks/system/useDeepLink');
    let finish!: (value: HTHSyncResult) => void;
    mocks.sync.mockReturnValue(
      new Promise<HTHSyncResult>((resolve) => {
        finish = resolve;
      })
    );
    renderHook(() => useDeepLink());
    act(() =>
      mocks.deepLink?.({ action: 'auth/hth-callback', params: { code: 'one-time-code', state: 'login-state' } })
    );
    await waitFor(() => expect(service.getHTHLoginSyncProgress()).not.toBeNull());
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () => finish(result));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/guid', { replace: true }));
  });

  it('does not synchronize or enter the main page after a rejected login callback', async () => {
    const { useDeepLink } = await import('@/renderer/hooks/system/useDeepLink');
    mocks.exchange.mockRejectedValue(new Error('Invalid or expired login state'));
    renderHook(() => useDeepLink());
    act(() =>
      mocks.deepLink?.({ action: 'auth/hth-callback', params: { code: 'expired-code', state: 'expired-state' } })
    );
    await waitFor(() => expect(mocks.exchange).toHaveBeenCalledOnce());
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
