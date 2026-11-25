/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HTHClientNotificationReadStore } from '@/process/services/hth/client/clientNotificationReadStore';

const FIRST_ID = `ntf_${'1'.repeat(32)}`;
const SECOND_ID = `ntf_${'2'.repeat(32)}`;
let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aion-notifications-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('notification reading records', () => {
  it('persists the union of simultaneous reads and restores it after restart', async () => {
    const store = new HTHClientNotificationReadStore(directory);
    await Promise.all([store.merge('account-a', [FIRST_ID]), store.merge('account-a', [SECOND_ID, FIRST_ID])]);

    const restored = await new HTHClientNotificationReadStore(directory).load('account-a');
    expect(restored.ids).toEqual([FIRST_ID, SECOND_ID]);
    expect(await fs.readdir(directory)).toHaveLength(1);
  });

  it('keeps service and account scopes separate without using them as filesystem paths', async () => {
    const store = new HTHClientNotificationReadStore(directory);
    await store.merge('../../a', [FIRST_ID]);

    expect((await store.load('other-account')).ids).toEqual([]);
    expect(await fs.readdir(directory)).toEqual([`${createHash('sha256').update('../../a').digest('hex')}.json`]);
  });

  it('does not remove a historical reading record when no current messages are supplied', async () => {
    const store = new HTHClientNotificationReadStore(directory);
    await store.merge('account', [FIRST_ID]);
    await store.merge('account', []);

    expect((await new HTHClientNotificationReadStore(directory).load('account')).ids).toEqual([FIRST_ID]);
  });

  it('preserves corrupted bytes in a backup and reports recovery', async () => {
    const file = path.join(directory, `${createHash('sha256').update('account').digest('hex')}.json`);
    await fs.writeFile(file, '{broken');

    expect(await new HTHClientNotificationReadStore(directory).load('account')).toEqual({ ids: [], recovered: true });
    const files = await fs.readdir(directory);
    expect(await fs.readFile(path.join(directory, files[0]), 'utf8')).toBe('{broken');
    expect(files[0]).toMatch(/\.corrupt$/);
  });

  it('does not overwrite a newer storage format', async () => {
    const file = path.join(directory, `${createHash('sha256').update('account').digest('hex')}.json`);
    const contents = JSON.stringify({ schema_version: 2, read_ids: [FIRST_ID], future: true });
    await fs.writeFile(file, contents);

    await expect(new HTHClientNotificationReadStore(directory).merge('account', [SECOND_ID])).rejects.toThrow(
      'Unsupported notification reading record version'
    );
    expect(await fs.readFile(file, 'utf8')).toBe(contents);
  });

  it('retains the last successful records when atomic replacement fails', async () => {
    const store = new HTHClientNotificationReadStore(directory);
    await store.merge('account', [FIRST_ID]);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(store.merge('account', [SECOND_ID])).rejects.toThrow('disk unavailable');
    expect((await new HTHClientNotificationReadStore(directory).load('account')).ids).toEqual([FIRST_ID]);
    expect(await fs.readdir(directory)).toHaveLength(1);
  });
});
