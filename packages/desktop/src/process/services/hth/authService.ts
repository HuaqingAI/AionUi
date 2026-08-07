/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HTHAuthStatus,
  HTHExchangeLoginCodeRequest,
  HTHStartLoginRequest,
  HTHStartLoginResult,
} from '@/common/types/hth';
import { app, safeStorage, shell } from 'electron';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { randomUUID } from 'crypto';
import { getHTHAuthFilePath, normalizeHTHBaseUrl, resolveDefaultHTHBaseUrl } from './baseUrl';

type StoredAuth = {
  baseUrl: string;
  accessToken: string;
  personalApiKey?: string;
  personalApiKeyName?: string;
  personalApiKeyMasked?: string;
  quotaApplyUrl?: string;
  encrypted: boolean;
  email: string;
  expiresAt?: number;
  userId?: number;
  username?: string;
  displayName?: string;
  departments?: string[];
  deviceId: string;
  lastLoginAt: number;
};

type PendingLogin = {
  state: string;
  baseUrl: string;
  createdAt: number;
  closeCallbackServer?: () => void;
};

type HTHAuthServiceOptions = {
  onLoginComplete?: () => void;
};

type TokenResponse = {
  access_token?: string;
  token?: string;
  expires_at?: number;
  expiresAt?: number;
  email?: string;
  user_email?: string;
  user_id?: number;
  username?: string;
  departments?: string[];
  user?: {
    id?: number;
    username?: string;
    email?: string;
    display_name?: string;
    departments?: string[];
  };
  personal_api_key?: {
    name?: string;
    key?: string;
    masked_key?: string;
  };
  quota_apply_url?: string;
};

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: string;
  msg?: string;
};

const REDIRECT_URI = 'aionui://auth/hth-callback';
const LOOPBACK_CALLBACK_PATH = '/hth/callback';
const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class HTHAuthService {
  private pendingLogin: PendingLogin | null = null;
  private readonly authFile: string;
  private readonly onLoginComplete?: () => void;

  constructor(authFile = getHTHAuthFilePath(), options: HTHAuthServiceOptions = {}) {
    this.authFile = authFile;
    this.onLoginComplete = options.onLoginComplete;
  }

  async getStatus(): Promise<HTHAuthStatus> {
    const auth = await this.readAuth();
    if (!auth) {
      return { loggedIn: false, baseUrl: this.resolveBaseUrl() };
    }
    if (this.isExpired(auth)) {
      return { loggedIn: false, baseUrl: auth.baseUrl, email: auth.email, expiresAt: auth.expiresAt };
    }
    return {
      loggedIn: true,
      baseUrl: auth.baseUrl,
      email: auth.email,
      displayName: auth.displayName,
      username: auth.username,
      departments: auth.departments,
      personalApiKey: auth.personalApiKey
        ? {
            name: auth.personalApiKeyName || 'hth-default-apikey',
            maskedKey: auth.personalApiKeyMasked,
          }
        : undefined,
      quotaApplyUrl: auth.quotaApplyUrl,
      expiresAt: auth.expiresAt,
      lastLoginAt: auth.lastLoginAt,
    };
  }

  async getAccess(): Promise<{
    baseUrl: string;
    token: string;
    email: string;
    displayName?: string;
    username?: string;
    departments?: string[];
    personalApiKey: string;
    quotaApplyUrl?: string;
  }> {
    const auth = await this.readAuth();
    if (!auth || this.isExpired(auth)) {
      throw new Error('hth login required');
    }
    const personalApiKey = this.decryptValue(auth.personalApiKey, auth.encrypted);
    if (!personalApiKey) {
      throw new Error('hth login required');
    }
    return {
      baseUrl: auth.baseUrl,
      token: this.decryptToken(auth),
      email: auth.email,
      displayName: auth.displayName,
      username: auth.username,
      departments: auth.departments,
      personalApiKey,
      quotaApplyUrl: auth.quotaApplyUrl,
    };
  }

  async startLogin(request: HTHStartLoginRequest): Promise<HTHStartLoginResult> {
    const baseUrl = this.normalizeBaseUrl(request.baseUrl || this.resolveBaseUrl());
    const state = randomUUID();
    this.closePendingCallbackServer();
    this.pendingLogin = {
      state,
      baseUrl,
      createdAt: Date.now(),
    };
    const redirectUri = await this.createLoopbackRedirectUri().catch((error) => {
      console.warn('[HTHAuth] Failed to start loopback callback server, falling back to protocol callback:', error);
      return REDIRECT_URI;
    });

    const loginUrl = new URL('/api/aionui/desktop/login', baseUrl);
    loginUrl.searchParams.set('redirect_uri', redirectUri);
    loginUrl.searchParams.set('state', state);
    await shell.openExternal(loginUrl.toString());
    return { state, loginUrl: loginUrl.toString() };
  }

  async exchangeLoginCode(request: HTHExchangeLoginCodeRequest): Promise<HTHAuthStatus> {
    const pending = this.pendingLogin;
    if (!pending || pending.state !== request.state || Date.now() - pending.createdAt > LOGIN_STATE_TTL_MS) {
      throw new Error('Invalid or expired hth login state');
    }
    if (!request.code.trim()) {
      throw new Error('Missing hth login code');
    }

    const currentAuth = await this.readAuth();
    const deviceId = currentAuth?.deviceId || randomUUID();
    const tokenUrl = new URL('/api/aionui/desktop/token', pending.baseUrl);
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: request.code,
        device_id: deviceId,
        app_version: app.getVersion(),
      }),
    });
    const token = await this.parseTokenResponse(response);
    const accessToken = token.access_token || token.token;
    const personalApiKey = token.personal_api_key?.key?.trim();
    const email = token.email || token.user_email || token.user?.email;
    if (!accessToken || !email || !personalApiKey) {
      throw new Error('hth token response is missing access token, email, or personal api key');
    }

    const auth: StoredAuth = {
      baseUrl: pending.baseUrl,
      accessToken: this.encryptToken(accessToken),
      personalApiKey: this.encryptToken(personalApiKey),
      personalApiKeyName: token.personal_api_key?.name,
      personalApiKeyMasked: token.personal_api_key?.masked_key,
      quotaApplyUrl: token.quota_apply_url,
      encrypted: this.canEncrypt(),
      email,
      expiresAt: this.normalizeExpiresAt(token.expires_at || token.expiresAt),
      userId: token.user_id || token.user?.id,
      username: token.username || token.user?.username,
      displayName: token.user?.display_name,
      departments: this.normalizeDepartments(token.user?.departments || token.departments),
      deviceId,
      lastLoginAt: Date.now(),
    };
    await this.writeAuth(auth);
    this.closePendingCallbackServer();
    return this.getStatus();
  }

  async logout(): Promise<HTHAuthStatus> {
    this.closePendingCallbackServer();
    await fs.rm(this.authFile, { force: true });
    return { loggedIn: false, baseUrl: this.resolveBaseUrl() };
  }

  private createLoopbackRedirectUri(): Promise<string> {
    const pending = this.pendingLogin;
    if (!pending) {
      throw new Error('Missing pending hth login');
    }

    return new Promise<string>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== LOOPBACK_CALLBACK_PATH) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Not found');
          return;
        }

        const callbackError = requestUrl.searchParams.get('error') || requestUrl.searchParams.get('message');
        if (callbackError) {
          console.error('[HTHAuth] Loopback callback returned error:', callbackError);
          response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(this.renderLoopbackPage('登录失败', callbackError));
          return;
        }

        const code = requestUrl.searchParams.get('code') || '';
        const state = requestUrl.searchParams.get('state') || '';
        void this.exchangeLoginCode({ code, state })
          .then(() => {
            this.notifyLoginComplete();
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(this.renderLoopbackPage('登录成功', 'HTHBuddy 已完成登录授权。', 10));
          })
          .catch((error) => {
            console.error('[HTHAuth] Loopback callback failed:', error);
            response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(
              this.renderLoopbackPage('登录失败', error instanceof Error ? error.message : '请返回 HTHBuddy 后重试。')
            );
          });
      });

      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Unable to resolve loopback callback port'));
          return;
        }
        pending.closeCallbackServer = () => {
          server.close((error) => {
            if (error) {
              console.warn('[HTHAuth] Failed to close loopback callback server:', error);
            }
          });
        };
        server.off('error', reject);
        resolve(`http://127.0.0.1:${address.port}${LOOPBACK_CALLBACK_PATH}`);
      });
    });
  }

  private notifyLoginComplete(): void {
    try {
      this.onLoginComplete?.();
    } catch (error) {
      console.warn('[HTHAuth] Login completion callback failed:', error);
    }
  }

  private closePendingCallbackServer(): void {
    const pending = this.pendingLogin;
    this.pendingLogin = null;
    pending?.closeCallbackServer?.();
  }

  private renderLoopbackPage(title: string, message: string, autoCloseSeconds?: number): string {
    const countdownText =
      typeof autoCloseSeconds === 'number'
        ? `<p class="countdown"><span id="countdown">${autoCloseSeconds}</span> 秒后将自动关闭当前页面。</p>`
        : '';
    const closeScript =
      typeof autoCloseSeconds === 'number'
        ? `<script>
let remaining = ${autoCloseSeconds};
const countdown = document.getElementById('countdown');
const timer = window.setInterval(() => {
  remaining -= 1;
  if (countdown) {
    countdown.textContent = String(Math.max(remaining, 0));
  }
  if (remaining <= 0) {
    window.clearInterval(timer);
    window.close();
  }
}, 1000);
</script>`
        : '';
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HTHBuddy</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #172033;
      background: linear-gradient(135deg, #f7fbff 0%, #eef6ff 44%, #f7f7ff 100%);
    }
    * {
      box-sizing: border-box;
    }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 32px;
    }
    .card {
      width: min(520px, 100%);
      padding: 42px 40px;
      border: 1px solid rgba(64, 128, 255, 0.14);
      border-radius: 24px;
      background: rgba(255, 255, 255, 0.9);
      box-shadow: 0 24px 70px rgba(37, 84, 160, 0.14);
      text-align: center;
      backdrop-filter: blur(12px);
    }
    .icon {
      width: 68px;
      height: 68px;
      margin: 0 auto 22px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: linear-gradient(135deg, #4080ff 0%, #14c9c9 100%);
      color: #fff;
      font-size: 34px;
      box-shadow: 0 16px 32px rgba(64, 128, 255, 0.28);
    }
    h1 {
      margin: 0;
      font-size: 30px;
      line-height: 1.25;
      font-weight: 700;
      letter-spacing: 0;
    }
    .message {
      margin: 14px 0 0;
      color: #4e5969;
      font-size: 16px;
      line-height: 1.7;
      white-space: pre-wrap;
    }
    .countdown {
      margin: 24px 0 0;
      padding: 12px 16px;
      border-radius: 999px;
      background: #f2f6ff;
      color: #1d4ed8;
      font-size: 15px;
      font-weight: 600;
    }
    .hint {
      margin: 18px 0 0;
      color: #86909c;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="icon">✓</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="message">${escapeHtml(message)}</p>
    ${countdownText}
    <p class="hint">如果页面未自动关闭，可以直接关闭此页并返回 HTHBuddy。</p>
  </main>
  ${closeScript}
</body>
</html>`;
  }

  private async parseTokenResponse(response: Response): Promise<TokenResponse> {
    const rawText = await response.text();
    let parsed: ApiEnvelope<TokenResponse> | TokenResponse;
    try {
      parsed = JSON.parse(rawText) as ApiEnvelope<TokenResponse> | TokenResponse;
    } catch {
      throw new Error(`hth token request failed: ${response.status}`);
    }
    if (!response.ok) {
      const envelope = parsed as ApiEnvelope<TokenResponse>;
      throw new Error(envelope.error || envelope.msg || `hth token request failed: ${response.status}`);
    }
    if ('data' in parsed && parsed.data) {
      return parsed.data;
    }
    return parsed as TokenResponse;
  }

  private async readAuth(): Promise<StoredAuth | null> {
    try {
      const raw = await fs.readFile(this.authFile, 'utf8');
      return JSON.parse(raw) as StoredAuth;
    } catch {
      return null;
    }
  }

  private async writeAuth(auth: StoredAuth): Promise<void> {
    await fs.mkdir(path.dirname(this.authFile), { recursive: true });
    await fs.writeFile(this.authFile, JSON.stringify(auth, null, 2), 'utf8');
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return normalizeHTHBaseUrl(baseUrl);
  }

  private resolveBaseUrl(): string {
    return resolveDefaultHTHBaseUrl();
  }

  private isExpired(auth: StoredAuth): boolean {
    return typeof auth.expiresAt === 'number' && auth.expiresAt > 0 && auth.expiresAt <= Date.now();
  }

  private normalizeExpiresAt(expiresAt: number | undefined): number | undefined {
    if (!expiresAt) {
      return undefined;
    }
    return expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt;
  }

  private normalizeDepartments(value: string[] | undefined): string[] | undefined {
    const departments = (value ?? []).map((item) => item.trim()).filter(Boolean);
    return departments.length > 0 ? departments : undefined;
  }

  private canEncrypt(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  private encryptToken(token: string): string {
    if (!this.canEncrypt()) {
      return token;
    }
    return safeStorage.encryptString(token).toString('base64');
  }

  private decryptToken(auth: StoredAuth): string {
    return this.decryptValue(auth.accessToken, auth.encrypted);
  }

  private decryptValue(value: string | undefined, encrypted: boolean): string {
    if (!value) {
      return '';
    }
    if (!encrypted) {
      return value;
    }
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  }
}
