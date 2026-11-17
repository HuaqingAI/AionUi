/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type CronRuntimeOverrides = {
  backend: 'codex' | 'opencode';
  model?: string;
  thoughtLevel?: string;
  observeOnly?: true;
  browserMcp?: { command: string; args: string[] };
  suppressSkillSuggestion?: true;
};

export type CronRuntimeConfirmation = {
  backend: 'codex';
  model: string;
  thoughtLevel?: string;
};
