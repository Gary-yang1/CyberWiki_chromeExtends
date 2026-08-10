/**
 * A normalized error which can safely cross the provider/UI boundary.
 *
 * `details` is deliberately intended for structured, non-secret diagnostic
 * data (for example an API error type). Do not put request headers or API keys
 * in it.
 */
export class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = options.code || "provider_error";
    this.status = Number.isInteger(options.status) ? options.status : undefined;
    this.protocol = options.protocol;
    this.requestId = options.requestId;
    this.retryable = Boolean(options.retryable);
    this.details = options.details;

    if (options.cause) {
      this.cause = options.cause;
    }
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      protocol: this.protocol,
      requestId: this.requestId,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function asProviderError(error, fallback = {}) {
  if (error instanceof ProviderError) {
    return error;
  }

  const message = error instanceof Error && error.message
    ? error.message
    : fallback.message || "The model request failed.";

  return new ProviderError(message, {
    code: fallback.code || "provider_error",
    protocol: fallback.protocol,
    retryable: Boolean(fallback.retryable),
    cause: error,
  });
}

export function serializeProviderError(error) {
  return asProviderError(error).toJSON();
}
