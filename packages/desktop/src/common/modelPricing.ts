/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type ModelPricingSource = {
  model_name?: unknown;
  quota_type?: unknown;
  model_ratio?: unknown;
  completion_ratio?: unknown;
  billing_mode?: unknown;
};

export type ModelPricingSnapshot = {
  data: unknown[];
  groupRatio: Record<string, unknown>;
  pricingVersion?: string;
};

export type ModelPricingDisplay = {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  effectiveUsdPer1M: number;
  multiplier: string;
};

const INPUT_WEIGHT = 0.8;
const OUTPUT_WEIGHT = 0.2;

function finitePositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function selectGroupRatio(groupRatio: Record<string, unknown>): number | null {
  const defaultRatio = finitePositiveNumber(groupRatio.default);
  if (defaultRatio !== null) return defaultRatio;

  for (const group of Object.keys(groupRatio).toSorted()) {
    const ratio = finitePositiveNumber(groupRatio[group]);
    if (ratio !== null) return ratio;
  }

  return null;
}

function formatMultiplier(value: number): string {
  const normalized = Math.max(1, value);
  const rounded = Math.round(normalized * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/0+$/, '');
}

function formatUsd(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000;
  const [integer, decimals] = rounded.toFixed(4).split('.');
  return `${integer}.${(decimals || '').replace(/0+$/, '').padEnd(2, '0')}`;
}

/** Calculate weighted token costs and relative multipliers for runtime model IDs. */
export function calculateModelPricing(
  modelIds: string[],
  pricingSources: unknown[],
  groupRatio: Record<string, unknown> = {}
): Map<string, ModelPricingDisplay> {
  const selectedGroupRatio = selectGroupRatio(groupRatio);
  if (selectedGroupRatio === null) return new Map();
  const byModel = new Map<string, ModelPricingSource>();
  for (const source of pricingSources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const item = source as ModelPricingSource;
    const modelName = typeof item.model_name === 'string' ? item.model_name.trim() : '';
    if (modelName && !byModel.has(modelName)) byModel.set(modelName, item);
  }

  const costs = new Map<string, Omit<ModelPricingDisplay, 'multiplier'>>();
  for (const modelId of modelIds) {
    const source = byModel.get(modelId);
    if (
      !source ||
      source.quota_type !== 0 ||
      (typeof source.billing_mode === 'string' && source.billing_mode.trim().toLowerCase() === 'tiered_expr')
    )
      continue;

    const modelRatio = finitePositiveNumber(source.model_ratio);
    const completionRatio = finiteNonNegativeNumber(source.completion_ratio);
    if (modelRatio === null || completionRatio === null) continue;

    const inputUsdPer1M = modelRatio * 2 * selectedGroupRatio;
    const outputUsdPer1M = inputUsdPer1M * completionRatio;
    const effectiveUsdPer1M = inputUsdPer1M * INPUT_WEIGHT + outputUsdPer1M * OUTPUT_WEIGHT;
    if (!Number.isFinite(effectiveUsdPer1M) || effectiveUsdPer1M <= 0) continue;
    costs.set(modelId, { inputUsdPer1M, outputUsdPer1M, effectiveUsdPer1M });
  }

  const referenceCost = Math.min(...[...costs.values()].map((item) => item.effectiveUsdPer1M));
  if (!Number.isFinite(referenceCost) || referenceCost <= 0) return new Map();

  return new Map(
    [...costs.entries()].map(([modelId, cost]) => [
      modelId,
      { ...cost, multiplier: formatMultiplier(cost.effectiveUsdPer1M / referenceCost) },
    ])
  );
}

/** Append a computed multiplier to a user-facing model label when available. */
export function appendModelMultiplier(label: string, pricing?: ModelPricingDisplay): string {
  return pricing ? `${label} x${pricing.multiplier}` : label;
}

/** Format the token pricing summary rendered by the existing model option tooltip. */
export function formatModelPricingDescription(pricing?: ModelPricingDisplay): string | undefined {
  if (!pricing) return undefined;
  return [
    `输入 $${formatUsd(pricing.inputUsdPer1M)} / 百万 Token`,
    `输出 $${formatUsd(pricing.outputUsdPer1M)} / 百万 Token`,
  ].join('\n');
}
