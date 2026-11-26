/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { HTHRuntimeModelChoices } from '@/common/types/hth/modelReasoning';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Read model-specific choices without creating a conversation or starting a CLI. */
export function useHTHRuntimeModelChoices(assistantId: string | undefined, scope: string | null, enabled: boolean) {
  const generation = useRef(0);
  const [state, setState] = useState<{
    assistantId?: string;
    scope: string | null;
    data?: HTHRuntimeModelChoices;
    error?: unknown;
    loading: boolean;
  }>({ scope: null, loading: false });
  const refresh = useCallback(async () => {
    if (!assistantId || !enabled) throw new Error('assistantRuntimeUnsupported');
    const requestGeneration = ++generation.current;
    setState((previous) => ({
      assistantId,
      scope,
      data: previous.assistantId === assistantId && previous.scope === scope ? previous.data : undefined,
      loading: true,
    }));
    try {
      const data = await ipcBridge.hth.runtimeModelChoices.invoke({ assistant_id: assistantId });
      if (requestGeneration !== generation.current) throw new Error('reasoningPolicyUnavailable');
      setState({ assistantId, scope, data, loading: false });
      return data;
    } catch (error) {
      if (requestGeneration === generation.current) setState({ assistantId, scope, error, loading: false });
      throw error;
    }
  }, [assistantId, scope, enabled]);

  useEffect(() => {
    if (!enabled || !assistantId) return;
    void refresh().catch((): void => {});
    return () => {
      generation.current += 1;
    };
  }, [assistantId, scope, enabled, refresh]);

  const current = enabled && state.assistantId === assistantId && state.scope === scope;
  return {
    choices: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: enabled && (!current || state.loading),
    refresh,
  };
}
