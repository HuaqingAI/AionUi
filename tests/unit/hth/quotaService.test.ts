/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTHQuotaService } from '@/process/services/hth/quotaService';
import type { HTHAuthService } from '@/process/services/hth/authService';

describe('HTHQuotaService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null until quota summary is refreshed', async () => {
    const service = new HTHQuotaService(mockAuthService());

    await expect(service.getSummary()).resolves.toBeNull();
  });

  it('fetches quota summary with hth access and caches it', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            wallet: { remain_quota: 10, used_quota: 2, display: '10' },
            subscriptions: [
              {
                group_key: 'enterprise',
                group_name: 'Enterprise',
                amount_total: 100,
                amount_used: 30,
                amount_available: 70,
                amount_available_display: '$0.000140',
                items: [],
              },
              {
                group_key: 'personal',
                group_name: 'Personal',
                amount_total: 20,
                amount_used: 5,
                amount_available: 15,
                amount_available_display: '$0.000030',
                items: [],
              },
            ],
            total_available: 95,
            total_available_display: '$0.000190',
            quota_apply_url: 'https://quota.example.com/apply',
            refreshed_at: 1,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new HTHQuotaService(mockAuthService());

    await expect(service.refreshSummary()).resolves.toMatchObject({
      total_available: 95,
      total_available_display: '$0.000190',
      quota_apply_url: 'https://quota.example.com/apply',
    });
    await expect(service.getSummary()).resolves.toMatchObject({ total_available: 95 });
    expect(fetchMock).toHaveBeenCalledWith(new URL('http://127.0.0.1:3001/api/aionui/quota-summary'), {
      method: 'GET',
      headers: { Authorization: 'Bearer token-1' },
    });
  });

  it('throws the server error message when refresh fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(JSON.stringify({ success: false, error: 'quota unavailable' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    const service = new HTHQuotaService(mockAuthService());

    await expect(service.refreshSummary()).rejects.toThrow('quota unavailable');
  });
});

function mockAuthService(): HTHAuthService {
  return {
    getAccess: vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:3001',
      token: 'token-1',
      email: 'user@example.com',
      personalApiKey: 'sk-personal-1',
    })),
  } as unknown as HTHAuthService;
}
