/**
 * Pure string-matching functions for detecting specific error types
 * in model API responses.
 */

/**
 * Detect API key errors (user configuration issues that should not
 * trigger automatic model switching).
 */
export const isApiKeyError = (data: unknown): boolean => {
  let text = '';
  if (typeof data === 'string') {
    text = data.toLowerCase();
  } else if (data && typeof data === 'object') {
    try {
      text = JSON.stringify(data).toLowerCase();
    } catch {
      return false;
    }
  } else {
    return false;
  }

  const hasInvalidApiKey =
    text.includes('api key not valid') ||
    text.includes('api_key_invalid') ||
    text.includes('invalid api key') ||
    text.includes('google_api_key');
  return hasInvalidApiKey;
};

/**
 * Detect general API errors (400, 401, 403, 404, 5xx, etc.)
 * excluding API key errors which are user configuration issues.
 */
export const isApiErrorMessage = (data: unknown): boolean => {
  if (isApiKeyError(data)) {
    return false;
  }

  let text = '';
  if (typeof data === 'string') {
    text = data.toLowerCase();
  } else if (data && typeof data === 'object') {
    try {
      text = JSON.stringify(data).toLowerCase();
    } catch {
      return false;
    }
  } else {
    return false;
  }

  const hasStatusError = /(?:status|code|error)[:\s]*(?:400|401|403|404|500|502|503|504)/i.test(text);
  const hasInvalidUrl = text.includes('invalid url');
  const hasNotFound = text.includes('not found') || text.includes('notfound');
  const hasUnauthorized = text.includes('unauthorized') || text.includes('authentication');
  const hasForbidden = text.includes('forbidden') || text.includes('access denied');
  const hasInvalidArgument = text.includes('invalid_argument');
  return hasStatusError || hasInvalidUrl || hasNotFound || hasUnauthorized || hasForbidden || hasInvalidArgument;
};
