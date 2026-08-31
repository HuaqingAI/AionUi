/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';

export class ManagedEnvironmentNotReadyError extends Error {
  constructor() {
    super('Managed environment is still initializing');
    this.name = 'ManagedEnvironmentNotReadyError';
  }
}

export async function assertManagedEnvironmentReady(): Promise<void> {
  const checker = ipcBridge.systemSettings?.isManagedEnvironmentReady?.invoke;
  if (typeof checker !== 'function') {
    return;
  }

  if (!(await checker())) {
    throw new ManagedEnvironmentNotReadyError();
  }
}
