/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Spin } from '@arco-design/web-react';
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getAgentModelCatalogSnapshot,
  subscribeAgentModelCatalog,
} from '@/renderer/services/runtime/agentModelCatalog';
import { getConversationCreateErrorMessage } from '../utils/conversationCreateError';
import { CHAT_SURFACE_CONTAINER_CLASS, getChatSurfaceWidthClass } from '../utils/chatSurfaceWidth';
import { getConversationPreparation, prepareConversation } from './conversationPreparation';

/** Keep automatic runtime reads and sends unmounted until the first turn is prepared. */
const ConversationPreparationGate: React.FC<{
  conversationId: string;
  workspace?: string;
  children: React.ReactNode;
}> = ({ conversationId, workspace, children }) => {
  const { t } = useTranslation();
  const { scope } = useSyncExternalStore(subscribeAgentModelCatalog, getAgentModelCatalogSnapshot);
  const [initial] = useState<{ pending: ReturnType<typeof getConversationPreparation>; error: unknown }>(() => {
    try {
      return { pending: getConversationPreparation(conversationId), error: null };
    } catch (error) {
      return { pending: null, error };
    }
  });
  const [ready, setReady] = useState(!initial.pending && !initial.error);
  const [error, setError] = useState(initial.error);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (ready) return;
    // The account scope is restored by the authenticated layout on reload.
    if (initial.pending?.scope && scope === null) return;
    let disposed = false;
    setError(null);
    void prepareConversation(conversationId, t, workspace).then(
      () => {
        if (!disposed) setReady(true);
      },
      (preparationError: unknown) => {
        console.warn('[ConversationPreparation] failed', { conversationId });
        if (!disposed) setError(preparationError);
      }
    );
    return () => {
      disposed = true;
    };
  }, [conversationId, workspace, initial, scope, t, attempt, ready]);

  if (ready) return <>{children}</>;

  return (
    <div
      className={`${CHAT_SURFACE_CONTAINER_CLASS} box-border min-w-0 min-h-0 flex-1 overflow-auto p-24px`}
      aria-busy={!error}
    >
      <div className={`${getChatSurfaceWidthClass()} min-w-0 flex flex-col gap-24px`}>
        {initial.pending?.initialMessage && (
          <div className='self-end box-border min-w-0 max-w-full max-h-50vh overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-16px bg-2 px-16px py-12px text-t-primary'>
            {initial.pending.initialMessage.input}
          </div>
        )}
        <div className='flex items-center gap-12px text-t-secondary' role={error ? 'alert' : 'status'}>
          {!error && <Spin size={16} />}
          <div className='min-w-0 flex-1'>
            <div>
              {t(
                error
                  ? 'conversation.runtimePreparing.preparationFailed'
                  : 'conversation.runtimePreparing.preparationTitle'
              )}
            </div>
            {error && <div className='mt-8px break-words'>{getConversationCreateErrorMessage(error, t)}</div>}
          </div>
          {error && (
            <Button className='shrink-0' onClick={() => setAttempt((value) => value + 1)}>
              {t('common.retry')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ConversationPreparationGate;
