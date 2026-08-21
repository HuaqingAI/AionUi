/**
 * Categories used by AionUI assistant views. custom_assistant is local-only;
 * HTH-synced assistants use the Agent Platform categories.
 */
export const ASSISTANT_CATEGORY_CODES = [
  'custom_assistant',
  'general',
  'amazon_operations',
  'dtc_operations',
  'marketing',
  'design',
  'customer_service',
  'logistics',
  'market',
  'finance',
  'hr',
  'administration',
] as const;

export type AssistantCategoryCode = (typeof ASSISTANT_CATEGORY_CODES)[number];
