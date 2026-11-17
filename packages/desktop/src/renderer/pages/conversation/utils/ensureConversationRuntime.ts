import { ipcBridge } from '@/common';
import type { AcpConfigOptionDto, EnsureConversationRuntimeResponse } from '@/common/types/platform/acpTypes';
import {
  getAgentModelCatalogSnapshot,
  observeAgentModelRuntimeSnapshot,
} from '@/renderer/services/runtime/agentModelCatalog';

const ensureRuntimeByConversation = new Map<string, Promise<EnsureConversationRuntimeResponse>>();
const confirmedCodexRuntime = new Map<string, { scope: string | null; model: string; thoughtLevel: string }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Fill native Codex's missing effort only from settings confirmed by its thread. */
export function applyConfirmedCodexThoughtLevel(
  conversation_id: string,
  options: AcpConfigOptionDto[]
): AcpConfigOptionDto[] {
  const confirmed = confirmedCodexRuntime.get(conversation_id);
  if (!confirmed || confirmed.scope !== getAgentModelCatalogSnapshot().scope) return options;
  const model = options.find((option) => option.category === 'model' || option.id === 'model');
  if (model?.current_value !== confirmed.model) return options;
  return options.map((option) => {
    if (
      (option.category !== 'thought_level' && !['thought_level', 'reasoning_effort'].includes(option.id)) ||
      (option.option_type ?? option.type) !== 'select' ||
      option.current_value?.trim() ||
      !option.options.some((choice) => choice.value === confirmed.thoughtLevel)
    ) {
      return option;
    }
    return { ...option, current_value: confirmed.thoughtLevel };
  });
}

export function ensureConversationRuntime(conversation_id: string): Promise<EnsureConversationRuntimeResponse> {
  const existing = ensureRuntimeByConversation.get(conversation_id);
  if (existing) {
    return existing;
  }

  const requestScope = getAgentModelCatalogSnapshot().scope;
  const promise = ipcBridge.conversation.ensureRuntime
    .invoke({ conversation_id })
    .then(async (response) => {
      const hasThoughtLevel = response.config_options.some(
        (option) =>
          (option.category === 'thought_level' || ['thought_level', 'reasoning_effort'].includes(option.id)) &&
          (option.option_type ?? option.type) === 'select' &&
          Boolean(option.current_value?.trim())
      );
      if (!hasThoughtLevel && requestScope && requestScope === getAgentModelCatalogSnapshot().scope) {
        confirmedCodexRuntime.delete(conversation_id);
        try {
          const conversation = await ipcBridge.conversation.get.invoke({ id: conversation_id });
          const extra: unknown = conversation.extra;
          const ordinary = isRecord(extra) ? extra.aionui_codex_runtime : undefined;
          const cron = isRecord(extra) ? extra.aionui_cron_runtime : undefined;
          const hasCronOverrides =
            isRecord(cron) &&
            isRecord(cron.runtime) &&
            (cron.runtime.model !== undefined || cron.runtime.thoughtLevel !== undefined);
          const usesOrdinaryConfirmation = !hasCronOverrides && ordinary !== undefined && ordinary !== null;
          const snapshot = usesOrdinaryConfirmation ? ordinary : cron;
          if (
            conversation.id === conversation_id &&
            isRecord(snapshot) &&
            snapshot.version === 1 &&
            isRecord(snapshot.confirmed)
          ) {
            const runtime = snapshot.runtime;
            const confirmed = snapshot.confirmed;
            if (
              confirmed.backend === 'codex' &&
              typeof confirmed.model === 'string' &&
              confirmed.model.trim() &&
              typeof confirmed.thoughtLevel === 'string' &&
              confirmed.thoughtLevel.trim() &&
              (usesOrdinaryConfirmation ||
                (isRecord(runtime) &&
                  runtime.backend === 'codex' &&
                  (runtime.model === undefined || runtime.model === confirmed.model) &&
                  (runtime.thoughtLevel === undefined || runtime.thoughtLevel === confirmed.thoughtLevel))) &&
              requestScope === getAgentModelCatalogSnapshot().scope
            ) {
              confirmedCodexRuntime.set(conversation_id, {
                scope: requestScope,
                model: confirmed.model,
                thoughtLevel: confirmed.thoughtLevel,
              });
            }
          }
        } catch {
          // A failed metadata read must not prevent access to the runtime's actual configuration.
        }
      }
      const config_options = applyConfirmedCodexThoughtLevel(conversation_id, response.config_options);
      observeAgentModelRuntimeSnapshot(conversation_id, config_options, requestScope);
      return { ...response, config_options };
    })
    .finally(() => {
      ensureRuntimeByConversation.delete(conversation_id);
    });
  ensureRuntimeByConversation.set(conversation_id, promise);
  return promise;
}

export function resetEnsureConversationRuntimeStateForTests(): void {
  ensureRuntimeByConversation.clear();
  confirmedCodexRuntime.clear();
}
