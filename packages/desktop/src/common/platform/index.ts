import path from 'path';
import { APP_DISPLAY_NAME } from '../config/constants';
import type { IPlatformServices } from './IPlatformServices';
import { NodePlatformServices } from './NodePlatformServices';

let _services: IPlatformServices | null = null;

export { APP_DISPLAY_NAME };
export const PRODUCTION_APP_NAME = 'HQBuddy';
export const DEVELOPMENT_APP_NAME = 'HQBuddy-Dev';
export const PRODUCTION_APP_USER_MODEL_ID = 'com.hqbuddy.app';
export const DEVELOPMENT_APP_USER_MODEL_ID = 'com.hqbuddy.app.dev';

/**
 * Resolve the dev-mode app name for environment isolation.
 * Centralised so that every call-site stays in sync.
 */
export function getDevAppName(): string {
  const isMultiInstance = process.env.AIONUI_MULTI_INSTANCE === '1';
  return isMultiInstance ? `${DEVELOPMENT_APP_NAME}-2` : DEVELOPMENT_APP_NAME;
}

/** Resolve the filesystem name used by the current Electron runtime. */
export function getAppFilesystemName(isPackaged: boolean, executablePath = process.execPath): string {
  if (!isPackaged) return getDevAppName();

  const executableName = executablePath
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.exe$/i, '');
  return executableName === DEVELOPMENT_APP_NAME ? DEVELOPMENT_APP_NAME : PRODUCTION_APP_NAME;
}

/** Resolve the Windows notification identity for the active build flavor. */
export function getAppUserModelId(isPackaged: boolean, executablePath = process.execPath): string {
  return getAppFilesystemName(isPackaged, executablePath) === PRODUCTION_APP_NAME
    ? PRODUCTION_APP_USER_MODEL_ID
    : DEVELOPMENT_APP_USER_MODEL_ID;
}

/** Path of the development Start Menu shortcut that registers its Windows toast identity. */
export function getWindowsDevelopmentShortcutPath(appDataPath: string): string {
  return path.join(
    appDataPath,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    DEVELOPMENT_APP_NAME,
    `${APP_DISPLAY_NAME}.lnk`
  );
}

export function registerPlatformServices(services: IPlatformServices): void {
  _services = services;
}

export function getPlatformServices(): IPlatformServices {
  if (!_services) {
    // In Electron, module-level code in initStorage.ts may execute before the
    // explicit registerPlatformServices(new ElectronPlatformServices()) call
    // because Rollup places the shared chunk require() ahead of side-effect
    // imports in the bundled output. Auto-register an inline implementation using
    // electron.app directly so that all platform API callers work regardless of
    // call order. This will be replaced by the proper ElectronPlatformServices
    // once registerPlatformServices() is called.
    if (process.versions?.electron) {
      // In Electron utility processes process.type === 'utility' and app is not
      // accessible. Fall back to NodePlatformServices (DATA_DIR is injected by
      // ElectronPlatformServices.fork so paths still resolve correctly).
      const processType = (process as NodeJS.Process & { type?: string }).type;
      if (processType !== 'browser') {
        _services = new NodePlatformServices();
      } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app, net } = require('electron') as typeof import('electron');
        // Rollup may load this chunk before configureChromium.ts runs, so apply
        // the same display name and storage paths here as a safety net.
        app.setName(APP_DISPLAY_NAME);
        if (process.platform === 'win32') {
          app.setAppUserModelId(getAppUserModelId(app.isPackaged, process.execPath));
        }
        const e2eUserDataDir = process.env.AIONUI_E2E_TEST === '1' ? process.env.AIONUI_E2E_USER_DATA_DIR : undefined;
        if (e2eUserDataDir && e2eUserDataDir.trim() !== '') {
          app.setPath('userData', e2eUserDataDir);
          app.setPath('logs', path.join(e2eUserDataDir, 'logs'));
        } else {
          const appFilesystemName = getAppFilesystemName(app.isPackaged, process.execPath);
          const userDataPath = path.join(app.getPath('appData'), appFilesystemName);
          app.setPath('userData', userDataPath);
          app.setPath(
            'logs',
            process.platform === 'darwin'
              ? path.join(app.getPath('home'), 'Library', 'Logs', appFilesystemName)
              : path.join(userDataPath, 'logs')
          );
        }
        // Typed as IPlatformPaths so tsc enforces completeness: any new method
        // added to the interface will cause a compile error here if omitted below.
        const paths: import('./IPlatformServices').IPlatformPaths = {
          getDataDir: () => app.getPath('userData'),
          getTempDir: () => app.getPath('temp'),
          getHomeDir: () => app.getPath('home'),
          getLogsDir: () => {
            try {
              return app.getPath('logs');
            } catch {
              return path.join(app.getPath('userData'), 'logs');
            }
          },
          getAppPath: () => app.getAppPath(),
          isPackaged: () => app.isPackaged,
          getSystemPath: (name) => app.getPath(name),
          getName: () => app.getName(),
          getVersion: () => app.getVersion(),
          needsCliSafeSymlinks: () => process.platform === 'darwin',
        };
        _services = {
          paths,
          worker: {
            fork: () => {
              throw new Error('[Platform] Worker not available before registerPlatformServices()');
            },
          },
          power: { preventSleep: () => null, allowSleep: () => {}, preventDisplaySleep: () => null },
          notification: { send: () => {} },
          network: {
            fetch: (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
              net.fetch(input instanceof URL ? input.toString() : input, init),
          },
        };
      }
    } else {
      throw new Error(
        '[Platform] Services not registered. Call registerPlatformServices() before using platform APIs.'
      );
    }
  }
  return _services;
}

export type {
  IPlatformServices,
  IPlatformPaths,
  IWorkerProcess,
  IWorkerProcessFactory,
  IPowerManager,
  INotificationService,
  INetworkService,
} from './IPlatformServices';
