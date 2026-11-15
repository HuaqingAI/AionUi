/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';

const mocks = vi.hoisted(() => ({ report: vi.fn() }));

vi.mock('@/common', () => ({
  ipcBridge: { application: { reportBrowserWebContentsId: { invoke: mocks.report } } },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import WebviewHost from '@/renderer/components/media/WebviewHost';

const makeReady = async (container: HTMLElement): Promise<void> => {
  const webview = container.querySelector('webview');
  if (!webview) throw new Error('No webview rendered');
  Object.assign(webview, {
    getWebContentsId: () => 42,
    executeJavaScript: () => Promise.resolve(true),
    setZoomFactor: () => {},
  });
  await act(async () => webview.dispatchEvent(new Event('dom-ready')));
};

const observeNavigation = (container: HTMLElement) => {
  const webview = container.querySelector('webview');
  if (!webview) throw new Error('No webview rendered');
  const setAttribute = webview.setAttribute.bind(webview);
  const writes = vi.spyOn(webview, 'setAttribute');
  const setSource = vi.fn((value: string) => webview.setAttribute('src', value));
  Object.defineProperty(webview, 'src', {
    configurable: true,
    get: () => webview.getAttribute('src') ?? '',
    set: setSource,
  });
  return {
    webview,
    setSource,
    sourceWrites: () => writes.mock.calls.filter(([name]) => name === 'src').map(([, value]) => value),
    commit: async (url: string, event = 'did-navigate') => {
      // Electron updates the DOM attribute without initiating another navigation.
      setAttribute('src', url);
      await act(async () => webview.dispatchEvent(Object.assign(new Event(event), { url })));
    },
  };
};

beforeEach(() => {
  mocks.report.mockReset().mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('browser control readiness', () => {
  it('acknowledges a newly ready active browser with the matching request', async () => {
    const { container } = render(
      <WebviewHost
        url='about:blank'
        partition={BROWSER_SESSION_PARTITION}
        browserControlActive
        browserRequestId='first'
      />
    );
    expect(mocks.report).not.toHaveBeenCalled();
    await makeReady(container);

    expect(mocks.report).toHaveBeenCalledWith({ webContentsId: 42, requestId: 'first' });
  });

  it('focuses the embedder webview before reporting an explicit agent request ready', async () => {
    const { container } = render(
      <WebviewHost
        url='about:blank'
        partition={BROWSER_SESSION_PARTITION}
        browserControlActive
        browserRequestId='type'
      />
    );
    const webview = container.querySelector('webview');
    if (!webview) throw new Error('No webview rendered');
    const focus = vi.spyOn(webview, 'focus');
    await makeReady(container);

    expect(focus).toHaveBeenCalledOnce();
    expect(focus.mock.invocationCallOrder[0]).toBeLessThan(mocks.report.mock.invocationCallOrder[0]);
  });

  it('preserves user focus during a passive browser attachment', async () => {
    const { container } = render(
      <WebviewHost url='about:blank' partition={BROWSER_SESSION_PARTITION} browserControlActive />
    );
    const webview = container.querySelector('webview');
    if (!webview) throw new Error('No webview rendered');
    const focus = vi.spyOn(webview, 'focus');
    await makeReady(container);

    expect(focus).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledOnce();
  });

  it('acknowledges a second request without waiting for another dom-ready event', async () => {
    const { container, rerender } = render(
      <WebviewHost
        url='about:blank'
        partition={BROWSER_SESSION_PARTITION}
        browserControlActive
        browserRequestId='first'
      />
    );
    await makeReady(container);
    rerender(
      <WebviewHost
        url='about:blank'
        partition={BROWSER_SESSION_PARTITION}
        browserControlActive
        browserRequestId='second'
      />
    );

    expect(mocks.report).toHaveBeenLastCalledWith({ webContentsId: 42, requestId: 'second' });
    expect(mocks.report).toHaveBeenCalledTimes(2);
  });

  it('reattaches an already mounted browser when it becomes active', async () => {
    const { container, rerender } = render(
      <WebviewHost url='about:blank' partition={BROWSER_SESSION_PARTITION} browserControlActive={false} />
    );
    await makeReady(container);
    expect(mocks.report).not.toHaveBeenCalled();
    rerender(<WebviewHost url='about:blank' partition={BROWSER_SESSION_PARTITION} browserControlActive />);

    expect(mocks.report).toHaveBeenCalledWith({ webContentsId: 42, requestId: undefined });
  });

  it('does not reuse a completed request acknowledgement when a user reselects its tab', async () => {
    const { container, rerender } = render(
      <WebviewHost
        url='about:blank'
        partition={BROWSER_SESSION_PARTITION}
        browserControlActive
        browserRequestId='complete'
      />
    );
    await makeReady(container);
    rerender(
      <WebviewHost
        url='about:blank'
        partition={BROWSER_SESSION_PARTITION}
        browserControlActive={false}
        browserRequestId='complete'
      />
    );
    rerender(
      <WebviewHost
        url='about:blank'
        partition={BROWSER_SESSION_PARTITION}
        browserControlActive
        browserRequestId='complete'
      />
    );

    expect(mocks.report).toHaveBeenLastCalledWith({ webContentsId: 42, requestId: undefined });
  });

  it('excludes Office and other embedded webviews from agent control', async () => {
    const { container } = render(
      <WebviewHost url='about:blank' partition='persist:office' browserControlActive browserRequestId='wrong-view' />
    );
    await makeReady(container);

    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('handles IPC rejection without an unhandled asynchronous error', async () => {
    mocks.report.mockRejectedValue(new Error('Window closed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(
      <WebviewHost url='about:blank' partition={BROWSER_SESSION_PARTITION} browserControlActive />
    );
    await makeReady(container);

    expect(warn).toHaveBeenCalledWith('[browser] could not report webContents id');
  });

  it('updates the address after main-process navigation without starting another navigation', async () => {
    const changed = vi.fn();
    const { container, rerender } = render(
      <WebviewHost url='about:blank' showNavBar onUrlChange={changed} browserControlActive />
    );
    const navigation = observeNavigation(container);
    const temporaryUrl = 'https://example.com/__aionui_storage_import__test';

    await navigation.commit(temporaryUrl);
    rerender(<WebviewHost url={temporaryUrl} showNavBar onUrlChange={changed} browserControlActive />);
    await navigation.commit('about:blank');
    rerender(<WebviewHost url='about:blank' showNavBar onUrlChange={changed} browserControlActive />);

    expect(navigation.sourceWrites()).toEqual([]);
    expect(changed.mock.calls.map(([url]) => url)).toEqual(['about:blank', temporaryUrl, 'about:blank']);
    expect(container.querySelector('input')?.value).toBe('about:blank');
  });

  it('navigates once when an external URL changes and keeps the mounted webview', async () => {
    const { container, rerender } = render(<WebviewHost url='about:blank' />);
    const navigation = observeNavigation(container);

    rerender(<WebviewHost url='https://example.com/new' />);
    await navigation.commit('https://example.com/new');

    expect(navigation.setSource).toHaveBeenCalledExactlyOnceWith('https://example.com/new');
    expect(navigation.sourceWrites()).toEqual(['https://example.com/new']);
    expect(container.querySelector('webview')).toBe(navigation.webview);
  });

  it('submits the address bar once and preserves guest history navigation', async () => {
    const { container } = render(<WebviewHost url='about:blank' showNavBar />);
    const navigation = observeNavigation(container);
    const input = container.querySelector('input');
    const form = container.querySelector('form');
    if (!input || !form) throw new Error('No address bar rendered');

    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(form);
    await navigation.commit('https://example.com');
    await navigation.commit('https://example.com/route', 'did-navigate-in-page');
    await navigation.commit('about:blank');

    expect(navigation.setSource).toHaveBeenCalledExactlyOnceWith('https://example.com');
    expect(navigation.sourceWrites()).toEqual(['https://example.com']);
    expect(input.value).toBe('about:blank');
  });
});
