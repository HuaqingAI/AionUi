/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  getVersion: vi.fn(() => '0.0.0-test'),
  isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  openExternal: vi.fn(() => Promise.resolve()),
}));

vi.mock('electron', () => ({
  app: {
    getPath: electronMocks.getPath,
    getVersion: electronMocks.getVersion,
  },
  safeStorage: {
    isEncryptionAvailable: electronMocks.isEncryptionAvailable,
    encryptString: electronMocks.encryptString,
    decryptString: electronMocks.decryptString,
  },
  shell: {
    openExternal: electronMocks.openExternal,
  },
}));

import { HTHAuthService } from '@/process/services/hth/authService';

type LoopbackResponse = {
  statusCode: number;
  body: string;
};

const requestLoopback = (url: string): Promise<LoopbackResponse> =>
  new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.on('error', reject);
  });

describe('HTHAuthService loopback callback', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui-hth-auth-'));
    electronMocks.getPath.mockReturnValue(tempDir);
    electronMocks.openExternal.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              access_token: 'token-1',
              email: 'user@example.com',
              personal_api_key: {
                name: 'hth-default-apikey',
                key: 'sk-personal-1',
                masked_key: 'sk-***-1',
              },
              quota_apply_url: 'https://quota.example.com/apply',
              user: {
                username: 'alice',
                display_name: '张三',
                departments: ['研发部'],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  it('notifies the app to show itself after a successful loopback login', async () => {
    const onLoginComplete = vi.fn();
    const authFile = path.join(tempDir, 'hth', 'auth.json');
    const service = new HTHAuthService(authFile, { onLoginComplete });

    const login = await service.startLogin({ baseUrl: 'http://127.0.0.1:3001' });
    const loginUrl = new URL(login.loginUrl);
    const redirectUri = loginUrl.searchParams.get('redirect_uri');
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hth\/callback$/);

    const callbackUrl = new URL(redirectUri ?? '');
    callbackUrl.searchParams.set('code', 'code-1');
    callbackUrl.searchParams.set('state', login.state);
    const response = await requestLoopback(callbackUrl.toString());

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<title>HTHBuddy</title>');
    expect(response.body).toContain('HTHBuddy 已完成登录授权。');
    expect(response.body).toContain('返回 HTHBuddy。');
    expect(response.body).not.toContain('AionUi');
    expect(onLoginComplete).toHaveBeenCalledTimes(1);
    await expect(service.getStatus()).resolves.toMatchObject({
      loggedIn: true,
      email: 'user@example.com',
      displayName: '张三',
      username: 'alice',
      departments: ['研发部'],
    });
  });

  it('does not notify the app when the loopback state is invalid', async () => {
    const onLoginComplete = vi.fn();
    const authFile = path.join(tempDir, 'hth', 'auth.json');
    const service = new HTHAuthService(authFile, { onLoginComplete });

    const login = await service.startLogin({ baseUrl: 'http://127.0.0.1:3001' });
    const loginUrl = new URL(login.loginUrl);
    const callbackUrl = new URL(loginUrl.searchParams.get('redirect_uri') ?? '');
    callbackUrl.searchParams.set('code', 'code-1');
    callbackUrl.searchParams.set('state', 'wrong-state');
    const response = await requestLoopback(callbackUrl.toString());

    expect(response.statusCode).toBe(400);
    expect(onLoginComplete).not.toHaveBeenCalled();
    await service.logout();
  });
});
