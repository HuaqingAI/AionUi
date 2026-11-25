/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type HTHNotificationSummary = {
  id: string;
  title: string;
  summary: string;
  version: number;
  published_at: number;
  updated_at: number;
};

export type HTHNotificationDetail = HTHNotificationSummary & { content: string };
export type HTHNotificationItem = HTHNotificationSummary & { is_read: boolean };
export type HTHNotificationErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'unsupported'
  | 'unavailable'
  | 'not_found'
  | 'invalid_response'
  | 'stale_context'
  | 'storage_failed';

export type HTHNotificationSnapshot = {
  context_id: string;
  state_version: number;
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'unauthenticated' | 'unsupported';
  items: HTHNotificationItem[];
  unread_count: number | null;
  last_synced_at: number | null;
  storage_status: 'ready' | 'unavailable' | 'recovered';
  error_code?: HTHNotificationErrorCode;
};

export type HTHNotificationResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      code: HTHNotificationErrorCode;
      snapshot?: HTHNotificationSnapshot;
      retry_after_seconds?: number;
    };

export type HTHNotificationRequest = { id: string; context_id: string };
export type HTHNotificationMarkAllRequest = { ids: string[]; context_id: string };
export type HTHNotificationDetailView = HTHNotificationDetail & { context_id: string };
export type HTHNotificationChanged = { context_id: string; state_version: number };
