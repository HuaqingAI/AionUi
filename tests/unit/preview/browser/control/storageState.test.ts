import { describe, expect, it } from 'vitest';
import { parseBrowserStorageState, parseStorageOrigin } from '@/process/resources/builtinMcp/browser/storageState';

const cookie = {
  name: 'session',
  value: 'credential-value',
  domain: '.example.com',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: 'None',
};

describe('browser storage-state validation', () => {
  it('preserves domain, HttpOnly and session-cookie semantics from Playwright exports', () => {
    const state = parseBrowserStorageState({ cookies: [cookie], origins: [] });
    expect(state.cookies[0]).toMatchObject({
      domain: '.example.com',
      url: 'https://example.com/',
      httpOnly: true,
      secure: true,
      sameSite: 'no_restriction',
    });
    expect(state.cookies[0]).not.toHaveProperty('expirationDate');
  });

  it('preserves host-only cookies without expanding them to subdomains', () => {
    const state = parseBrowserStorageState([{ ...cookie, domain: 'example.com', sameSite: 'Lax' }]);
    expect(state.cookies[0]).not.toHaveProperty('domain');
    expect(state.cookies[0].sameSite).toBe('lax');
  });

  it('skips expired cookies while retaining live Unix expiry timestamps', () => {
    const state = parseBrowserStorageState(
      {
        cookies: [
          { ...cookie, expires: 90 },
          { ...cookie, expires: 110 },
        ],
      },
      undefined,
      100
    );
    expect(state.skippedExpiredCookies).toBe(1);
    expect(state.cookies.map((item) => item.expirationDate)).toEqual([110]);
  });

  it('keeps HTTP, HTTPS and port-specific Local Storage separate', () => {
    const state = parseBrowserStorageState({
      origins: ['http://example.com', 'https://example.com', 'https://example.com:8443'].map((origin) => ({
        origin,
        localStorage: [{ name: 'token', value: 'storage-secret' }],
      })),
    });
    expect(state.origins.map((origin) => origin.origin)).toEqual([
      'http://example.com',
      'https://example.com',
      'https://example.com:8443',
    ]);
  });

  it('supports a standalone Local Storage map when its origin is explicit', () => {
    const state = parseBrowserStorageState({ auth: 'storage-secret', empty: '' }, 'https://example.com');
    expect(state.origins).toEqual([
      {
        origin: 'https://example.com',
        entries: [
          { name: 'auth', value: 'storage-secret' },
          { name: 'empty', value: '' },
        ],
      },
    ]);
  });

  it.each([
    { cookies: [{ ...cookie, partitionKey: 'https://example.com' }] },
    { origins: [{ origin: 'https://example.com', localStorage: [], indexedDB: [] }] },
    { origins: [{ origin: 'https://example.com/path', localStorage: [] }] },
    { origins: [{ origin: 'file:///tmp/credentials', localStorage: [] }] },
    { origins: [{ origin: 'https://user:secret@example.com', localStorage: [] }] },
    { cookies: [{ ...cookie, sameSite: 1 }] },
    { cookies: [{ ...cookie, sameSite: '__proto__' }] },
    { cookies: [{ ...cookie, httpOnly: 'yes' }] },
    { cookies: [{ ...cookie, expires: 'tomorrow' }] },
    { cookies: [{ ...cookie, domain: 'example.com/other' }] },
  ])('rejects unsupported or malformed state before any writes: %j', (state) => {
    expect(() => parseBrowserStorageState(state)).toThrow();
  });

  it('rejects duplicate origin entries rather than silently replacing credentials', () => {
    const origin = { origin: 'https://example.com', localStorage: [] };
    expect(() => parseBrowserStorageState({ origins: [origin, origin] })).toThrow(/Duplicate/);
  });

  it('rejects duplicate Local Storage keys', () => {
    expect(() =>
      parseBrowserStorageState({
        origins: [
          {
            origin: 'https://example.com',
            localStorage: [
              { name: 'auth', value: 'a' },
              { name: 'auth', value: 'b' },
            ],
          },
        ],
      })
    ).toThrow(/Duplicate/);
  });

  it('does not echo credential values in validation failures', () => {
    expect(() => parseBrowserStorageState({ cookies: [{ ...cookie, secure: 'credential-value' }] })).toThrow(
      'Cookie secure must be boolean.'
    );
  });
});

describe('storage origin parsing', () => {
  it('normalizes default ports and international hostnames', () => {
    expect(parseStorageOrigin('https://EXAMPLE.com:443')).toBe('https://example.com');
    expect(parseStorageOrigin('https://例子.测试')).toBe('https://xn--fsqu00a.xn--0zwm56d');
  });

  it('rejects query-bearing origins', () => {
    expect(() => parseStorageOrigin('https://example.com/?token=private')).toThrow(/path or query/);
  });
});
