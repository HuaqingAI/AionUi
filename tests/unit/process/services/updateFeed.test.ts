import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveUpdateFeedBaseUrl } from '../../../../packages/desktop/src/process/services/updateFeed';

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

describe('update feed', () => {
  beforeEach(() => {
    electronState.isPackaged = false;
    electronState.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-update-feed-'));
    delete process.env.AIONUI_UPDATE_FEED_URL;
    delete process.env.AIONUI_HTH_BASE_URL;
    delete process.env.VITE_HTH_BASE_URL;
  });

  afterEach(() => {
    fs.rmSync(electronState.userData, { recursive: true, force: true });
    delete process.env.AIONUI_UPDATE_FEED_URL;
    delete process.env.AIONUI_HTH_BASE_URL;
    delete process.env.VITE_HTH_BASE_URL;
  });

  it('builds client update feed from the stored hth base url', () => {
    const authFile = path.join(electronState.userData, 'hth', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify({ baseUrl: 'https://hth.huaqing.run/' }), 'utf8');

    expect(resolveUpdateFeedBaseUrl()).toBe('https://hth.huaqing.run/api/aionui/client-updates');
  });

  it('keeps explicit update feed override authoritative', () => {
    process.env.AIONUI_UPDATE_FEED_URL = 'https://updates.example.com/releases/';

    expect(resolveUpdateFeedBaseUrl()).toBe('https://updates.example.com/releases');
  });
});
