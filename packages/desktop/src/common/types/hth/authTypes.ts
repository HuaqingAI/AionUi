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

export type HTHStartLoginResult =
  | {
      outcome: 'started';
      state: string;
      loginUrl: string;
    }
  | {
      outcome: 'default-browser-unavailable';
    };

export type HTHExchangeLoginCodeRequest = {
  code: string;
  state: string;
};

export type HTHUploadClientLogsRequest = {
  date: string;
};

export type HTHUploadClientLogsResult =
  | {
      outcome: 'uploaded';
      date: string;
      fileCount: number;
      totalBytes: number;
    }
  | {
      outcome: 'no-files';
      date: string;
    }
  | {
      outcome: 'not-logged-in';
      date: string;
    }
  | {
      outcome: 'failed';
      date: string;
      code: 'invalid-date' | 'local-limit' | 'rate-limited' | 'server-rejected' | 'network' | 'server';
      retryAfterSeconds?: number;
    };
