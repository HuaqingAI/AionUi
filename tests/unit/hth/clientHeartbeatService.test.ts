/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
  },
}));

import type { HTHAuthService } from '@/process/services/hth/authService';
import { HTHClientHeartbeatService } from '@/process/services/hth/clientHeartbeatService';
import {
  resolveAionUiClientPlatform,
  resolveMacInstallationId,
  resolvePreferredLanIPv4,
  shouldRunClientHeartbeat,
} from '@/process/services/hth/clientEnvironment';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('HTH client heartbeat', () => {
  it('reports the authenticated user snapshot and the selected LAN IPv4', async () => {
    const getStatus = vi.fn(async () => ({ loggedIn: true }));
    const getAccess = vi.fn(async () => ({
      baseUrl: 'https://api.example.com/',
      token: 'desktop-token',
      email: 'alice@example.com',
      displayName: 'Alice',
      departments: ['Engineering'],
      personalApiKey: 'personal-key',
      personalApiKeyName: 'personal-key',
    }));
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const service = new HTHClientHeartbeatService({ getStatus, getAccess } as unknown as HTHAuthService, {
      appVersion: () => '1.2.3',
      fetch: fetchMock as unknown as typeof fetch,
      resolvePlatform: () => 'mac_arm64',
      resolveLanIP: () => '192.168.1.20',
    });

    service.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    service.stop();

    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://api.example.com/api/aionui/clients/heartbeat');
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer desktop-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(request.body as string)).toEqual({
      client_version: '1.2.3',
      platform: 'mac_arm64',
      lan_ip: '192.168.1.20',
      user: {
        email: 'alice@example.com',
        name: 'Alice',
        departments: ['Engineering'],
      },
    });
  });

  it('does not send a heartbeat without a current desktop login', async () => {
    const fetchMock = vi.fn();
    const service = new HTHClientHeartbeatService(
      { getStatus: async () => ({ loggedIn: false }) } as unknown as HTHAuthService,
      { fetch: fetchMock as unknown as typeof fetch }
    );

    service.start();
    await Promise.resolve();
    await Promise.resolve();
    service.stop();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the server-provided interval before the next successful heartbeat', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { next_heartbeat_seconds: 120 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const service = new HTHClientHeartbeatService(
      {
        getStatus: async () => ({ loggedIn: true }),
        getAccess: async () => ({
          baseUrl: 'https://api.example.com/',
          token: 'desktop-token',
          email: 'alice@example.com',
          personalApiKey: 'personal-key',
          personalApiKeyName: 'personal-key',
        }),
      } as unknown as HTHAuthService,
      { fetch: fetchMock as unknown as typeof fetch }
    );

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it('selects the first RFC1918 IPv4 and excludes non-desktop runtimes', () => {
    expect(
      resolvePreferredLanIPv4({
        loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true, mac: '', netmask: '', cidr: null }],
        ethernet: [{ address: '192.168.20.8', family: 'IPv4', internal: false, mac: '', netmask: '', cidr: null }],
        vpn: [{ address: '10.0.0.2', family: 'IPv4', internal: false, mac: '', netmask: '', cidr: null }],
      })
    ).toBe('192.168.20.8');
    expect(resolveAionUiClientPlatform('darwin', 'arm64')).toBe('mac_arm64');
    expect(resolveAionUiClientPlatform('linux', 'x64')).toBeNull();
    expect(shouldRunClientHeartbeat(['app', '--webui'])).toBe(false);
    expect(shouldRunClientHeartbeat(['app', '--version'])).toBe(false);
  });

  it('derives the same installation identifier from the same adapter set', () => {
    const networks = {
      ethernet: [
        { address: '192.168.20.8', family: 'IPv4', internal: false, mac: 'AA-BB-CC-DD-EE-FF', netmask: '', cidr: null },
      ],
      loopback: [
        { address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00', netmask: '', cidr: null },
      ],
    };
    const reorderedNetworks = {
      loopback: networks.loopback,
      ethernet: [{ ...networks.ethernet[0], mac: 'aa:bb:cc:dd:ee:ff' }],
    };
    expect(resolveMacInstallationId(networks, 'https://api.example.com')).toBe(
      resolveMacInstallationId(reorderedNetworks, 'https://api.example.com')
    );
    expect(resolveMacInstallationId(networks, 'https://other.example.com')).not.toBe(
      resolveMacInstallationId(networks, 'https://api.example.com')
    );
    expect(resolveMacInstallationId(networks, 'https://api.example.com')).toMatch(/^mac_[0-9a-f]{64}$/);
  });
});
