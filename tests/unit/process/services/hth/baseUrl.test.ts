import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_HTH_BASE_URL,
  PROD_HTH_BASE_URL,
  getHTHAuthFilePath,
  readStoredHTHBaseUrl,
  resolveDefaultHTHBaseUrl,
  resolveHTHBaseUrl,
} from '../../../../../packages/desktop/src/process/services/hth/baseUrl';

const electronState = vi.hoisted(() => ({
  isPackaged: false,
  userData: '',
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getPath: vi.fn(() => electronState.userData),
  },
}));

describe('hth base url', () => {
  beforeEach(() => {
    electronState.isPackaged = false;
    electronState.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-hth-base-'));
    delete process.env.AIONUI_HTH_BASE_URL;
    delete process.env.VITE_HTH_BASE_URL;
  });

  afterEach(() => {
    fs.rmSync(electronState.userData, { recursive: true, force: true });
    delete process.env.AIONUI_HTH_BASE_URL;
    delete process.env.VITE_HTH_BASE_URL;
  });

  it('uses local new-api by default in development', () => {
    expect(resolveDefaultHTHBaseUrl()).toBe(DEV_HTH_BASE_URL);
  });

  it('uses production hth by default when packaged', () => {
    electronState.isPackaged = true;

    expect(resolveDefaultHTHBaseUrl()).toBe(PROD_HTH_BASE_URL);
  });

  it('prefers explicit environment configuration', () => {
    electronState.isPackaged = true;
    process.env.AIONUI_HTH_BASE_URL = 'https://custom.example.com/';

    expect(resolveDefaultHTHBaseUrl()).toBe('https://custom.example.com');
  });

  it('uses the stored login base url when present', () => {
    const authFile = getHTHAuthFilePath();
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify({ baseUrl: 'https://hth.example.com/' }), 'utf8');

    expect(readStoredHTHBaseUrl()).toBe('https://hth.example.com');
    expect(resolveHTHBaseUrl()).toBe('https://hth.example.com');
  });

  it('keeps explicit environment configuration ahead of stored login base url', () => {
    process.env.AIONUI_HTH_BASE_URL = 'https://env.example.com/';
    const authFile = getHTHAuthFilePath();
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify({ baseUrl: 'https://stored.example.com/' }), 'utf8');

    expect(resolveHTHBaseUrl()).toBe('https://env.example.com');
  });
});
