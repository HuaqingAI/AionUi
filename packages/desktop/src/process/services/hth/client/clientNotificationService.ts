/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  HTHNotificationChanged,
  HTHNotificationDetailView,
  HTHNotificationErrorCode,
  HTHNotificationMarkAllRequest,
  HTHNotificationRequest,
  HTHNotificationResult,
  HTHNotificationSnapshot,
  HTHNotificationSummary,
} from '@/common/types/hth';
import type { HTHDesktopUpdateAccess } from '../authService';
import { normalizeHTHBaseUrl } from '../baseUrl';
import type { HTHClientNotificationReadStore } from './clientNotificationReadStore';

type NotificationServiceOptions = {
  getAccess: () => Promise<HTHDesktopUpdateAccess | null>;
  readStore: Pick<HTHClientNotificationReadStore, 'load' | 'merge'>;
  fetch?: typeof fetch;
  onChanged?: (event: HTHNotificationChanged) => void;
  now?: () => number;
};

class NotificationRequestError extends Error {
  constructor(
    readonly code: HTHNotificationErrorCode,
    readonly retryAfterSeconds?: number
  ) {
    super(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSummary(value: unknown): value is HTHNotificationSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    /^ntf_[a-f0-9]{32}$/.test(value.id) &&
    typeof value.title === 'string' &&
    value.title.trim().length > 0 &&
    typeof value.summary === 'string' &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) > 0 &&
    Number.isSafeInteger(value.published_at) &&
    Number(value.published_at) > 0 &&
    Number.isSafeInteger(value.updated_at) &&
    Number(value.updated_at) > 0
  );
}

/** One desktop account's remote feed, polling lifecycle and local reading state. */
export class HTHClientNotificationService {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private access: HTHDesktopUpdateAccess | null = null;
  private contextId = randomUUID();
  private generation = 0;
  private stateVersion = 0;
  private indexBarrier = 0;
  private readonly messageEpochs = new Map<string, number>();
  private scope: string | null = null;
  private items: HTHNotificationSummary[] = [];
  private readIds = new Set<string>();
  private status: HTHNotificationSnapshot['status'] = 'idle';
  private storageStatus: HTHNotificationSnapshot['storage_status'] = 'ready';
  private errorCode: HTHNotificationErrorCode | undefined;
  private lastSyncedAt: number | null = null;
  private started = false;
  private visible = true;
  private paused = false;
  private failures = 0;
  private nextDelay = 600_000;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly controllers = new Set<AbortController>();
  private indexController: AbortController | undefined;
  private inFlight:
    | { generation: number; barrier: number; promise: Promise<HTHNotificationResult<HTHNotificationSnapshot>> }
    | undefined;

  constructor(private readonly options: NotificationServiceOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.paused = false;
    if (this.visible) void this.refresh();
  }

  stop(): void {
    this.started = false;
    this.clearTimer();
    this.resetContext(null);
    this.status = 'unauthenticated';
    this.publish();
  }

  restart(): void {
    this.stop();
    this.start();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.clearTimer();
    if (visible && this.started && !this.paused) void this.refresh();
  }

  resume(): void {
    this.clearTimer();
    if (this.started && this.visible && !this.paused) void this.refresh();
  }

  async snapshot(): Promise<HTHNotificationResult<HTHNotificationSnapshot>> {
    try {
      await this.currentAccess();
      return { success: true, data: this.getSnapshot() };
    } catch {
      this.invalidateVisible('unavailable');
      return this.failure('unavailable');
    }
  }

  async refresh(background = false): Promise<HTHNotificationResult<HTHNotificationSnapshot>> {
    try {
      const access = await this.currentAccess();
      if (!access) return this.failure('unauthenticated');
      if (this.inFlight?.generation === this.generation && this.inFlight.barrier === this.indexBarrier) {
        return this.inFlight.promise;
      }
      this.clearTimer();
      this.paused = false;
      if (!background || this.status !== 'ready') {
        this.status = 'loading';
        this.publish();
      }
      const generation = this.generation;
      const barrier = this.indexBarrier;
      const promise = this.refreshIndex(access, generation, barrier);
      this.inFlight = { generation, barrier, promise };
      void promise.finally(() => {
        if (this.inFlight?.promise !== promise) return;
        this.inFlight = undefined;
        if (this.started && this.visible && !this.paused) {
          this.timer = setTimeout(() => void this.refresh(true), this.nextDelay);
        }
      });
      return promise;
    } catch {
      this.invalidateVisible('unavailable');
      return this.failure('unavailable');
    }
  }

  async detail(request: HTHNotificationRequest): Promise<HTHNotificationResult<HTHNotificationDetailView>> {
    let operationAccess: HTHDesktopUpdateAccess | null = null;
    let operationGeneration = this.generation;
    let operationEpoch: number | undefined;
    try {
      const access = await this.currentAccess();
      if (!access) return this.failure('unauthenticated');
      operationAccess = access;
      operationGeneration = this.generation;
      if (!request || request.context_id !== this.contextId) return this.failure('stale_context');
      const previous = this.items.find((item) => item.id === request.id);
      if (!previous || this.status !== 'ready') return this.failure('not_found');
      const generation = this.generation;
      const epoch = this.messageEpochs.get(request.id) ?? 0;
      operationEpoch = epoch;
      const data = await this.request(`/api/aionui/notifications/${request.id}`, access, 'not_found');
      if (!(await this.isCurrent(access, generation))) return this.failure('stale_context');
      const current = this.items.find((item) => item.id === request.id);
      if (!current || epoch !== (this.messageEpochs.get(request.id) ?? 0) || this.status !== 'ready') {
        return this.failure('stale_context');
      }
      if (!isSummary(data) || data.id !== request.id || !('content' in data) || typeof data.content !== 'string') {
        throw new NotificationRequestError('invalid_response');
      }
      if (data.version < current.version) return this.failure('stale_context');
      if (data.version > current.version) {
        this.items = this.items.map((item) => (item.id === data.id ? this.summary(data) : item));
        this.messageEpochs.set(data.id, epoch + 1);
        this.invalidateIndex();
        this.publish();
      }
      return { success: true, data: { ...this.summary(data), content: data.content, context_id: this.contextId } };
    } catch (error) {
      const code = error instanceof NotificationRequestError ? error.code : 'unavailable';
      if (operationAccess && !(await this.isCurrent(operationAccess, operationGeneration))) {
        return this.failure('stale_context');
      }
      if (request?.context_id !== this.contextId) return this.failure('stale_context');
      if (operationEpoch !== undefined && operationEpoch !== (this.messageEpochs.get(request.id) ?? 0)) {
        return this.failure('stale_context');
      }
      if (code === 'not_found') {
        this.items = this.items.filter((item) => item.id !== request.id);
        this.messageEpochs.set(request.id, (this.messageEpochs.get(request.id) ?? 0) + 1);
        this.invalidateIndex();
        this.publish();
      } else if (code !== 'stale_context') {
        this.invalidateVisible(code);
      }
      return this.failure(code);
    }
  }

  markRead(request: HTHNotificationRequest): Promise<HTHNotificationResult<HTHNotificationSnapshot>> {
    return this.markAllRead({ context_id: request?.context_id, ids: request ? [request.id] : [] });
  }

  async markAllRead(request: HTHNotificationMarkAllRequest): Promise<HTHNotificationResult<HTHNotificationSnapshot>> {
    try {
      const access = await this.currentAccess();
      if (!access) return this.failure('unauthenticated');
      if (!request || request.context_id !== this.contextId || !this.scope) return this.failure('stale_context');
      if (this.status !== 'ready' || !Array.isArray(request.ids)) return this.failure('unavailable');
      const visible = new Set(this.items.map((item) => item.id));
      const ids = request.ids.filter((id) => visible.has(id));
      const scope = this.scope;
      const generation = this.generation;
      const state = await this.options.readStore.merge(scope, ids);
      if (!(await this.isCurrent(access, generation)) || scope !== this.scope) return this.failure('stale_context');
      // Merge again with the latest in-memory state: another queued write may have completed first.
      state.ids.forEach((id) => this.readIds.add(id));
      this.storageStatus = state.recovered ? 'recovered' : 'ready';
      this.errorCode = undefined;
      this.publish();
      return { success: true, data: this.getSnapshot() };
    } catch (error) {
      if (request?.context_id !== this.contextId) return this.failure('stale_context');
      if (error instanceof NotificationRequestError) return this.failure(error.code);
      this.storageStatus = 'unavailable';
      this.errorCode = 'storage_failed';
      this.publish();
      return this.failure('storage_failed');
    }
  }

  private async refreshIndex(
    access: HTHDesktopUpdateAccess,
    generation: number,
    barrier: number
  ): Promise<HTHNotificationResult<HTHNotificationSnapshot>> {
    try {
      const data = await this.request('/api/aionui/notifications', access, 'unsupported', true);
      if (!(await this.isCurrent(access, generation)) || barrier !== this.indexBarrier) {
        return this.failure('stale_context');
      }
      if (
        !isRecord(data) ||
        typeof data.viewer_scope !== 'string' ||
        !/^user:[1-9]\d*$/.test(data.viewer_scope) ||
        !Array.isArray(data.items) ||
        !data.items.every(isSummary) ||
        data.total !== data.items.length ||
        new Set(data.items.map((item) => item.id)).size !== data.items.length
      ) {
        throw new NotificationRequestError('invalid_response');
      }
      const scope = JSON.stringify([normalizeHTHBaseUrl(access.baseUrl), data.viewer_scope]);
      if (this.scope !== null && this.scope !== scope) {
        this.resetContext(access);
        void this.refresh();
        return this.failure('stale_context');
      }
      if (!this.scope || this.storageStatus === 'unavailable') {
        const stored = await this.options.readStore.load(scope);
        if (!(await this.isCurrent(access, generation)) || barrier !== this.indexBarrier) {
          return this.failure('stale_context');
        }
        this.scope = scope;
        stored.ids.forEach((id) => this.readIds.add(id));
        this.storageStatus = stored.recovered ? 'recovered' : 'ready';
      }
      const next = data.items;
      for (const old of this.items) {
        const replacement = next.find((item) => item.id === old.id);
        if (replacement && replacement.version < old.version) throw new NotificationRequestError('invalid_response');
        if (!replacement || replacement.version > old.version) {
          this.messageEpochs.set(old.id, (this.messageEpochs.get(old.id) ?? 0) + 1);
        }
      }
      this.items = next.map((item) => this.summary(item));
      this.status = 'ready';
      this.errorCode = undefined;
      this.lastSyncedAt = this.now();
      this.failures = 0;
      this.nextDelay = 600_000;
      this.publish();
      return { success: true, data: this.getSnapshot() };
    } catch (error) {
      if (!(await this.isCurrent(access, generation)) || barrier !== this.indexBarrier) {
        return this.failure('stale_context');
      }
      const code = error instanceof NotificationRequestError ? error.code : 'storage_failed';
      if (code === 'storage_failed') this.storageStatus = 'unavailable';
      this.failures += 1;
      this.nextDelay =
        error instanceof NotificationRequestError && error.retryAfterSeconds !== undefined
          ? Math.max(1000, error.retryAfterSeconds * 1000)
          : [60_000, 120_000, 300_000][Math.min(this.failures - 1, 2)];
      this.invalidateVisible(code);
      return this.failure(code, error instanceof NotificationRequestError ? error.retryAfterSeconds : undefined);
    }
  }

  private async request(
    pathname: string,
    access: HTHDesktopUpdateAccess,
    missing: 'unsupported' | 'not_found',
    index = false
  ): Promise<unknown> {
    const controller = new AbortController();
    this.controllers.add(controller);
    if (index) this.indexController = controller;
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetchFn(new URL(pathname, access.baseUrl), {
        headers: { Authorization: `Bearer ${access.token}`, Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
      });
      if (response.status === 401) throw new NotificationRequestError('unauthenticated');
      if (response.status === 403) throw new NotificationRequestError('forbidden');
      if (response.status === 404) throw new NotificationRequestError(missing);
      if (!response.ok) {
        const retryAfter = response.headers.get('Retry-After');
        const retrySeconds = retryAfter === null ? NaN : Number(retryAfter);
        const retryDate = retryAfter === null ? NaN : Date.parse(retryAfter);
        const delay = Number.isFinite(retrySeconds)
          ? Math.max(0, retrySeconds)
          : Number.isFinite(retryDate)
            ? Math.max(0, Math.ceil((retryDate - this.now()) / 1000))
            : undefined;
        throw new NotificationRequestError('unavailable', response.status === 429 ? delay : undefined);
      }
      let envelope: unknown;
      try {
        envelope = await response.json();
      } catch {
        throw new NotificationRequestError('invalid_response');
      }
      if (!isRecord(envelope) || envelope.success !== true || !('data' in envelope)) {
        throw new NotificationRequestError('invalid_response');
      }
      return envelope.data;
    } catch (error) {
      if (error instanceof NotificationRequestError) throw error;
      throw new NotificationRequestError('unavailable');
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      if (this.indexController === controller) this.indexController = undefined;
    }
  }

  private async currentAccess(): Promise<HTHDesktopUpdateAccess | null> {
    let access: HTHDesktopUpdateAccess | null;
    try {
      access = await this.options.getAccess();
    } catch {
      this.resetContext(null);
      this.invalidateVisible('unavailable');
      throw new NotificationRequestError('unavailable');
    }
    if (access?.baseUrl !== this.access?.baseUrl || access?.token !== this.access?.token) {
      this.resetContext(access);
      this.publish();
    }
    if (!access) {
      this.status = 'unauthenticated';
      this.paused = true;
    }
    return access;
  }

  private async isCurrent(access: HTHDesktopUpdateAccess, generation: number): Promise<boolean> {
    try {
      const current = await this.currentAccess();
      return generation === this.generation && current?.baseUrl === access.baseUrl && current?.token === access.token;
    } catch {
      this.invalidateVisible('unavailable');
      return false;
    }
  }

  private resetContext(access: HTHDesktopUpdateAccess | null): void {
    this.generation += 1;
    this.indexBarrier += 1;
    this.controllers.forEach((controller) => controller.abort());
    this.clearTimer();
    this.contextId = randomUUID();
    this.access = access;
    this.scope = null;
    this.items = [];
    this.readIds.clear();
    this.messageEpochs.clear();
    this.status = access ? 'idle' : 'unauthenticated';
    this.storageStatus = 'ready';
    this.errorCode = undefined;
    this.lastSyncedAt = null;
    this.failures = 0;
    this.paused = false;
  }

  private invalidateIndex(): void {
    this.indexBarrier += 1;
    this.indexController?.abort();
    // A request that began before a 404/version barrier must never satisfy this refresh.
    void this.refresh(true);
  }

  private invalidateVisible(code: HTHNotificationErrorCode): void {
    for (const item of this.items) this.messageEpochs.set(item.id, (this.messageEpochs.get(item.id) ?? 0) + 1);
    this.items = [];
    this.status =
      code === 'unauthenticated' || code === 'forbidden'
        ? 'unauthenticated'
        : code === 'unsupported'
          ? 'unsupported'
          : 'unavailable';
    this.errorCode = code;
    if (['unauthenticated', 'forbidden', 'unsupported'].includes(code)) this.paused = true;
    this.publish();
  }

  private getSnapshot(): HTHNotificationSnapshot {
    return {
      context_id: this.contextId,
      state_version: this.stateVersion,
      status: this.status,
      items: this.status === 'ready' ? this.items.map((item) => ({ ...item, is_read: this.readIds.has(item.id) })) : [],
      unread_count: this.status === 'ready' ? this.items.filter((item) => !this.readIds.has(item.id)).length : null,
      last_synced_at: this.lastSyncedAt,
      storage_status: this.storageStatus,
      ...(this.errorCode ? { error_code: this.errorCode } : {}),
    };
  }

  private failure<T>(code: HTHNotificationErrorCode, retryAfterSeconds?: number): HTHNotificationResult<T> {
    return {
      success: false,
      code,
      snapshot: this.getSnapshot(),
      ...(retryAfterSeconds === undefined ? {} : { retry_after_seconds: retryAfterSeconds }),
    };
  }

  private summary(item: HTHNotificationSummary): HTHNotificationSummary {
    return {
      id: item.id,
      title: item.title,
      summary: item.summary,
      version: item.version,
      published_at: item.published_at,
      updated_at: item.updated_at,
    };
  }

  private publish(): void {
    this.stateVersion += 1;
    try {
      this.options.onChanged?.({ context_id: this.contextId, state_version: this.stateVersion });
    } catch {
      console.warn('[HTHNotifications] Failed to publish notification state');
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
