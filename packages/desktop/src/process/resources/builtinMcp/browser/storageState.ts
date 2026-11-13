/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type BrowserCookie = {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  expirationDate?: number;
};

export type BrowserOriginStorage = { origin: string; entries: Array<{ name: string; value: string }> };
export type BrowserStorageState = {
  cookies: BrowserCookie[];
  origins: BrowserOriginStorage[];
  skippedExpiredCookies: number;
};

const MAX_ITEMS = 10_000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Accept only HTTP origins, preserving protocol, host and port boundaries. */
export function parseStorageOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Storage origin must be an HTTP or HTTPS URL.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Storage origin must be an HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === 'null') {
    throw new Error('Storage origin must be an HTTP or HTTPS URL without credentials.');
  }
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('Storage origin cannot include a path or query.');
  return url.origin;
}

const parseEntries = (value: unknown): BrowserOriginStorage['entries'] => {
  if (!Array.isArray(value) || value.length > MAX_ITEMS)
    throw new Error('Local Storage must be a bounded entry array.');
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
      throw new Error('Every Local Storage entry requires string name and value fields.');
    }
    if (seen.has(entry.name)) throw new Error('Duplicate Local Storage entry names are not supported.');
    seen.add(entry.name);
    return { name: entry.name, value: entry.value };
  });
};

const parseBoolean = (entry: Record<string, unknown>, key: string): boolean => {
  if (entry[key] !== undefined && typeof entry[key] !== 'boolean') throw new Error(`Cookie ${key} must be boolean.`);
  return entry[key] === true;
};

const parseCookie = (entry: unknown, nowSeconds: number): BrowserCookie | null => {
  if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
    throw new Error('Every cookie requires string name and value fields.');
  }
  if (entry.partitionKey !== undefined || entry.partitioned === true) {
    throw new Error('Partitioned cookies are not supported by this storage-state importer.');
  }
  if (/[\x00-\x20\x7f;,=]/.test(entry.name) || /[\x00-\x1f\x7f]/.test(entry.value)) {
    throw new Error('Cookie name or value contains invalid control characters.');
  }
  const secure = parseBoolean(entry, 'secure');
  const httpOnly = parseBoolean(entry, 'httpOnly');
  const path = entry.path ?? '/';
  if (typeof path !== 'string' || !path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path)) {
    throw new Error('Cookie path must be an absolute URL path.');
  }
  let url: URL;
  let domain: string | undefined;
  if (typeof entry.domain === 'string' && entry.domain.length > 0) {
    domain = entry.domain;
    const hostname = domain.replace(/^\./, '');
    if (!hostname || /[\s\/:?#@\\]/.test(hostname)) throw new Error('Cookie domain is invalid.');
    try {
      url = new URL(`${secure ? 'https' : 'http'}://${hostname}${path}`);
    } catch {
      throw new Error('Cookie domain is invalid.');
    }
    // Host-only cookies must omit domain when Electron creates them.
    if (entry.hostOnly === true || !domain.startsWith('.')) domain = undefined;
  } else if (typeof entry.url === 'string') {
    try {
      url = new URL(entry.url);
    } catch {
      throw new Error('Cookie URL is invalid.');
    }
  } else {
    throw new Error('Every cookie requires a domain or URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Cookie URL must use HTTP or HTTPS without credentials.');
  }
  if (entry.sameSite !== undefined && typeof entry.sameSite !== 'string')
    throw new Error('Cookie SameSite must be a string.');
  const sameSiteValue = typeof entry.sameSite === 'string' ? entry.sameSite.toLowerCase() : 'unspecified';
  const sameSites: Record<string, BrowserCookie['sameSite']> = {
    unspecified: 'unspecified',
    none: 'no_restriction',
    no_restriction: 'no_restriction',
    lax: 'lax',
    strict: 'strict',
  };
  const sameSite = Object.hasOwn(sameSites, sameSiteValue) ? sameSites[sameSiteValue] : undefined;
  if (!sameSite) throw new Error('Cookie SameSite must be Strict, Lax, None or unspecified.');
  const expires = entry.expires ?? entry.expirationDate;
  if (expires !== undefined && (typeof expires !== 'number' || !Number.isFinite(expires) || expires < -1)) {
    throw new Error('Cookie expiry must be a Unix timestamp in seconds or -1 for a session cookie.');
  }
  if (typeof expires === 'number' && expires !== -1 && expires <= nowSeconds) return null;
  return {
    url: url.toString(),
    name: entry.name,
    value: entry.value,
    ...(domain ? { domain } : {}),
    path,
    secure,
    httpOnly,
    sameSite,
    ...(typeof expires === 'number' && expires !== -1 ? { expirationDate: expires } : {}),
  };
};

/** Validate a Playwright state file, cookie export, or explicit-origin Local Storage export before writing. */
export function parseBrowserStorageState(
  value: unknown,
  explicitOrigin?: string,
  nowSeconds = Date.now() / 1000
): BrowserStorageState {
  let rawCookies: unknown = [];
  let rawOrigins: unknown = [];
  if (Array.isArray(value)) {
    rawCookies = value;
  } else if (isRecord(value) && ('cookies' in value || 'origins' in value)) {
    rawCookies = value.cookies ?? [];
    rawOrigins = value.origins ?? [];
  } else if (isRecord(value) && ('localStorage' in value || explicitOrigin)) {
    const origin = explicitOrigin ?? value.origin;
    const entries =
      value.localStorage ?? Object.entries(value).map(([name, entryValue]) => ({ name, value: entryValue }));
    rawOrigins = [{ origin, localStorage: entries }];
  } else {
    throw new Error('Expected Playwright storage state, a cookie array, or Local Storage with an explicit origin.');
  }
  if (!Array.isArray(rawCookies) || rawCookies.length > MAX_ITEMS) throw new Error('Cookies must be a bounded array.');
  if (!Array.isArray(rawOrigins) || rawOrigins.length > MAX_ITEMS) throw new Error('Origins must be a bounded array.');
  let skippedExpiredCookies = 0;
  const cookies = rawCookies.flatMap((entry: unknown) => {
    const cookie = parseCookie(entry, nowSeconds);
    if (!cookie) skippedExpiredCookies += 1;
    return cookie ? [cookie] : [];
  });
  const seenOrigins = new Set<string>();
  const origins = rawOrigins.map((entry: unknown) => {
    if (!isRecord(entry)) throw new Error('Every origin requires a Local Storage entry list.');
    if (entry.indexedDB !== undefined) throw new Error('IndexedDB state is not supported by this importer.');
    const origin = parseStorageOrigin(entry.origin);
    if (seenOrigins.has(origin)) throw new Error('Duplicate storage origins are not supported.');
    seenOrigins.add(origin);
    return { origin, entries: parseEntries(entry.localStorage ?? []) };
  });
  return { cookies, origins, skippedExpiredCookies };
}
