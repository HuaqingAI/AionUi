/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
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
});
