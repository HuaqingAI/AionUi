/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export const DEV_HTH_BASE_URL = 'http://127.0.0.1:3001';
export const PROD_HTH_BASE_URL = 'https://hth.huaqing.run';

const HTH_BASE_URL_ENV = 'AIONUI_HTH_BASE_URL';
const VITE_HTH_BASE_URL_ENV = 'VITE_HTH_BASE_URL';

type StoredAuthBaseUrl = {
  baseUrl?: unknown;
};

export function normalizeHTHBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function getHTHAuthFilePath(): string {
  return path.join(app.getPath('userData'), 'hth', 'auth.json');
}

function resolveConfiguredHTHBaseUrl(): string | null {
  const configured = process.env[HTH_BASE_URL_ENV]?.trim() || process.env[VITE_HTH_BASE_URL_ENV]?.trim();
  if (configured) {
    return normalizeHTHBaseUrl(configured);
  }
  return null;
}

export function resolveDefaultHTHBaseUrl(): string {
  const configured = resolveConfiguredHTHBaseUrl();
  if (configured) {
    return configured;
  }
  return app.isPackaged ? PROD_HTH_BASE_URL : DEV_HTH_BASE_URL;
}

export function readStoredHTHBaseUrl(authFile = getHTHAuthFilePath()): string | null {
  try {
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf8')) as StoredAuthBaseUrl;
    if (typeof auth.baseUrl !== 'string' || !auth.baseUrl.trim()) {
      return null;
    }
    return normalizeHTHBaseUrl(auth.baseUrl);
  } catch {
    return null;
  }
}

export function resolveHTHBaseUrl(authFile = getHTHAuthFilePath()): string {
  return resolveConfiguredHTHBaseUrl() || readStoredHTHBaseUrl(authFile) || resolveDefaultHTHBaseUrl();
}
