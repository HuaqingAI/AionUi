/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { useEffect, useState } from 'react';

export const useHthModelPricingDescriptions = (modelIds: string[], enabled = true): Record<string, string> => {
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const modelIdsKey = modelIds.join('\u0000');

  useEffect(() => {
    if (!enabled || !modelIdsKey) {
      setDescriptions({});
      return;
    }

    let cancelled = false;
    void ipcBridge.hth.modelPricingDescriptions
      .invoke({ modelIds: modelIdsKey.split('\u0000') })
      .then((result) => {
        if (!cancelled) setDescriptions(result.descriptions);
      })
      .catch(() => {
        if (!cancelled) setDescriptions({});
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, modelIdsKey]);

  return descriptions;
};
