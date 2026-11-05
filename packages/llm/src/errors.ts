export type ModelErrorCode =
  | 'MODEL_INVALID_INPUT'
  | 'MODEL_NOT_AVAILABLE'
  | 'MODEL_PRICE_REQUIRED'
  | 'MODEL_BUDGET_EXCEEDED'
  | 'MODEL_CONTEXT_EXCEEDED'
  | 'MODEL_OUTPUT_INVALID'
  | 'MODEL_STREAM_FAILED'
  | 'PROVIDER_DISABLED'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'VAULT_UNAVAILABLE'
  | 'USAGE_RECORD_FAILED'
  | 'ABORTED';

const messages: Record<ModelErrorCode, string> = {
  MODEL_INVALID_INPUT: 'The model request is invalid.',
  MODEL_NOT_AVAILABLE:
    'No enabled model meets this request. Check model roles and privacy settings.',
  MODEL_PRICE_REQUIRED: 'Set input and output prices for a cloud model before using it.',
  MODEL_BUDGET_EXCEEDED: 'The remaining budget cannot cover this model request.',
  MODEL_CONTEXT_EXCEEDED: 'The conversation exceeds the available model context window.',
  MODEL_OUTPUT_INVALID: 'The model returned an invalid structured response.',
  MODEL_STREAM_FAILED: 'The model stream ended unexpectedly. Retry the message to continue.',
  PROVIDER_DISABLED: 'This model provider is disabled.',
  PROVIDER_NOT_FOUND: 'This model provider is not configured.',
  PROVIDER_AUTH: 'The provider rejected its credentials. Check the provider settings.',
  PROVIDER_RATE_LIMIT: 'The model provider is rate limited. Try again shortly.',
  PROVIDER_UNAVAILABLE: 'The model provider is unavailable. Check its connection and model.',
  PROVIDER_INVALID_RESPONSE: 'The model provider returned an invalid response.',
  VAULT_UNAVAILABLE:
    'The model credential is unavailable. Unlock the vault and check its reference.',
  USAGE_RECORD_FAILED: 'Model usage could not be recorded. The run has stopped.',
  ABORTED: 'The model request was cancelled.',
};

/** Never attach SDK errors as causes: they can contain request headers, prompts and raw responses. */
export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    readonly retryable = false,
  ) {
    super(messages[code]);
    this.name = 'ModelError';
  }
}

export function providerStatusError(status: number): ModelError {
  if (status === 401 || status === 403) return new ModelError('PROVIDER_AUTH');
  if (status === 429) return new ModelError('PROVIDER_RATE_LIMIT', true);
  return new ModelError('PROVIDER_UNAVAILABLE', status === 408 || status >= 500);
}

export function safeProviderError(error: unknown, aborted = false): ModelError {
  if (aborted) return new ModelError('ABORTED');
  if (error instanceof ModelError) return error;
  if (typeof error === 'object' && error !== null) {
    // Only the status code and error name are inspected. No stringification, logging or cause.
    const descriptor = Object.getOwnPropertyDescriptor(error, 'statusCode');
    if (descriptor && typeof descriptor.value === 'number')
      return providerStatusError(descriptor.value);
    const name = Object.getOwnPropertyDescriptor(error, 'name');
    if (name?.value === 'AbortError' || name?.value === 'TimeoutError')
      return new ModelError('PROVIDER_UNAVAILABLE', true);
  }
  return new ModelError('PROVIDER_UNAVAILABLE', true);
}
