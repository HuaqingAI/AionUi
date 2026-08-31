/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Sentry must be initialized first
// Use electron-specific renderer package only inside Electron; fall back to the
// browser SDK when running as a web server (no window.electronAPI).
if ((window as { electronAPI?: unknown }).electronAPI) {
  // Dynamic import avoids bundling sentry-ipc:// protocol code into the web build
  import('@sentry/electron/renderer')
    .then((Sentry) =>
      Sentry.init({
        beforeSend(event) {
          if (!(window as { __backendStartupFailed?: boolean }).__backendStartupFailed) {
            return event;
          }
          const haystacks: string[] = [];
          if (event.message) haystacks.push(event.message);
          const exceptions = event.exception?.values ?? [];
          for (const ex of exceptions) {
            if (ex.value) haystacks.push(ex.value);
          }
          if (haystacks.some((h) => /Failed to fetch|window\.__backendPort|__backendPort unset/.test(h))) {
            return null;
          }
          return event;
        },
      })
    )
    .catch(() => {});
}

// Runtime patches must be imported early
import './utils/ui/runtimePatches';

// Browser adapter setup
import '@/common/adapter/browser';

// React and core dependencies
import type { PropsWithChildren } from 'react';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { TFunction } from 'i18next';

// Context providers
import { AuthProvider } from './hooks/context/AuthContext';
import { FeedbackProvider } from './hooks/context/FeedbackContext';
import { ThemeProvider } from './hooks/context/ThemeContext';
import { PreviewProvider } from './pages/conversation/Preview/context/PreviewContext';

// Arco Design
import { Button, ConfigProvider, Modal, Spin, Typography } from '@arco-design/web-react';
// Configure Arco Design to use React 18's createRoot, fixing Message component's CopyReactDOM.render error
import '@arco-design/web-react/es/_util/react-19-adapter';
import '@arco-design/web-react/dist/css/arco.css';
import enUS from '@arco-design/web-react/es/locale/en-US';
import jaJP from '@arco-design/web-react/es/locale/ja-JP';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import zhTW from '@arco-design/web-react/es/locale/zh-TW';
import koKR from '@arco-design/web-react/es/locale/ko-KR';
import { useTranslation } from 'react-i18next';

// Styles
import 'uno.css';
import './styles/arco-override.css';
import './styles/themes/index.css';
import './styles/markdown.css';

// Config service — kick off initialization before i18n / theme modules load,
// so their startup paths (which await configService.whenReady()) observe the
// authoritative settings from the backend instead of the empty cache.
import { configService } from '@/common/config/configService';
configService.initialize().catch((err) => {
  console.error('Failed to initialize config:', err);
});

// i18n
import './services/i18n';
import { registerPwa } from './services/registerPwa';

import { ipcBridge } from '@/common';
import { repairAllCronJobTimeZonesOnce } from '@renderer/pages/cron/repairCronJobTimeZone';
import { bootstrapRendererConfig } from '@renderer/services/bootstrapRenderer';

// Components and utilities
import Layout from './components/layout/Layout';
import Router from './components/layout/Router';
import Sider from './components/layout/Sider';
import { useAuth } from './hooks/context/AuthContext';
import { ConversationHistoryProvider } from './hooks/context/ConversationHistoryContext';
import HOC from './utils/ui/HOC';
import type { BackendStartupFailureInfo } from '@/common/types/platform/electron';
import type { IRuntimeStatusEvent, RuntimeFailureKind } from '@/common/adapter/ipcBridge';
import {
  InstallationIntegrityContent,
  InstallationIntegrityModalHost,
  type InstallationIntegrityDiagnostics,
  getBackendStartupInstallationDescription,
  getDownloadLatestModalActionProps,
  getRuntimeComponentInstallationDescription,
  showInstallationIntegrityModal,
} from './components/layout/InstallationIntegrityDialog';

// Patch Korean locale with missing properties from English locale
const koKRComplete = {
  ...koKR,
  Calendar: {
    ...koKR.Calendar,
    monthFormat: enUS.Calendar.monthFormat,
    yearFormat: enUS.Calendar.yearFormat,
  },
  DatePicker: {
    ...koKR.DatePicker,
    Calendar: {
      ...koKR.DatePicker.Calendar,
      monthFormat: enUS.Calendar.monthFormat,
      yearFormat: enUS.Calendar.yearFormat,
    },
  },
  Form: enUS.Form,
  ColorPicker: enUS.ColorPicker,
};

const arcoLocales: Record<string, typeof enUS> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'ko-KR': koKRComplete,
  'en-US': enUS,
};

const INSTALLATION_INTEGRITY_FAILURES = new Set<RuntimeFailureKind>([
  'bundled_resource_missing',
  'bundled_resource_invalid',
  'validation_failed',
]);
const STARTUP_RUNTIME_STATUS_SUCCESS_DISMISS_MS = 3000;
const STARTUP_RUNTIME_TOOL_LABELS: Record<string, string> = {
  codex: 'Codex',
  opencode: 'OpenCode',
};
const STARTUP_RUNTIME_SCOPE_TOOL_IDS: Record<string, string> = {
  'startup-codex': 'codex',
  'startup-opencode': 'opencode',
};

function isInstallationIntegrityFailure(kind: RuntimeFailureKind | undefined): boolean {
  return INSTALLATION_INTEGRITY_FAILURES.has(kind ?? 'unknown');
}

function captureRuntimeInstallationIntegrityFailure(event: IRuntimeStatusEvent): void {
  if (!isInstallationIntegrityFailure(event.failure_kind)) {
    return;
  }

  void import('@sentry/electron/renderer')
    .then((Sentry) => {
      Sentry.withScope((scope) => {
        scope.setTag('aionui.installation_integrity', event.failure_kind ?? 'unknown');
        scope.setTag('aionui.runtime_resource', event.resource);
        scope.setTag('aionui.runtime_resource_id', event.resource_id ?? '');
        scope.setTag('aionui.runtime_scope', event.scope.kind);
        Sentry.captureMessage('runtime-installation-integrity-failure', 'error');
      });
    })
    .catch(() => {});
}

function buildRuntimeInstallationDiagnostics(
  event: IRuntimeStatusEvent,
  description: string
): InstallationIntegrityDiagnostics {
  return {
    source: 'runtime_status',
    description,
    runtime: {
      failureKind: event.failure_kind,
      message: event.message,
      phase: event.phase,
      resource: event.resource,
      resourceId: event.resource_id,
      scopeId: event.scope.id,
      scopeKind: event.scope.kind,
    },
  };
}

function resolveRuntimeResourceLabel(event: IRuntimeStatusEvent, t: TFunction): string {
  if (event.resource === 'node') {
    return t('settings.runtimeResource.node');
  }
  if (event.resource_id === 'codex-acp') {
    return t('settings.runtimeResource.codexAcp');
  }
  if (event.resource_id === 'claude-agent-acp') {
    return t('settings.runtimeResource.claudeAgentAcp');
  }
  return t('settings.runtimeResource.acpTool');
}

function runtimeFailureTranslationKey(kind?: RuntimeFailureKind): string {
  switch (kind) {
    case 'timeout':
      return 'settings.runtimeStatus.failedTimeout';
    case 'download_failed':
      return 'settings.runtimeStatus.failedDownload';
    case 'http_status':
      return 'settings.runtimeStatus.failedHttp';
    case 'checksum_mismatch':
      return 'settings.runtimeStatus.failedChecksum';
    case 'validation_failed':
      return 'settings.runtimeStatus.failedValidation';
    case 'unsupported_platform':
      return 'settings.runtimeStatus.failedUnsupported';
    case 'bundled_resource_missing':
    case 'bundled_resource_invalid':
      return 'settings.runtimeStatus.failedBundled';
    default:
      return 'settings.runtimeStatus.failedUnknown';
  }
}

function resolveStartupRuntimeToolLabel(event: IRuntimeStatusEvent): string | null {
  if (event.scope.kind !== 'custom_agent') {
    return null;
  }
  const resourceToolId = event.resource_id && STARTUP_RUNTIME_TOOL_LABELS[event.resource_id] ? event.resource_id : null;
  const toolId = resourceToolId ?? STARTUP_RUNTIME_SCOPE_TOOL_IDS[event.scope.id];
  return toolId ? (STARTUP_RUNTIME_TOOL_LABELS[toolId] ?? null) : null;
}

function resolveStartupRuntimeResourceLabel(event: IRuntimeStatusEvent, t: TFunction): string | null {
  if (event.resource === 'python' && event.scope.kind === 'custom_agent' && event.scope.id === 'startup-python') {
    return t('settings.runtimeResource.python');
  }
  return resolveStartupRuntimeToolLabel(event);
}

function getStartupRuntimeStatusMessage(event: IRuntimeStatusEvent, t: TFunction): string | null {
  const resource = resolveStartupRuntimeResourceLabel(event, t);
  if (!resource) {
    return null;
  }
  switch (event.phase) {
    case 'waiting_for_lock':
      return t('settings.runtimeStatus.waitingForLock', { resource });
    case 'downloading':
    case 'extracting':
      return t('settings.runtimeStatus.downloading', { resource });
    case 'validating':
      return t('settings.runtimeStatus.validating', { resource });
    case 'ready':
      return t('settings.runtimeStatus.ready', { resource });
    case 'failed':
      return t(runtimeFailureTranslationKey(event.failure_kind), { resource });
  }
}

const GlobalStartupRuntimeStatusMessage: React.FC = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{
    phase: IRuntimeStatusEvent['phase'];
    message: string;
    retryable: boolean;
  } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const dismissTimerRef = useRef<number | null>(null);
  const receivedLivePythonStatusRef = useRef(false);

  useEffect(() => {
    const handleRuntimeStatus = (event: IRuntimeStatusEvent) => {
      const content = getStartupRuntimeStatusMessage(event, t);
      if (!content) {
        return;
      }
      if (dismissTimerRef.current) {
        window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
      setStatus({
        phase: event.phase,
        message: content,
        retryable:
          event.resource === 'python' && event.scope.kind === 'custom_agent' && event.scope.id === 'startup-python',
      });
      if (event.phase !== 'failed') {
        setRetrying(false);
      }
      if (event.phase === 'ready') {
        dismissTimerRef.current = window.setTimeout(() => {
          setStatus(null);
          dismissTimerRef.current = null;
        }, STARTUP_RUNTIME_STATUS_SUCCESS_DISMISS_MS);
      }
    };

    const handleLiveRuntimeStatus = (event: IRuntimeStatusEvent) => {
      if (event.resource === 'python' && event.scope.kind === 'custom_agent' && event.scope.id === 'startup-python') {
        receivedLivePythonStatusRef.current = true;
      }
      handleRuntimeStatus(event);
    };
    const unsubscribeBackendStatus = ipcBridge.runtime.statusChanged.on(handleLiveRuntimeStatus);
    const unsubscribeLocalStatus = ipcBridge.runtime.localStatusChanged.on(handleLiveRuntimeStatus);
    void ipcBridge.systemSettings.getManagedPythonRuntimeStatus
      .invoke()
      .then((event) => {
        if (event && !receivedLivePythonStatusRef.current) {
          handleRuntimeStatus(event);
        }
      })
      .catch(() => {});
    return () => {
      if (dismissTimerRef.current) {
        window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
      unsubscribeBackendStatus();
      unsubscribeLocalStatus();
    };
  }, [t]);

  if (!status) {
    return null;
  }

  const toneClass =
    status.phase === 'failed'
      ? 'border-danger-5 bg-danger-light-1 text-danger-7 shadow-[0_12px_36px_rgba(var(--danger-6),0.22)]'
      : status.phase === 'ready'
        ? 'border-success-5 bg-success-light-1 text-success-7 shadow-[0_12px_36px_rgba(var(--success-6),0.2)]'
        : 'border-primary-5 bg-primary-light-1 text-primary-7 shadow-[0_12px_36px_rgba(var(--primary-6),0.22)]';

  const retryManagedPython = () => {
    setRetrying(true);
    void ipcBridge.systemSettings.retryManagedPythonRuntime.invoke().finally(() => setRetrying(false));
  };

  return (
    <div
      className={`${status.phase === 'failed' && status.retryable ? 'pointer-events-auto' : 'pointer-events-none'} fixed left-50% top-14px z-10002 flex min-h-44px max-w-[calc(100vw-32px)] translate-x--50% items-center gap-10px rounded-12px border border-solid px-16px py-10px text-13px font-500 leading-20px backdrop-blur-sm md:max-w-520px ${toneClass}`}
      role='status'
      aria-live='polite'
      data-testid='startup-runtime-status'
    >
      {status.phase === 'waiting_for_lock' ||
      status.phase === 'downloading' ||
      status.phase === 'extracting' ||
      status.phase === 'validating' ? (
        <Spin size={14} />
      ) : null}
      <span className='min-w-0 truncate'>{status.message}</span>
      {status.phase === 'failed' && status.retryable ? (
        <Button
          size='mini'
          type='text'
          loading={retrying}
          disabled={retrying}
          onClick={retryManagedPython}
          className='shrink-0'
        >
          {t('settings.retry')}
        </Button>
      ) : null}
    </div>
  );
};

const RuntimeFailureDialogs: React.FC = () => {
  const { t } = useTranslation();
  const [modal, modalContextHolder] = Modal.useModal();
  const shownFailuresRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    return ipcBridge.runtime.statusChanged.on((event: IRuntimeStatusEvent) => {
      if (event.phase !== 'failed') {
        return;
      }
      const signature = [
        event.resource,
        event.resource_id ?? '',
        event.scope.kind,
        event.scope.id,
        event.failure_kind ?? 'unknown',
        event.message ?? '',
      ].join('|');
      if (shownFailuresRef.current.has(signature)) {
        return;
      }
      shownFailuresRef.current.add(signature);

      const resource = resolveRuntimeResourceLabel(event, t);
      const installationIntegrityFailure = isInstallationIntegrityFailure(event.failure_kind);
      const description = installationIntegrityFailure
        ? getRuntimeComponentInstallationDescription(t, resource)
        : t('settings.runtimeStatus.failedUnknown', { resource });
      if (installationIntegrityFailure) {
        captureRuntimeInstallationIntegrityFailure(event);
        showInstallationIntegrityModal(modal, t, description, buildRuntimeInstallationDiagnostics(event, description));
        return;
      }

      modal.error({
        title: t('common.error'),
        content: <InstallationIntegrityContent description={description} />,
        okText: t('common.confirm'),
        closable: false,
        maskClosable: false,
      });
    });
  }, [modal, t]);

  return <>{modalContextHolder}</>;
};

const AppProviders: React.FC<PropsWithChildren> = ({ children }) =>
  React.createElement(
    AuthProvider,
    null,
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(
        PreviewProvider,
        null,
        React.createElement(
          FeedbackProvider,
          null,
          React.createElement(
            React.Fragment,
            null,
            React.createElement(RuntimeFailureDialogs, null),
            React.createElement(GlobalStartupRuntimeStatusMessage, null),
            children
          )
        )
      )
    )
  );

const Config: React.FC<PropsWithChildren> = ({ children }) => {
  const {
    i18n: { language },
  } = useTranslation();
  const arcoLocale = arcoLocales[language] ?? enUS;

  return React.createElement(ConfigProvider, { theme: { primaryColor: '#4E5969' }, locale: arcoLocale }, children);
};

const Main = () => {
  const { ready } = useAuth();
  const [configReady, setConfigReady] = useState(false);

  useEffect(() => {
    if (!ready) return;
    void bootstrapRendererConfig().finally(() => setConfigReady(true));
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    void repairAllCronJobTimeZonesOnce();
  }, [ready]);

  if (!ready || !configReady) {
    return null;
  }

  return (
    <Router
      layout={
        <ConversationHistoryProvider>
          <Layout sider={<Sider />} />
        </ConversationHistoryProvider>
      }
    />
  );
};

const App = HOC.Wrapper(Config)(Main);

const BackendStartupFailureDialog: React.FC<{ failure: BackendStartupFailureInfo }> = ({ failure }) => {
  const { t } = useTranslation();

  const isIncompatibleRuntime = failure.reason === 'backend_incompatible_runtime';
  const isPackageArchitectureMismatch = failure.reason === 'backend_package_architecture_mismatch';
  const isDataMigrationFailure = failure.reason === 'backend_data_migration_failed';
  const isLocalDataRepairFailure = failure.reason === 'backend_local_data_repair_failed';
  const isRecoverableDatabaseCorruption = failure.reason === 'backend_recoverable_database_corruption';
  const isTransientConcurrentStartup = failure.reason === 'backend_transient_concurrent_startup';
  const isStartupDirectoryFailure = failure.reason === 'backend_startup_directory_unavailable';
  const title = t('common.backendStartup.incompatibleRuntime.title');
  const description = isIncompatibleRuntime
    ? t('common.backendStartup.incompatibleRuntime.description')
    : isPackageArchitectureMismatch
      ? t('common.backendStartup.packageArchitectureMismatch.description', {
          packageArch: failure.packageArch ?? 'x64',
          deviceArch: failure.deviceArch ?? 'arm64',
          expectedArch: failure.expectedDownloadArch ?? 'arm64',
        })
      : isDataMigrationFailure
        ? t('common.backendStartup.dataMigration.description')
        : isLocalDataRepairFailure
          ? t('common.backendStartup.localDataRepair.description')
          : isTransientConcurrentStartup
            ? t('common.backendStartup.transientConcurrentStartup.description')
            : isStartupDirectoryFailure
              ? t('common.backendStartup.startupDirectory.description')
              : isRecoverableDatabaseCorruption
                ? t('common.backendStartup.recoverableDatabaseCorruption.description')
                : getBackendStartupInstallationDescription(t);
  const requiredVersions = failure.requiredVersions?.map((version) => `GLIBC_${version}`).join(', ');

  if (!isIncompatibleRuntime && !isPackageArchitectureMismatch) {
    return (
      <div className='min-h-screen bg-bg-1'>
        <InstallationIntegrityModalHost
          description={description}
          diagnosticsKind={
            isTransientConcurrentStartup
              ? 'transient_concurrent_startup'
              : isRecoverableDatabaseCorruption
                ? 'recoverable_database_corruption'
                : isStartupDirectoryFailure
                  ? 'startup_directory'
                  : isLocalDataRepairFailure
                    ? 'local_data_repair'
                    : isDataMigrationFailure
                      ? 'data_migration'
                      : 'incomplete_installation'
          }
          diagnostics={{
            source: 'backend_startup_failure',
            description,
            backendStartupFailure: failure as unknown as Record<string, unknown>,
          }}
        />
      </div>
    );
  }

  if (isPackageArchitectureMismatch) {
    return (
      <div className='min-h-screen bg-bg-1'>
        <Modal
          visible
          closable={false}
          maskClosable={false}
          title={t('common.backendStartup.packageArchitectureMismatch.title')}
          {...getDownloadLatestModalActionProps(t)}
        >
          <InstallationIntegrityContent description={description} />
        </Modal>
      </div>
    );
  }

  return (
    <div className='min-h-screen bg-bg-1'>
      <Modal visible closable={false} maskClosable={false} footer={null} title={title}>
        <div className='text-t-1'>
          <Typography.Paragraph className='mb-0 text-t-secondary'>{description}</Typography.Paragraph>
          {requiredVersions ? (
            <Typography.Paragraph className='mt-12px mb-0 text-12px text-t-tertiary'>
              {t('common.backendStartup.incompatibleRuntime.requiredVersions', { versions: requiredVersions })}
            </Typography.Paragraph>
          ) : null}
        </div>
      </Modal>
    </div>
  );
};

void registerPwa();

const root = createRoot(document.getElementById('root')!);
const backendStartupFailure = window.__backendStartupFailure;
const shouldShowBackendStartupFailureDialog =
  backendStartupFailure?.reason === 'backend_incompatible_runtime' ||
  backendStartupFailure?.reason === 'backend_incomplete_installation' ||
  backendStartupFailure?.reason === 'backend_package_architecture_mismatch' ||
  backendStartupFailure?.reason === 'backend_data_migration_failed' ||
  backendStartupFailure?.reason === 'backend_local_data_repair_failed' ||
  backendStartupFailure?.reason === 'backend_recoverable_database_corruption' ||
  backendStartupFailure?.reason === 'backend_transient_concurrent_startup' ||
  backendStartupFailure?.reason === 'backend_startup_failed';
if (backendStartupFailure && shouldShowBackendStartupFailureDialog) {
  root.render(
    <Config>
      <BackendStartupFailureDialog failure={backendStartupFailure} />
    </Config>
  );
} else {
  root.render(
    <AppProviders>
      <App />
    </AppProviders>
  );
}
