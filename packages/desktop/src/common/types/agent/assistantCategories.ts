/**
 * Categories shared by the new-api Agent Platform and AionUI assistant views.
 */
export const ASSISTANT_CATEGORY_CODES = [
  'general',
  'operations',
  'customer_service',
  'logistics',
  'marketing',
  'finance',
  'hr',
] as const;

export type AssistantCategoryCode = (typeof ASSISTANT_CATEGORY_CODES)[number];
