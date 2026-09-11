/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron';
import type { HTHAuthService } from './authService';
import { resolveAionUiClientPlatform, resolvePreferredLanIPv4 } from './clientEnvironment';

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const RATE_LIMIT_RETRY_DELAY_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

type ClientHeartbeatServiceOptions = {
  appVersion?: () => string;
  fetch?: typeof fetch;
  resolvePlatform?: () => ReturnType<typeof resolveAionUiClientPlatform>;
  resolveLanIP?: () => string;
};

export class HTHClientHeartbeatService {
  private readonly appVersion: () => string;
  private readonly fetchFn: typeof fetch;
  private readonly resolvePlatform: () => ReturnType<typeof resolveAionUiClientPlatform>;
  private readonly resolveLanIP: () => string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private started = false;
  private inFlight = false;
  private retryAttempt = 0;
  private runId = 0;

  constructor(
    private readonly authService: HTHAuthService,
    options: ClientHeartbeatServiceOptions = {}
  ) {
    this.appVersion = options.appVersion ?? (() => app.getVersion());
    this.fetchFn = options.fetch ?? fetch;
    this.resolvePlatform = options.resolvePlatform ?? resolveAionUiClientPlatform;
    this.resolveLanIP = options.resolveLanIP ?? resolvePreferredLanIPv4;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.runId += 1;
    void this.reportAndSchedule(this.runId);
  }

  stop(): void {
    this.started = false;
    this.runId += 1;
    this.retryAttempt = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.controller?.abort();
    this.controller = undefined;
  }

  resume(): void {
    if (!this.started) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      return;
    }
    void this.reportAndSchedule(this.runId);
  }

  private async reportAndSchedule(runId: number): Promise<void> {
    if (!this.isCurrentRun(runId) || this.inFlight) {
      return;
    }
    this.inFlight = true;
    let nextDelay = HEARTBEAT_INTERVAL_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let requestController: AbortController | undefined;
    try {
      const status = await this.authService.getStatus();
      if (!this.isCurrentRun(runId)) {
        return;
      }
      if (!status.loggedIn) {
        this.stop();
        return;
      }
      const platform = this.resolvePlatform();
      if (!platform) {
        console.warn('[HTHClientHeartbeat] Skipping unsupported platform', {
          platform: process.platform,
          arch: process.arch,
        });
        this.stop();
        return;
      }
      const access = await this.authService.getAccess();
      if (!this.isCurrentRun(runId)) {
        return;
      }
      requestController = new AbortController();
      this.controller = requestController;
      timeout = setTimeout(() => {
        timedOut = true;
        requestController?.abort();
      }, REQUEST_TIMEOUT_MS);
      const response = await this.fetchFn(new URL('/api/aionui/clients/heartbeat', access.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_version: this.appVersion(),
          platform,
          lan_ip: this.resolveLanIP(),
          user: {
            email: access.email,
            name: access.displayName || access.username || access.email,
            departments: access.departments ?? [],
          },
        }),
        signal: requestController.signal,
      });
      if (!this.isCurrentRun(runId)) {
        return;
      }

      if (response.ok) {
        this.retryAttempt = 0;
        nextDelay = await this.nextHeartbeatDelay(response);
        return;
      }
      if (response.status === 401 || response.status === 403) {
        this.stop();
        return;
      }
      if (response.status === 400) {
        this.retryAttempt = 0;
        console.warn('[HTHClientHeartbeat] Server rejected heartbeat payload');
        return;
      }
      nextDelay = this.nextRetryDelay(
        response.headers.get('Retry-After'),
        response.status === 429 ? RATE_LIMIT_RETRY_DELAY_MS : undefined
      );
      console.warn('[HTHClientHeartbeat] Heartbeat request failed', { status: response.status });
    } catch (error) {
      if (this.isCurrentRun(runId) && (!requestController?.signal.aborted || timedOut)) {
        nextDelay = this.nextRetryDelay();
        console.warn('[HTHClientHeartbeat] Heartbeat request failed', error);
      }
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (this.controller === requestController) {
        this.controller = undefined;
      }
      this.inFlight = false;
      if (this.started && runId !== this.runId) {
        void this.reportAndSchedule(this.runId);
      } else if (this.isCurrentRun(runId)) {
        this.schedule(nextDelay);
      }
    }
  }

  private schedule(delay: number): void {
    if (!this.started) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reportAndSchedule(this.runId);
    }, delay);
  }

  private isCurrentRun(runId: number): boolean {
    return this.started && runId === this.runId;
  }

  private async nextHeartbeatDelay(response: Response): Promise<number> {
    try {
      const payload = (await response.json()) as {
        data?: { next_heartbeat_seconds?: unknown };
      };
      const seconds = payload.data?.next_heartbeat_seconds;
      if (
        typeof seconds === 'number' &&
        Number.isInteger(seconds) &&
        seconds * 1000 >= MIN_HEARTBEAT_INTERVAL_MS &&
        seconds * 1000 <= MAX_HEARTBEAT_INTERVAL_MS
      ) {
        return seconds * 1000;
      }
    } catch {
      // A valid 2xx response without JSON still uses the normal interval.
    }
    return HEARTBEAT_INTERVAL_MS;
  }

  private nextRetryDelay(retryAfter?: string | null, fallbackDelay?: number): number {
    const retryAfterSeconds = parseRetryAfter(retryAfter);
    if (retryAfterSeconds !== undefined) {
      return retryAfterSeconds * 1000;
    }
    if (fallbackDelay !== undefined) {
      return fallbackDelay;
    }
    const delay = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)];
    this.retryAttempt += 1;
    return delay;
  }
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isInteger(seconds) && seconds >= 0) {
    return seconds;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}
