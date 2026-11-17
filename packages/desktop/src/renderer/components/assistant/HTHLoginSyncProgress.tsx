/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useSyncExternalStore } from 'react';
import { getHTHLoginSyncProgress, subscribeHTHLoginSync } from '@renderer/services/runtime/hthAssistantSync';
import AssistantSyncProgressModal from './AssistantSyncProgressModal';

const HTHLoginSyncProgress: React.FC = () => {
  const progress = useSyncExternalStore(subscribeHTHLoginSync, getHTHLoginSyncProgress);
  return progress ? <AssistantSyncProgressModal visible progress={progress} /> : null;
};

export default HTHLoginSyncProgress;
