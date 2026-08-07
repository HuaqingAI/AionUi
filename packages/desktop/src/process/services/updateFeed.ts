/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { CdnGenericProvider } from './cdnGenericProvider';
import type { CdnGenericProviderConfiguration } from './cdnGenericProvider';
import { resolveHTHBaseUrl } from './hth/baseUrl';

export const CDN_UPDATE_BASE_URL = 'https://static.aionui.com/releases';
const UPDATE_FEED_URL_ENV = 'AIONUI_UPDATE_FEED_URL';

export const CLIENT_UPDATES_PATH = '/api/aionui/client-updates';

function normalizeBaseUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/+$/, '');
}

export function buildClientUpdatesUrl(baseUrl: string): string {
  return normalizeBaseUrl(new URL(CLIENT_UPDATES_PATH, baseUrl).toString());
}

export function resolveUpdateFeedBaseUrl(): string {
  const configured = process.env[UPDATE_FEED_URL_ENV]?.trim();
  if (configured) {
    return normalizeBaseUrl(configured);
  }
  return buildClientUpdatesUrl(resolveHTHBaseUrl());
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
