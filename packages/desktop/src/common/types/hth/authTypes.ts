/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type HTHAuthStatus = {
  loggedIn: boolean;
  baseUrl?: string;
  email?: string;
  displayName?: string;
  username?: string;
  departments?: string[];
  personalApiKey?: {
    name: string;
    maskedKey?: string;
  };
  quotaApplyUrl?: string;
  expiresAt?: number;
  lastLoginAt?: number;
};

export type HTHStartLoginRequest = {
  baseUrl?: string;
};

export type HTHStartLoginResult = {
  state: string;
  loginUrl: string;
};

export type HTHExchangeLoginCodeRequest = {
  code: string;
  state: string;
};
