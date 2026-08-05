/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { HTHQuotaSummary } from '@/common/types/hth';
import { openExternalUrl } from '@/renderer/utils/platform';
import { Modal } from '@arco-design/web-react';
import type { TFunction } from 'i18next';

const QUOTA_PROMPT_DEDUPE_MS = 5000;
let lastQuotaPromptAt = 0;

export async function showQuotaInsufficientPrompt(t: TFunction): Promise<void> {
  const now = Date.now();
  if (now - lastQuotaPromptAt < QUOTA_PROMPT_DEDUPE_MS) {
    return;
  }
  lastQuotaPromptAt = now;

  const quotaApplyUrl = await resolveQuotaApplyUrl();
  Modal.info({
    title: t('conversation.chat.quotaApplyTitle'),
    content: quotaApplyUrl ? t('conversation.chat.quotaApplyBody') : t('conversation.chat.quotaApplyNoLink'),
    okText: quotaApplyUrl ? t('conversation.chat.quotaApplyOk') : t('common.close'),
    onOk: quotaApplyUrl
      ? (): void => {
          void openExternalUrl(quotaApplyUrl).catch((openError): void => {
            console.error('[QuotaPrompt] Failed to open quota apply URL:', openError);
          });
        }
      : undefined,
  });
}

export async function showQuotaPromptIfSummaryExhausted(summary: HTHQuotaSummary, t: TFunction): Promise<boolean> {
  if (!isQuotaSummaryInsufficient(summary)) {
    return false;
  }

  await showQuotaInsufficientPrompt(t);
  return true;
}

export function isQuotaSummaryInsufficient(summary: HTHQuotaSummary): boolean {
  const displayValue = parseTotalAvailableDisplay(summary);
  return displayValue === 0;
}

function parseTotalAvailableDisplay(summary: HTHQuotaSummary): number | null {
  const display = getTotalAvailableDisplay(summary);
  if (!display) {
    return null;
  }

  const normalized = display.replace(/,/g, '');
  const matched = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!matched) {
    return null;
  }

  const value = Number(matched[0]);
  return Number.isFinite(value) ? value : null;
}

function getTotalAvailableDisplay(summary: HTHQuotaSummary): string | null {
  const snakeCaseDisplay = summary.total_available_display?.trim();
  if (snakeCaseDisplay) {
    return snakeCaseDisplay;
  }

  return null;
}

async function resolveQuotaApplyUrl(): Promise<string | undefined> {
  const summaryUrl = await ipcBridge.hth.quotaSummary
    .invoke()
    .then((summary): string | undefined => summary?.quota_apply_url?.trim())
    .catch((): undefined => undefined);
  if (summaryUrl) {
    return summaryUrl;
  }

  return ipcBridge.hth.authStatus
    .invoke()
    .then((status): string | undefined => status.quotaApplyUrl?.trim() || undefined)
    .catch((): undefined => undefined);
}
