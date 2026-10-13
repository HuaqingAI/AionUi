/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Collapse, Message, Tag, Tooltip, Typography } from '@arco-design/web-react';
import { Copy, Download, Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { IRuntimeStatusEvent, RuntimeDiagnosticItem, RuntimeDiagnosticStatus } from '@/common/adapter/ipcBridge';
import { ipcBridge } from '@/common';
import { formatDateTime } from '@/renderer/services/i18n/format';
import { copyText } from '@/renderer/utils/ui/clipboard';

type CliRuntimeDiagnosticsProps = {
  appVersion: string;
};

const UNAVAILABLE_STATUSES = new Set<RuntimeDiagnosticStatus>(['missing', 'broken', 'failed']);
const PANEL_KEY = 'runtime-diagnostics';

function commandText(item: RuntimeDiagnosticItem): string {
  return [item.command, ...item.args].join(' ');
}

function getStatusColor(status: RuntimeDiagnosticStatus): string {
  if (status === 'ready') return 'green';
  if (status === 'checking' || status === 'installing') return 'blue';
  if (status === 'missing' || status === 'broken' || status === 'failed') return 'red';
  if (status === 'unsupported') return 'orangered';
  return 'gray';
}

function mapRuntimePhase(event: IRuntimeStatusEvent): RuntimeDiagnosticStatus | null {
  if (event.phase === 'ready') return 'ready';
  if (event.phase === 'failed') return 'failed';
  if (event.phase === 'validating') return 'checking';
  if (event.phase === 'waiting_for_lock' || event.phase === 'downloading' || event.phase === 'extracting') {
    return 'installing';
  }
  return null;
}

function runtimeStatusItemId(event: IRuntimeStatusEvent): string | null {
  if (event.resource === 'python') {
    return 'python';
  }
  if (event.resource === 'acp_tool' && event.resource_id) {
    return event.resource_id;
  }
  return null;
}

const CliRuntimeDiagnostics: React.FC<CliRuntimeDiagnosticsProps> = ({ appVersion }) => {
  const { t, i18n } = useTranslation();
  const tRef = useRef(t);
  const [items, setItems] = useState<RuntimeDiagnosticItem[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkingIds, setCheckingIds] = useState<Set<string>>(() => new Set());
  const [installingIds, setInstallingIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const mergeItems = useCallback((nextItems: RuntimeDiagnosticItem[]) => {
    setItems((prev) => {
      const map = new Map(prev.map((item) => [item.id, item]));
      for (const item of nextItems) {
        map.set(item.id, item);
      }
      const ordered = prev
        .map((item) => map.get(item.id))
        .filter((item): item is RuntimeDiagnosticItem => Boolean(item));
      for (const item of nextItems) {
        if (!prev.some((existing) => existing.id === item.id)) {
          ordered.push(item);
        }
      }
      return ordered;
    });
  }, []);

  useEffect(() => {
    return ipcBridge.systemSettings.runtimeDiagnosticsStatusChanged.on((item) => {
      mergeItems([item]);
    });
  }, [mergeItems]);

  useEffect(() => {
    return ipcBridge.runtime.localStatusChanged.on((event) => {
      const id = runtimeStatusItemId(event);
      const status = mapRuntimePhase(event);
      if (!id || !status) {
        return;
      }
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                error: event.message ?? item.error,
                status,
              }
            : item
        )
      );
    });
  }, []);

  const runProbe = useCallback(
    async (ids?: string[]) => {
      const targetIds = ids ?? [];
      setCheckingIds((prev) => new Set([...prev, ...targetIds]));
      try {
        const result = await ipcBridge.systemSettings.runtimeDiagnosticsProbe.invoke(ids ? { ids } : {});
        mergeItems(result);
      } catch {
        Message.error(tRef.current('settings.runtimeDiagnostics.checkFailed'));
      } finally {
        setCheckingIds((prev) => {
          const next = new Set(prev);
          for (const id of targetIds) {
            next.delete(id);
          }
          return next;
        });
      }
    },
    [mergeItems]
  );

  useEffect(() => {
    let cancelled = false;
    if (!expanded || hasLoaded) {
      return () => {
        cancelled = true;
      };
    }

    const load = async () => {
      setLoading(true);
      try {
        const list = await ipcBridge.systemSettings.runtimeDiagnosticsList.invoke();
        if (cancelled) return;
        setItems(list);
        await runProbe(list.map((item) => item.id));
      } catch {
        if (!cancelled) {
          Message.error(tRef.current('settings.runtimeDiagnostics.loadFailed'));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setHasLoaded(true);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [expanded, hasLoaded, runProbe]);

  const repairIds = useMemo(
    () => items.filter((item) => item.installable && UNAVAILABLE_STATUSES.has(item.status)).map((item) => item.id),
    [items]
  );

  const summary = useMemo(() => {
    const ready = items.filter((item) => item.status === 'ready').length;
    const repair = items.filter((item) => UNAVAILABLE_STATUSES.has(item.status)).length;
    const unsupported = items.filter((item) => item.status === 'unsupported').length;
    return { ready, repair, total: items.length, unsupported };
  }, [items]);

  const busy = loading || checkingIds.size > 0 || installingIds.size > 0;

  const runInstall = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      setInstallingIds((prev) => new Set([...prev, ...ids]));
      try {
        const result = await ipcBridge.systemSettings.runtimeDiagnosticsInstall.invoke({ ids });
        mergeItems(result.items);
        if (result.failedIds.length > 0) {
          Message.error(tRef.current('settings.runtimeDiagnostics.repairFailed'));
        }
      } catch {
        Message.error(tRef.current('settings.runtimeDiagnostics.repairFailed'));
      } finally {
        setInstallingIds((prev) => {
          const next = new Set(prev);
          for (const id of ids) {
            next.delete(id);
          }
          return next;
        });
      }
    },
    [mergeItems]
  );

  const buildSummaryText = useCallback(() => {
    const lines = [
      t('settings.runtimeDiagnostics.summaryTitle'),
      `${t('settings.runtimeDiagnostics.summaryAppVersion')}: ${appVersion}`,
      `${t('settings.runtimeDiagnostics.summaryCheckedAt')}: ${formatDateTime(Date.now(), i18n.language)}`,
      '',
    ];
    for (const item of items) {
      lines.push(`${item.label}: ${t(`settings.runtimeDiagnostics.status.${item.status}`)}`);
      lines.push(`  ${t('settings.runtimeDiagnostics.summaryCommand')}: ${commandText(item)}`);
      if (item.versionOutput) {
        lines.push(`  ${t('settings.runtimeDiagnostics.summaryOutput')}: ${item.versionOutput}`);
      }
      const itemPath = item.resolvedPath ?? item.expectedPath;
      if (itemPath) {
        lines.push(`  ${t('settings.runtimeDiagnostics.summaryPath')}: ${itemPath}`);
      }
      if (item.error) {
        lines.push(`  ${t('settings.runtimeDiagnostics.summaryError')}: ${item.error}`);
      }
      lines.push('');
    }
    return lines.join('\n').trim();
  }, [appVersion, i18n.language, items, t]);

  const copySummary = async () => {
    try {
      await copyText(buildSummaryText());
      Message.success(t('settings.runtimeDiagnostics.copied'));
    } catch {
      Message.error(t('settings.runtimeDiagnostics.copyFailed'));
    }
  };

  return (
    <div className='w-full pt-20px border-t border-b-base'>
      <Collapse
        activeKey={expanded ? [PANEL_KEY] : []}
        bordered
        expandIconPosition='left'
        onChange={(_, activeKeys) => setExpanded((activeKeys as string[]).includes(PANEL_KEY))}
        className='[&_.arco-collapse-item]:!border-0 [&_.arco-collapse-item]:!rounded-8px [&_.arco-collapse-item]:!overflow-hidden [&_.arco-collapse-item]:!bg-fill-1 [&_.arco-collapse-item-header]:!bg-fill-1 [&_.arco-collapse-item-header]:!pl-36px [&_.arco-collapse-item-header]:!pr-12px [&_.arco-collapse-item-header]:!py-12px [&_.arco-collapse-item-header]:hover:!bg-fill-2 [&_.arco-collapse-item-header-title]:!min-w-0 [&_.arco-collapse-item-content]:!border-t [&_.arco-collapse-item-content]:!border-b-base [&_.arco-collapse-item-content-box]:!px-12px [&_.arco-collapse-item-content-box]:!py-12px'
      >
        <Collapse.Item
          name={PANEL_KEY}
          className='[&_.arco-collapse-item-header-title]:flex-1'
          header={
            <div className='min-w-0 flex-1'>
              <Typography.Title heading={5} className='m-0 text-t-primary'>
                {t('settings.runtimeDiagnostics.title')}
              </Typography.Title>
              <Typography.Text className='text-13px text-t-secondary'>
                {t('settings.runtimeDiagnostics.description')}
              </Typography.Text>
            </div>
          }
        >
          {expanded && (
            <div className='flex flex-col gap-12px'>
              <div className='flex flex-wrap items-start justify-between gap-12px'>
                <Typography.Text className='text-13px text-t-secondary'>
                  {t('settings.runtimeDiagnostics.summary', summary)}
                </Typography.Text>
                <div className='flex flex-wrap gap-8px justify-end'>
                  <Button
                    size='small'
                    icon={<Refresh size={14} />}
                    loading={loading}
                    disabled={busy}
                    onClick={() => void runProbe(items.map((item) => item.id))}
                  >
                    {t('settings.runtimeDiagnostics.checkAll')}
                  </Button>
                  <Button
                    size='small'
                    icon={<Download size={14} />}
                    loading={installingIds.size > 0}
                    disabled={busy || repairIds.length === 0}
                    onClick={() => void runInstall(repairIds)}
                  >
                    {t('settings.runtimeDiagnostics.repairUnavailable')}
                  </Button>
                  <Button
                    size='small'
                    icon={<Copy size={14} />}
                    disabled={items.length === 0}
                    onClick={() => void copySummary()}
                  >
                    {t('settings.runtimeDiagnostics.copySummary')}
                  </Button>
                </div>
              </div>

              <div className='flex flex-col gap-8px'>
                {items.map((item) => {
                  const itemBusy =
                    item.status === 'checking' ||
                    item.status === 'installing' ||
                    checkingIds.has(item.id) ||
                    installingIds.has(item.id);
                  const itemPath = item.resolvedPath ?? item.expectedPath ?? t('settings.runtimeDiagnostics.noPath');
                  const versionOutput =
                    item.versionOutput ?? item.error ?? t('settings.runtimeDiagnostics.noVersionOutput');
                  return (
                    <div key={item.id} className='rd-8px border border-b-base bg-fill-1 p-12px'>
                      <div className='flex flex-wrap items-start justify-between gap-10px'>
                        <div className='min-w-0 flex flex-wrap items-center gap-8px'>
                          <Tag color={getStatusColor(item.status)}>
                            {t(`settings.runtimeDiagnostics.status.${item.status}`)}
                          </Tag>
                          <Typography.Text className='font-500 text-t-primary'>{item.label}</Typography.Text>
                          <Typography.Text className='text-12px text-t-tertiary'>
                            {t(`settings.runtimeDiagnostics.kind.${item.kind}`)}
                          </Typography.Text>
                        </div>
                        <div className='flex gap-6px'>
                          <Button
                            size='mini'
                            icon={<Refresh size={12} />}
                            loading={checkingIds.has(item.id) || item.status === 'checking'}
                            disabled={itemBusy}
                            onClick={() => void runProbe([item.id])}
                          >
                            {t('settings.runtimeDiagnostics.actions.check')}
                          </Button>
                          <Button
                            size='mini'
                            icon={<Download size={12} />}
                            loading={installingIds.has(item.id) || item.status === 'installing'}
                            disabled={itemBusy || !item.installable || item.status === 'unsupported'}
                            onClick={() => void runInstall([item.id])}
                          >
                            {t('settings.runtimeDiagnostics.actions.repair')}
                          </Button>
                        </div>
                      </div>

                      <div className='mt-10px grid grid-cols-1 md:grid-cols-[96px_minmax(0,1fr)] gap-x-10px gap-y-6px text-12px'>
                        <Typography.Text className='text-t-tertiary'>
                          {t('settings.runtimeDiagnostics.columns.command')}
                        </Typography.Text>
                        <Typography.Text className='font-mono text-t-primary break-all'>
                          {commandText(item)}
                        </Typography.Text>
                        <Typography.Text className='text-t-tertiary'>
                          {t('settings.runtimeDiagnostics.columns.version')}
                        </Typography.Text>
                        <Typography.Text className='font-mono text-t-primary whitespace-pre-wrap break-all'>
                          {versionOutput}
                        </Typography.Text>
                        <Typography.Text className='text-t-tertiary'>
                          {t('settings.runtimeDiagnostics.columns.path')}
                        </Typography.Text>
                        <Tooltip content={itemPath}>
                          <Typography.Text className='font-mono text-t-secondary truncate'>{itemPath}</Typography.Text>
                        </Tooltip>
                        {item.lastCheckedAt && (
                          <>
                            <Typography.Text className='text-t-tertiary'>
                              {t('settings.runtimeDiagnostics.columns.lastChecked')}
                            </Typography.Text>
                            <Typography.Text className='text-t-secondary'>
                              {formatDateTime(item.lastCheckedAt, i18n.language)}
                            </Typography.Text>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Collapse.Item>
      </Collapse>
    </div>
  );
};

export default CliRuntimeDiagnostics;
