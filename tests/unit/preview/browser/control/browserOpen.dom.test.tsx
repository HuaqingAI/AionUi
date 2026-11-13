/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserOpenRequest } from '@/common/types/platform/browser';

const mocks = vi.hoisted(() => ({
  onRequest: vi.fn(),
  getConversation: vi.fn(),
  reportFailure: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      browserOpenRequested: { on: mocks.onRequest },
      browserOpenResult: { invoke: mocks.reportFailure },
    },
    conversation: { get: { invoke: mocks.getConversation }, responseStream: { on: () => () => {} } },
    fileStream: { contentUpdate: { on: () => () => {} } },
    preview: { open: { on: () => () => {} } },
    fs: { getFileContent: { invoke: vi.fn() }, writeFile: { invoke: vi.fn() } },
  },
}));

vi.mock('@/renderer/pages/conversation/Preview/browser/firstUseNotice', () => ({
  maybeNotifyFirstAgentBrowserUse: vi.fn(),
}));

import {
  PreviewProvider,
  usePreviewContext,
  type PreviewContextValue,
} from '@/renderer/pages/conversation/Preview/context/PreviewContext';

let context: PreviewContextValue;
let receiveRequest: (request: BrowserOpenRequest) => void;

const Probe = (): React.ReactNode => {
  context = usePreviewContext();
  return null;
};

const renderProvider = () =>
  render(
    <PreviewProvider>
      <Probe />
    </PreviewProvider>
  );
const requestBrowser = async (request: BrowserOpenRequest): Promise<void> => {
  await act(async () => receiveRequest(request));
};

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
  vi.clearAllMocks();
  mocks.onRequest.mockImplementation((listener: typeof receiveRequest) => {
    receiveRequest = listener;
    return () => {};
  });
  mocks.getConversation.mockResolvedValue({
    id: 'conversation-1',
    project_id: 'project-1',
    extra: { workspace: 'E:/work' },
  });
});

afterEach(cleanup);

describe('agent requests for the browser view', () => {
  it('shows the requested conversation browser in its project scope', async () => {
    renderProvider();
    await requestBrowser({ requestId: 'open-1', conversationId: 'conversation-1', url: 'https://www.baidu.com' });

    expect(context.activeTab).toMatchObject({
      content_type: 'browser',
      content: 'https://www.baidu.com',
      metadata: { browserRequestId: 'open-1' },
    });
    expect(context.isOpen).toBe(true);
    expect(window.location.hash).toBe('#/conversation/conversation-1');
  });

  it('reuses a mounted browser and acknowledges each subsequent request', async () => {
    renderProvider();
    await requestBrowser({ requestId: 'open-1', conversationId: 'conversation-1', url: 'https://www.baidu.com' });
    const tabId = context.activeTabId;
    act(() => context.closePreview());
    await requestBrowser({ requestId: 'open-2', conversationId: 'conversation-1' });

    expect(context.tabs).toHaveLength(1);
    expect(context.activeTab).toMatchObject({
      id: tabId,
      content: 'https://www.baidu.com',
      metadata: { browserRequestId: 'open-2' },
    });
    expect(context.isOpen).toBe(true);
  });

  it('retains an in-flight request when unrelated preview state changes', async () => {
    let resolveConversation: (value: unknown) => void = () => {};
    mocks.getConversation.mockReturnValue(
      new Promise((resolve) => {
        resolveConversation = resolve;
      })
    );
    renderProvider();
    act(() => receiveRequest({ requestId: 'pending', conversationId: 'conversation-1' }));
    act(() => context.openBrowserTab('https://unrelated.example'));
    await act(async () => resolveConversation({ id: 'conversation-1', project_id: 'project-1', extra: {} }));

    expect(context.activeTab?.metadata?.browserRequestId).toBe('pending');
    expect(mocks.onRequest).toHaveBeenCalledOnce();
  });

  it('reports missing conversations instead of opening another conversation browser', async () => {
    mocks.getConversation.mockResolvedValue(null);
    renderProvider();
    await requestBrowser({ requestId: 'missing', conversationId: 'conversation-1' });

    expect(mocks.reportFailure).toHaveBeenCalledWith({
      requestId: 'missing',
      error: 'The browser conversation is unavailable.',
    });
    expect(context.tabs).toHaveLength(0);
  });

  it('reports lookup failures instead of leaving the agent waiting for a view', async () => {
    mocks.getConversation.mockRejectedValue(new Error('Offline'));
    renderProvider();
    await requestBrowser({ requestId: 'failed', conversationId: 'conversation-1' });

    expect(mocks.reportFailure).toHaveBeenCalledWith({ requestId: 'failed', error: 'Offline' });
  });

  it('never restores pending request acknowledgements after an app restart', async () => {
    renderProvider();
    await requestBrowser({ requestId: 'temporary', conversationId: 'conversation-1' });
    act(() => context.closePreviewIfScopeChanged('other-project'));

    const saved = JSON.parse(localStorage.getItem('preview-ui:project-1') || '{}') as {
      tabs: Array<{ metadata?: unknown }>;
    };
    expect(saved.tabs[0].metadata).not.toHaveProperty('browserRequestId');
    act(() => context.closePreviewIfScopeChanged('project-1'));
    expect(context.activeTab?.metadata).not.toHaveProperty('browserRequestId');
  });
});
