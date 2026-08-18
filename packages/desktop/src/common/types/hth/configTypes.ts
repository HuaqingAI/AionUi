/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type HTHCliType = 'opencode' | 'codex';
export type HTHAgentUrlType = 'https';

export type HTHAgentConfigItem = {
  id?: string;
  cli_type: HTHCliType;
  artifact_key?: string;
  url: string;
  url_type: HTHAgentUrlType;
  url_expires_at?: number;
  version: string;
  name: string;
  description?: string;
  categories?: string[];
  recommended_prompts?: string[];
  avatar?: string;
  sha256?: string;
  size?: number;
};

export type HTHAgentConfigs = {
  user_email?: string;
  revision?: string;
  agents: HTHAgentConfigItem[];
};

export type HTHSyncPackageStatus = 'synced' | 'updated' | 'skipped' | 'failed';

export type HTHSyncPackageResult = {
  id: string;
  name: string;
  version: string;
  status: HTHSyncPackageStatus;
  error?: string;
};

export const HTH_UNAUTHORIZED_ERROR_CODE = 'hth-unauthorized';

export type HTHSyncErrorCode = typeof HTH_UNAUTHORIZED_ERROR_CODE;

export type HTHSyncResult = {
  success: boolean;
  email?: string;
  revision?: string;
  imported: number;
  skipped: number;
  failed: number;
  packages: HTHSyncPackageResult[];
  lastSyncedAt?: number;
  updated?: number;
  deleted?: number;
  errorCode?: HTHSyncErrorCode;
  error?: string;
};

export type HTHUnauthorizedSyncResult = HTHSyncResult & {
  errorCode: typeof HTH_UNAUTHORIZED_ERROR_CODE;
};

export function isHTHUnauthorizedSyncResult(result: unknown): result is HTHUnauthorizedSyncResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    'errorCode' in result &&
    result.errorCode === HTH_UNAUTHORIZED_ERROR_CODE
  );
}

export type HTHSyncAgentConfigsRequest = {
  force?: boolean;
};

export type HTHInjectProjectConfigRequest = {
  conversationId: string;
  workspace?: string;
  assistantId?: string | null;
};

export type HTHInjectProjectConfigResult = {
  injected: boolean;
  files: string[];
  reason?: 'assistantNotManaged' | 'workspaceMissing' | 'packageMissing' | 'projectConfigMissing';
};

export type HTHQuotaWalletSummary = {
  remain_quota: number;
  used_quota: number;
  display?: string;
};

export type HTHQuotaSubscriptionItem = {
  id: number;
  plan_id: number;
  amount_total: number;
  amount_used: number;
  amount_available: number;
  amount_available_display?: string;
  end_time: number;
};

export type HTHQuotaSubscriptionGroup = {
  group_key: 'enterprise' | 'personal';
  group_name: string;
  amount_total: number;
  amount_used: number;
  amount_available: number;
  amount_available_display?: string;
  items: HTHQuotaSubscriptionItem[];
};

export type HTHQuotaSummary = {
  wallet: HTHQuotaWalletSummary;
  subscriptions: HTHQuotaSubscriptionGroup[];
  total_available: number;
  total_available_display?: string;
  quota_apply_url?: string;
  refreshed_at: number;
};
