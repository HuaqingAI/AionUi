/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { CdnGenericProvider } from './cdnGenericProvider';
import type { CdnGenericProviderConfiguration } from './cdnGenericProvider';

export const CDN_UPDATE_BASE_URL = 'https://static.aionui.com/releases';
export const DEFAULT_NEW_API_BASE_URL = 'http://127.0.0.1:3001';
const UPDATE_FEED_URL_ENV = 'AIONUI_UPDATE_FEED_URL';
const HTH_BASE_URL_ENV = 'AIONUI_HTH_BASE_URL';
const VITE_HTH_BASE_URL_ENV = 'VITE_HTH_BASE_URL';

const CLIENT_UPDATES_PATH = '/api/aionui/client-updates';

function normalizeBaseUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/+$/, '');
}

function buildClientUpdatesUrl(baseUrl: string): string {
  return normalizeBaseUrl(new URL(CLIENT_UPDATES_PATH, baseUrl).toString());
}

export function resolveUpdateFeedBaseUrl(): string {
  const configured = process.env[UPDATE_FEED_URL_ENV]?.trim();
  if (configured) {
    return normalizeBaseUrl(configured);
  }
  const hthBaseUrl = process.env[HTH_BASE_URL_ENV]?.trim() || process.env[VITE_HTH_BASE_URL_ENV]?.trim();
  return buildClientUpdatesUrl(hthBaseUrl || DEFAULT_NEW_API_BASE_URL);
}

export type CdnFeedOptions = CdnGenericProviderConfiguration & {
  updateProvider: typeof CdnGenericProvider;
};

export function buildCdnFeedOptions(): CdnFeedOptions {
  return {
    provider: 'custom',
    url: resolveUpdateFeedBaseUrl(),
    updateProvider: CdnGenericProvider,
  };
}
