/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getManagedStartupToolCommandPathForDiagnostics,
  getManagedStartupToolsForDiagnostics,
  type ManagedStartupToolId,
} from '@process/startup/opencodeStartup';
import {
  getManagedPythonCommandPathForDiagnostics,
  getUvExecutablePathForDiagnostics,
} from '@process/startup/uvStartup';
import type { RuntimeDiagnosticDefinition } from './types';

const STARTUP_TOOL_ORDER: ManagedStartupToolId[] = [
  'beisen-cli',
  'codex',
  'dws',
  'googleworkspace-cli',
  'noxinfluencer-cli',
  'officecli',
  'opencode',
  'shopify-cli',
  'ziniao-open',
];

export function getRuntimeDiagnosticDefinitions(): readonly RuntimeDiagnosticDefinition[] {
  const managedTools = getManagedStartupToolsForDiagnostics();
  const orderedTools = STARTUP_TOOL_ORDER.map((toolId) => managedTools.find((tool) => tool.toolId === toolId)).filter(
    (tool): tool is NonNullable<typeof tool> => Boolean(tool)
  );

  return [
    {
      args: ['--version'],
      command: 'uv',
      id: 'uv',
      installable: true,
      kind: 'uv',
      label: 'uv',
      requiredVersion: '0.11.31',
      resolveExpectedPath: (dataPath) => getUvExecutablePathForDiagnostics(dataPath),
    },
    {
      args: ['--version'],
      command: 'python',
      id: 'python',
      installable: true,
      kind: 'python',
      label: 'Python 3.14',
      requiredVersion: '3.14',
      resolveExpectedPath: (dataPath) => getManagedPythonCommandPathForDiagnostics(dataPath),
    },
    ...orderedTools.map((tool): RuntimeDiagnosticDefinition => {
      const definition: RuntimeDiagnosticDefinition = {
        args: [...tool.versionArgs],
        command: tool.commandName,
        id: tool.toolId,
        installable: true,
        kind: 'managed-node-tool',
        label: tool.displayName,
        packageName: tool.packageName,
        resolveExpectedPath: (dataPath) => getManagedStartupToolCommandPathForDiagnostics(tool.toolId, dataPath),
        toolId: tool.toolId,
      };
      if (tool.packageSpec) {
        definition.packageSpec = tool.packageSpec;
      }
      if (tool.requiredVersion) {
        definition.requiredVersion = tool.requiredVersion;
      }
      return definition;
    }),
  ];
}
