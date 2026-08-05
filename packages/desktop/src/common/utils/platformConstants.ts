/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HTH 网关平台标识
 * HTH gateway platform identifier
 */
export const HTH_PLATFORM_ID = 'hth';

/**
 * 检查平台是否为 HTH 网关类型
 * Check if platform is HTH gateway type
 */
export const isHTHPlatform = (platform: string): boolean => {
  return platform === HTH_PLATFORM_ID;
};
