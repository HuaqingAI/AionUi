/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RuntimeDiagnosticKind } from '@/common/adapter/ipcBridge';
import type { ManagedStartupToolId } from '@process/startup/opencodeStartup';

export type DiagnosticCommandRunner = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    windowsVerbatimArguments?: boolean;
  }
) => Promise<{ stderr?: string; stdout?: string }>;

export type RuntimeDiagnosticDefinition = {
  args: string[];
  command: string;
  id: string;
  installable: boolean;
  kind: RuntimeDiagnosticKind;
  label: string;
  packageName?: string;
  packageSpec?: string;
  requiredVersion?: string;
  resolveExpectedPath: (dataPath: string) => string | null;
  toolId?: ManagedStartupToolId;
};
