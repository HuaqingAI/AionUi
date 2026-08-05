/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { useCustomAgentsLoader } from '@/renderer/pages/guid/hooks/useCustomAgentsLoader';

vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: {
      list: { invoke: vi.fn() },
    },
  },
}));

const wrapper = ({ children }: React.PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

describe('useCustomAgentsLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes only user-created assistants on the Guid page', async () => {
    vi.mocked(ipcBridge.assistants.list.invoke).mockResolvedValue([
      { id: 'bare-aionrs', name: 'Aion CLI', source: 'generated' },
      { id: 'official-writer', name: 'Official Writer', source: 'builtin' },
      { id: 'custom-researcher', name: 'Researcher', source: 'user' },
    ] as Assistant[]);

    const { result } = renderHook(() => useCustomAgentsLoader(), { wrapper });

    await waitFor(() => expect(result.current.assistants).toHaveLength(1));

    expect(result.current.assistants.map((assistant) => assistant.id)).toEqual(['custom-researcher']);
  });
});
