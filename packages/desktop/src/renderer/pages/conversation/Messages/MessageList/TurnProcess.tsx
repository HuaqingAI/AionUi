/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Collapse, Spin } from '@arco-design/web-react';
import { Right } from '@icon-park/react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from './TurnProcess.module.css';

type TurnProcessProps = React.PropsWithChildren<{
  id: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  isRunning?: boolean;
  durationMs?: number;
  estimatedDuration?: boolean;
  loading?: boolean;
  loadError?: boolean;
  onRetry?: () => void;
  className?: string;
}>;

/** Controlled disclosure for a turn's intermediate messages. */
const TurnProcess: React.FC<TurnProcessProps> = ({
  id,
  expanded,
  onExpandedChange,
  isRunning = false,
  durationMs,
  estimatedDuration = false,
  loading = false,
  loadError = false,
  onRetry,
  className,
  children,
}) => {
  const { t } = useTranslation();
  let duration: string | undefined;
  if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
    const totalSeconds = Math.floor(durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    duration = [
      hours > 0 ? `${hours}${t('messages.turnProcess.hourUnit')}` : '',
      minutes > 0 ? `${minutes}${t('messages.turnProcess.minuteUnit')}` : '',
      `${totalSeconds % 60}${t('messages.turnProcess.secondUnit')}`,
    ]
      .filter(Boolean)
      .join(' ');
  }

  return (
    <div
      className={classNames(styles.container, className)}
      data-testid={`turn-process-${id}`}
      onKeyDownCapture={(event) => {
        // Arco handles Enter; complete the disclosure's keyboard behavior with Space.
        if (event.key === ' ' && event.target === event.currentTarget.querySelector('.arco-collapse-item-header')) {
          event.preventDefault();
          onExpandedChange(!expanded);
        }
      }}
    >
      <Collapse
        className={styles.disclosure}
        bordered={false}
        activeKey={expanded ? [id] : []}
        destroyOnHide
        expandIcon={<Right theme='outline' size='12' />}
        onChange={(_key, keys) => onExpandedChange(keys.includes(id))}
      >
        <Collapse.Item
          name={id}
          header={
            <span className={styles.title}>
              {isRunning && <Spin size={12} />}
              <span>{t(isRunning ? 'messages.turnProcess.running' : 'messages.turnProcess.title')}</span>
              {duration !== undefined && (
                <span
                  className={styles.duration}
                  title={estimatedDuration ? t('messages.turnProcess.estimatedDuration') : undefined}
                >
                  · {estimatedDuration ? '≈ ' : ''}
                  {duration}
                </span>
              )}
            </span>
          }
        >
          {expanded && (
            <>
              {loading && (
                <div className={styles.notice} role='status' aria-label={t('common.loading')}>
                  <Spin size={12} />
                  <span>{t('common.loading')}</span>
                </div>
              )}
              {loadError && (
                <div className={styles.notice} role='status'>
                  <span>{t('messages.turnProcess.loadFailed')}</span>
                  {onRetry && (
                    <Button size='mini' type='text' onClick={onRetry}>
                      {t('common.retry')}
                    </Button>
                  )}
                </div>
              )}
              {children}
            </>
          )}
        </Collapse.Item>
      </Collapse>
    </div>
  );
};

export default TurnProcess;
