/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect } from 'react';
import { Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ipcBridge } from '@/common';
import { isHTHUnauthorizedSyncResult } from '@/common/types/hth';

/**
 * Deep link event payload from main process
 */
export type DeepLinkPayload = {
  action: string;
  params: Record<string, string>;
};

export type DeepLinkAddProviderDetail = {
  base_url?: string;
  api_key?: string;
  name?: string;
  platform?: string;
};

/** Pending deep link data for the add-provider action. Read-once: consumed by ModelModalContent on mount. */
let pendingDeepLinkData: DeepLinkAddProviderDetail | null = null;

const formatHTHText = (value: string): string => value.replace(/hth/gi, 'HTH');

/**
 * Consume (read and clear) pending deep link data.
 * Returns the data if present, or null. Subsequent calls return null until new data arrives.
 */
export const consumePendingDeepLink = (): DeepLinkAddProviderDetail | null => {
  const data = pendingDeepLinkData;
  pendingDeepLinkData = null;
  return data;
};

/**
 * Allowed route patterns for the navigate deep link action.
 * Only routes matching these patterns are permitted.
 */
const ALLOWED_NAVIGATE_PATTERNS = [/^\/team\/[^/]+$/, /^\/conversation\/[^/]+$/];

/**
 * Hook to listen for aionui:// deep link events from main process.
 * Routes 'add-provider' action to the model settings page.
 * Routes 'navigate' action to the specified route (whitelist-validated).
 * The pre-fill data is stored in a module-level variable and consumed
 * by ModelModalContent on mount via consumePendingDeepLink().
 */
export const useDeepLink = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const handler = useCallback(
    (payload: DeepLinkPayload) => {
      if (payload.action === 'auth/hth-callback') {
        const code = payload.params.code;
        const state = payload.params.state;
        if (!code || !state) {
          Message.error(formatHTHText(t('login.hth.callbackMissing')));
          return;
        }

        void ipcBridge.hth.exchangeLoginCode
          .invoke({ code, state })
          .then(async () => {
            Message.success(formatHTHText(t('login.hth.success')));
            try {
              const syncResult = await ipcBridge.hth.syncAgentConfigs.invoke({ force: true });
              if (isHTHUnauthorizedSyncResult(syncResult)) {
                await navigate('/hth-login', { replace: true });
                return;
              }
            } catch (error) {
              console.error('[DeepLink] Failed to sync hth configs after login:', error);
              Message.warning(formatHTHText(t('settings.hth.syncFailed')));
            }
            await navigate('/guid', { replace: true });
          })
          .catch((error) => {
            console.error('[DeepLink] Failed to exchange hth login code:', error);
            Message.error(formatHTHText(t('login.hth.exchangeFailed')));
          });
        return;
      }

      // Support both formats: "add-provider" and "provider/add" (one-api style)
      if (payload.action === 'add-provider' || payload.action === 'provider/add') {
        pendingDeepLinkData = {
          base_url: payload.params.base_url,
          api_key: payload.params.api_key || payload.params.key,
          name: payload.params.name,
          platform: payload.params.platform,
        };

        // Navigate to model settings page; ModelModalContent will pick up the pending data
        void navigate('/settings/model');
        return;
      }

      if (payload.action === 'navigate') {
        const route = payload.params.route;
        if (!route) {
          console.warn('[DeepLink] navigate action missing route param');
          return;
        }

        const isAllowed = ALLOWED_NAVIGATE_PATTERNS.some((pattern) => pattern.test(route));
        if (!isAllowed) {
          console.warn(`[DeepLink] navigate blocked: route "${route}" not in whitelist`);
          return;
        }

        void navigate(route);
      }
    },
    [navigate, t]
  );

  useEffect(() => {
    return ipcBridge.deepLink.received.on(handler);
  }, [handler]);
};
