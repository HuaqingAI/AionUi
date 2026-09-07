/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addCoreAuthorization,
  HTHCoreIdentityService,
  type RegisterRequestHeadersInterceptor,
} from '@/process/services/hth/coreIdentityService';

describe('HTHCoreIdentityService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the normalized HTH email to establish and inject a Core session', async () => {
    let interceptor: Parameters<RegisterRequestHeadersInterceptor>[0] | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          getSetCookie: () => [
            'aionui-session=core-access-token; HttpOnly',
            'aionui-csrf-token=core-csrf-token; SameSite=Lax',
          ],
        },
      });
    vi.stubGlobal('fetch', fetchMock);
    const service = new HTHCoreIdentityService({
      getBackendPort: () => 64722,
      getBootstrapSecret: () => 'bootstrap-secret',
      registerRequestHeadersInterceptor: (callback) => {
        interceptor = callback;
      },
    });

    await service.establish({
      baseUrl: 'https://hth.example.test',
      token: 'hth-access-token',
      email: ' Employee@Example.Test ',
      personalApiKey: 'personal-api-key',
      personalApiKeyName: 'default',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:64722/api/auth/internal/external-users/employee%40example.test',
      expect.objectContaining({ method: 'PUT' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:64722/api/auth/internal/external-sessions',
      expect.objectContaining({ method: 'POST' })
    );
    if (!interceptor) throw new Error('Expected the Core request interceptor to be registered');
    expect(interceptor('http://127.0.0.1:64722/api/conversations', {})).toMatchObject({
      Authorization: 'Bearer core-access-token',
      Cookie: 'aionui-csrf-token=core-csrf-token',
      'x-csrf-token': 'core-csrf-token',
    });
  });

  it('leaves requests anonymous when the Core session exchange returns incomplete session data', async () => {
    let interceptor: Parameters<RegisterRequestHeadersInterceptor>[0] | undefined;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { getSetCookie: () => ['aionui-session=core-access-token; HttpOnly'] },
        })
    );
    const service = new HTHCoreIdentityService({
      getBackendPort: () => 64722,
      getBootstrapSecret: () => 'bootstrap-secret',
      registerRequestHeadersInterceptor: (callback) => {
        interceptor = callback;
      },
    });

    await expect(
      service.establish({
        baseUrl: 'https://hth.example.test',
        token: 'hth-access-token',
        email: 'employee@example.test',
        personalApiKey: 'personal-api-key',
        personalApiKeyName: 'default',
      })
    ).rejects.toThrow('AionCore session exchange returned incomplete session data');

    if (!interceptor) throw new Error('Expected the Core request interceptor to be registered');
    expect(interceptor('http://127.0.0.1:64722/api/conversations', {})).toEqual({});
  });

  it('adds the Core session only to main-process requests targeting the active Core port', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          getSetCookie: () => [
            'aionui-session=core-access-token; HttpOnly',
            'aionui-csrf-token=core-csrf-token; SameSite=Lax',
          ],
        },
      })
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new HTHCoreIdentityService({
      getBackendPort: () => 64722,
      getBootstrapSecret: () => 'bootstrap-secret',
      registerRequestHeadersInterceptor: () => undefined,
    });

    await service.establish({
      baseUrl: 'https://hth.example.test',
      token: 'hth-access-token',
      email: 'employee@example.test',
      personalApiKey: 'personal-api-key',
      personalApiKeyName: 'default',
    });
    await service.fetch('http://127.0.0.1:64722/api/assistants', { headers: { Accept: 'application/json' } });
    await service.fetch('https://hth.example.test/api/aionui/agent-configs', {
      headers: { Authorization: 'Bearer hth-access-token' },
    });

    const coreHeaders = new Headers((fetchMock.mock.calls[2][1] as RequestInit).headers);
    expect(coreHeaders.get('authorization')).toBe('Bearer core-access-token');
    expect(coreHeaders.get('x-csrf-token')).toBe('core-csrf-token');
    expect(coreHeaders.get('cookie')).toBe('aionui-csrf-token=core-csrf-token');

    const hthHeaders = new Headers((fetchMock.mock.calls[3][1] as RequestInit).headers);
    expect(hthHeaders.get('authorization')).toBe('Bearer hth-access-token');
    expect(hthHeaders.get('x-csrf-token')).toBeNull();
  });
});

describe('addCoreAuthorization', () => {
  it('does not replace authorization for another server', () => {
    const headers = { Authorization: 'Bearer another-service' };

    expect(addCoreAuthorization('http://127.0.0.1:64723/api/conversations', headers, 64722, 'core-token')).toBe(
      headers
    );
  });
});
