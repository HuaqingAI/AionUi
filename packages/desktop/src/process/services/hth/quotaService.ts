/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HTHQuotaSummary } from '@/common/types/hth';
import type { HTHAuthService } from './authService';

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
  error?: string;
  msg?: string;
};

export class HTHQuotaService {
  private cachedSummary: HTHQuotaSummary | null = null;

  constructor(private readonly authService: HTHAuthService) {}

  async getSummary(): Promise<HTHQuotaSummary | null> {
    return this.cachedSummary;
  }

  async refreshSummary(): Promise<HTHQuotaSummary> {
    const access = await this.authService.getAccess();
    const url = new URL('/api/aionui/quota-summary', access.baseUrl);
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${access.token}` },
    });
    const rawText = await response.text();
    let parsed: ApiEnvelope<HTHQuotaSummary> | HTHQuotaSummary;
    try {
      parsed = JSON.parse(rawText) as ApiEnvelope<HTHQuotaSummary> | HTHQuotaSummary;
    } catch {
      throw new Error(`hth quota request failed: ${response.status}`);
    }
    if (!response.ok) {
      const envelope = parsed as ApiEnvelope<HTHQuotaSummary>;
      throw new Error(envelope.error || envelope.msg || `hth quota request failed: ${response.status}`);
    }
    const summary = 'data' in parsed && parsed.data ? parsed.data : (parsed as HTHQuotaSummary);
    this.cachedSummary = summary;
    return summary;
  }
}
