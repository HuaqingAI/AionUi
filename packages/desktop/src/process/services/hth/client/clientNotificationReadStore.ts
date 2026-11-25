/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type NotificationReadState = { ids: string[]; recovered: boolean };

/** Account-scoped, atomic local reading records. Missing feed entries are deliberately retained. */
export class HTHClientNotificationReadStore {
  private readonly states = new Map<string, NotificationReadState>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string) {}

  load(scope: string): Promise<NotificationReadState> {
    return this.enqueue(scope, () => this.loadState(scope));
  }

  merge(scope: string, ids: string[]): Promise<NotificationReadState> {
    return this.enqueue(scope, async () => {
      const previous = await this.loadState(scope);
      const next = [...new Set([...previous.ids, ...ids])];
      if (next.length === previous.ids.length) return previous;
      await fs.mkdir(this.directory, { recursive: true });
      const target = this.filePath(scope);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ schema_version: 1, read_ids: next }), {
          encoding: 'utf8',
          mode: 0o600,
        });
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true }).catch((): void => undefined);
      }
      const state = { ids: next, recovered: previous.recovered };
      this.states.set(scope, state);
      return { ...state, ids: [...state.ids] };
    });
  }

  private filePath(scope: string): string {
    return path.join(this.directory, `${createHash('sha256').update(scope).digest('hex')}.json`);
  }

  private enqueue(scope: string, operation: () => Promise<NotificationReadState>): Promise<NotificationReadState> {
    const pending = (this.queues.get(scope) ?? Promise.resolve()).catch((): void => undefined).then(operation);
    this.queues.set(scope, pending);
    return pending.finally(() => {
      if (this.queues.get(scope) === pending) this.queues.delete(scope);
    });
  }

  private async loadState(scope: string): Promise<NotificationReadState> {
    const cached = this.states.get(scope);
    if (cached) return { ...cached, ids: [...cached.ids] };
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath(scope), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const state: NotificationReadState = { ids: [], recovered: false };
      this.states.set(scope, state);
      return state;
    }
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
    if (typeof stored === 'object' && stored !== null && 'schema_version' in stored && stored.schema_version !== 1) {
      throw new Error('Unsupported notification reading record version');
    }
    if (
      typeof stored === 'object' &&
      stored !== null &&
      'schema_version' in stored &&
      stored.schema_version === 1 &&
      'read_ids' in stored &&
      Array.isArray(stored.read_ids) &&
      stored.read_ids.every((id: unknown) => typeof id === 'string' && /^ntf_[a-f0-9]{32}$/.test(id))
    ) {
      const state = { ids: [...new Set<string>(stored.read_ids)], recovered: false };
      this.states.set(scope, state);
      return { ...state, ids: [...state.ids] };
    }
    // Keep the original bytes for diagnosis instead of silently discarding reading history.
    await fs.rename(this.filePath(scope), `${this.filePath(scope)}.${randomUUID()}.corrupt`);
    const state: NotificationReadState = { ids: [], recovered: true };
    this.states.set(scope, state);
    return state;
  }
}
