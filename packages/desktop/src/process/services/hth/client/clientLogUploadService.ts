/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import type { HTHUploadClientLogsRequest, HTHUploadClientLogsResult } from '@/common/types/hth';
import type { HTHAuthService } from '../authService';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 50;
const REQUEST_TIMEOUT_MS = 120 * 1000;

type ClientLogFileSystem = Pick<typeof fs, 'lstat' | 'readFile' | 'readdir'>;

type ClientLogUploadServiceOptions = {
  appVersion?: () => string;
  fetch?: typeof fetch;
  fileSystem?: ClientLogFileSystem;
  logRoot?: () => string;
  now?: () => Date;
};

type LocalLogDate = {
  day: string;
  month: string;
  value: string;
  year: string;
};

type LocalLogFile = {
  name: string;
  path: string;
  size: number;
};

type ReadLocalLogFile = LocalLogFile & {
  content: Buffer;
};

type UploadEnvelope = {
  data?: {
    file_count?: unknown;
    total_bytes?: unknown;
  };
  success?: unknown;
};

export class HTHClientLogUploadService {
  private readonly appVersion: () => string;
  private readonly fetchFn: typeof fetch;
  private readonly fileSystem: ClientLogFileSystem;
  private readonly logRoot: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly authService: Pick<HTHAuthService, 'getDesktopUpdateAccess'>,
    options: ClientLogUploadServiceOptions = {}
  ) {
    this.appVersion = options.appVersion ?? (() => app.getVersion());
    this.fetchFn = options.fetch ?? fetch;
    this.fileSystem = options.fileSystem ?? fs;
    this.logRoot = options.logRoot ?? (() => app.getPath('logs'));
    this.now = options.now ?? (() => new Date());
  }

  async upload(request: HTHUploadClientLogsRequest): Promise<HTHUploadClientLogsResult> {
    const date = parseLocalLogDate(request?.date, this.now());
    if (!date) {
      return failedUpload(request?.date, 'invalid-date');
    }

    const candidates = await this.findLocalLogFiles(date);
    if (candidates.outcome === 'no-files') {
      return { outcome: 'no-files', date: date.value };
    }
    if (candidates.outcome === 'failed') {
      return failedUpload(date.value, candidates.code);
    }

    const files = await this.readLocalLogFiles(candidates.files);
    if (!files) {
      return failedUpload(date.value, 'local-limit');
    }

    let access: Awaited<ReturnType<HTHAuthService['getDesktopUpdateAccess']>>;
    try {
      access = await this.authService.getDesktopUpdateAccess();
    } catch {
      return { outcome: 'not-logged-in', date: date.value };
    }
    if (!access) {
      return { outcome: 'not-logged-in', date: date.value };
    }

    const form = new FormData();
    for (const file of files) {
      const bytes = file.content.buffer.slice(
        file.content.byteOffset,
        file.content.byteOffset + file.content.byteLength
      ) as ArrayBuffer;
      form.append('files', new Blob([bytes], { type: 'application/octet-stream' }), file.name);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchFn(new URL(`/api/aionui/client-logs/${date.value}`, access.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access.token}`,
          'X-AionUI-Client-Version': this.appVersion(),
        },
        body: form,
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return { outcome: 'not-logged-in', date: date.value };
      }
      if (response.status === 429) {
        return {
          outcome: 'failed',
          date: date.value,
          code: 'rate-limited',
          retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
        };
      }
      if (response.status === 413 || response.status === 400 || response.status === 415) {
        return failedUpload(date.value, 'server-rejected');
      }
      if (!response.ok) {
        return failedUpload(date.value, 'server');
      }

      const envelope = await readUploadEnvelope(response);
      if (!envelope || envelope.success !== true) {
        return failedUpload(date.value, 'server-rejected');
      }
      const fileCount = envelope.data?.file_count;
      const totalBytes = envelope.data?.total_bytes;
      if (!isSafeNonNegativeInteger(fileCount) || !isSafeNonNegativeInteger(totalBytes)) {
        return failedUpload(date.value, 'server-rejected');
      }
      return { outcome: 'uploaded', date: date.value, fileCount, totalBytes };
    } catch {
      return failedUpload(date.value, 'network');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async findLocalLogFiles(
    date: LocalLogDate
  ): Promise<
    { outcome: 'no-files' } | { outcome: 'failed'; code: 'local-limit' } | { outcome: 'ready'; files: LocalLogFile[] }
  > {
    const logDirectory = path.join(this.logRoot(), date.year, date.month, date.day);
    let directory;
    try {
      directory = await this.fileSystem.lstat(logDirectory);
    } catch (error) {
      return isMissingFile(error) ? { outcome: 'no-files' } : { outcome: 'failed', code: 'local-limit' };
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      return { outcome: 'no-files' };
    }

    let entries;
    try {
      entries = await this.fileSystem.readdir(logDirectory, { withFileTypes: true });
    } catch {
      return { outcome: 'failed', code: 'local-limit' };
    }

    const files: LocalLogFile[] = [];
    let totalBytes = 0;
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(logDirectory, entry.name);
      let stat;
      try {
        stat = await this.fileSystem.lstat(filePath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        continue;
      }
      if (!isSafePositiveInteger(stat.size) || stat.size > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES - stat.size) {
        return { outcome: 'failed', code: 'local-limit' };
      }
      if (files.length >= MAX_FILES) {
        return { outcome: 'failed', code: 'local-limit' };
      }
      totalBytes += stat.size;
      files.push({ name: entry.name, path: filePath, size: stat.size });
    }
    return files.length > 0 ? { outcome: 'ready', files } : { outcome: 'no-files' };
  }

  private async readLocalLogFiles(candidates: LocalLogFile[]): Promise<ReadLocalLogFile[] | null> {
    const files: ReadLocalLogFile[] = [];
    let totalBytes = 0;
    for (const candidate of candidates) {
      let content: Buffer;
      try {
        content = await this.fileSystem.readFile(candidate.path);
      } catch {
        return null;
      }
      if (
        content.byteLength !== candidate.size ||
        !isSafePositiveInteger(content.byteLength) ||
        content.byteLength > MAX_FILE_BYTES ||
        totalBytes > MAX_TOTAL_BYTES - content.byteLength
      ) {
        return null;
      }
      totalBytes += content.byteLength;
      files.push({ ...candidate, content });
    }
    return files;
  }
}

function parseLocalLogDate(value: unknown, now: Date): LocalLogDate | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  const localToday = `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (value > localToday) {
    return null;
  }
  return { year: match[1], month: match[2], day: match[3], value };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function failedUpload(
  date: unknown,
  code: Extract<HTHUploadClientLogsResult, { outcome: 'failed' }>['code']
): Extract<HTHUploadClientLogsResult, { outcome: 'failed' }> {
  return { outcome: 'failed', date: typeof date === 'string' ? date : '', code };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isInteger(seconds) && seconds >= 0) {
    return Math.min(seconds, 24 * 60 * 60);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, Math.ceil((date - Date.now()) / 1000)), 24 * 60 * 60);
}

async function readUploadEnvelope(response: Response): Promise<UploadEnvelope | null> {
  try {
    return (await response.json()) as UploadEnvelope;
  } catch {
    return null;
  }
}
