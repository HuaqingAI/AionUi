/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HTHAuthAccess } from './authService';

const BOOTSTRAP_SECRET_HEADER = 'x-aioncore-bootstrap-secret';
const CORE_SESSION_COOKIE = 'aionui-session';
const CORE_CSRF_COOKIE = 'aionui-csrf-token';

type RequestHeaders = Record<string, string | string[]>;

export type RegisterRequestHeadersInterceptor = (
  interceptor: (url: string, headers: RequestHeaders) => RequestHeaders
) => void;

type CoreIdentityServiceOptions = {
  getBackendPort: () => number | undefined;
  getBootstrapSecret: () => string | undefined;
  registerRequestHeadersInterceptor: RegisterRequestHeadersInterceptor;
};

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const containsControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!normalized || containsControlCharacter) {
    throw new Error('HTH login did not provide a valid email identity');
  }
  return normalized;
}

function isBackendUrl(url: string, port: number): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'ws:') &&
      parsed.hostname === '127.0.0.1' &&
      Number(parsed.port) === port
    );
  } catch {
    return false;
  }
}

function coreSessionTokens(headers: Headers): { accessToken?: string; csrfToken?: string } {
  const result: { accessToken?: string; csrfToken?: string } = {};
  const cookieHeaders = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const cookie of cookieHeaders) {
    const sessionMatch = new RegExp(`^${CORE_SESSION_COOKIE}=([^;]+)`).exec(cookie);
    if (sessionMatch?.[1]) result.accessToken = sessionMatch[1];
    const csrfMatch = new RegExp(`^${CORE_CSRF_COOKIE}=([^;]+)`).exec(cookie);
    if (csrfMatch?.[1]) result.csrfToken = csrfMatch[1];
  }
  return result;
}

function appendCookie(headers: RequestHeaders, name: string, value: string): void {
  const cookieName = name.toLowerCase();
  const existingName = Object.keys(headers).find((header) => header.toLowerCase() === 'cookie');
  const existing = existingName ? headers[existingName] : undefined;
  if (existingName) delete headers[existingName];
  const source = typeof existing === 'string' ? existing : Array.isArray(existing) ? existing.join('; ') : '';
  const cookies = source
    .split(';')
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie && !cookie.toLowerCase().startsWith(`${cookieName}=`));
  cookies.push(`${name}=${value}`);
  headers.Cookie = cookies.join('; ');
}

export function addCoreAuthorization(
  url: string,
  requestHeaders: RequestHeaders,
  port: number | undefined,
  token: string | undefined,
  csrfToken?: string
): RequestHeaders {
  if (!port || !token || !isBackendUrl(url, port)) return requestHeaders;

  const headers = { ...requestHeaders };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'authorization') {
      delete headers[name];
    }
  }
  headers.Authorization = `Bearer ${token}`;
  if (csrfToken) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'x-csrf-token') {
        delete headers[name];
      }
    }
    headers['x-csrf-token'] = csrfToken;
    appendCookie(headers, CORE_CSRF_COOKIE, csrfToken);
  }
  return headers;
}

export class HTHCoreIdentityService {
  private coreAccessToken: string | undefined;
  private coreCsrfToken: string | undefined;
  private externalUserId: string | undefined;
  private establishedPort: number | undefined;
  private establishedBootstrapSecret: string | undefined;

  constructor(private readonly options: CoreIdentityServiceOptions) {
    options.registerRequestHeadersInterceptor((url, headers) =>
      addCoreAuthorization(url, headers, options.getBackendPort(), this.coreAccessToken, this.coreCsrfToken)
    );
  }

  async establish(access: HTHAuthAccess): Promise<void> {
    const email = normalizeEmail(access.email);
    const port = this.options.getBackendPort();
    const bootstrapSecret = this.options.getBootstrapSecret();
    if (!port || !bootstrapSecret) {
      throw new Error('AionCore identity bridge is unavailable');
    }
    if (
      this.externalUserId === email &&
      this.coreAccessToken &&
      this.coreCsrfToken &&
      this.establishedPort === port &&
      this.establishedBootstrapSecret === bootstrapSecret
    ) {
      return;
    }

    if (this.externalUserId && this.externalUserId !== email) {
      this.coreAccessToken = undefined;
      this.coreCsrfToken = undefined;
    }

    const headers = {
      'Content-Type': 'application/json',
      [BOOTSTRAP_SECRET_HEADER]: bootstrapSecret,
    };
    const externalUserPath = encodeURIComponent(email);
    const userResponse = await fetch(`http://127.0.0.1:${port}/api/auth/internal/external-users/${externalUserPath}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        user_type: 'aionpro',
        username: access.displayName || access.username || email,
        email,
      }),
    });
    if (!userResponse.ok) {
      throw new Error(`AionCore user provisioning failed (${userResponse.status})`);
    }

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/auth/internal/external-sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ user_type: 'aionpro', external_user_id: email }),
    });
    if (!sessionResponse.ok) {
      throw new Error(`AionCore session exchange failed (${sessionResponse.status})`);
    }

    const { accessToken, csrfToken } = coreSessionTokens(sessionResponse.headers);
    if (!accessToken || !csrfToken) {
      throw new Error('AionCore session exchange returned incomplete session data');
    }

    this.coreAccessToken = accessToken;
    this.coreCsrfToken = csrfToken;
    this.externalUserId = email;
    this.establishedPort = port;
    this.establishedBootstrapSecret = bootstrapSecret;
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const authorizedHeaders = addCoreAuthorization(
      url,
      headers,
      this.options.getBackendPort(),
      this.coreAccessToken,
      this.coreCsrfToken
    );
    const fetchHeaders = new Headers();
    for (const [name, value] of Object.entries(authorizedHeaders)) {
      fetchHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    return fetch(url, {
      ...init,
      headers: fetchHeaders,
    });
  }

  async clear(): Promise<void> {
    const externalUserId = this.externalUserId;
    this.coreAccessToken = undefined;
    this.coreCsrfToken = undefined;
    this.externalUserId = undefined;
    this.establishedPort = undefined;
    this.establishedBootstrapSecret = undefined;
    if (!externalUserId) return;

    const port = this.options.getBackendPort();
    const bootstrapSecret = this.options.getBootstrapSecret();
    if (!port || !bootstrapSecret) return;

    try {
      await fetch(`http://127.0.0.1:${port}/api/auth/internal/external-sessions/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [BOOTSTRAP_SECRET_HEADER]: bootstrapSecret,
        },
        body: JSON.stringify({ user_type: 'aionpro', external_user_id: externalUserId }),
      });
    } catch {
      // The renderer token was already cleared. A later Core restart cannot use it.
    }
  }
}
