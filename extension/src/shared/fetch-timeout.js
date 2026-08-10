import { ProviderError } from "./provider-error.js";

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function isAbortLike(error) {
  return Boolean(error) && (error.name === "AbortError" || error.code === 20);
}

/**
 * Run an abort-aware async operation with a hard timeout. The callback receives
 * a signal that is also cancelled if the caller's signal is aborted.
 */
export async function runWithTimeout(operation, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 30_000;
  const callerSignal = options.signal;
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let timer = null;

  const abortFromCaller = () => {
    callerAborted = true;
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else if (callerSignal) {
    callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  }

  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const startedAt = nowMs();
  try {
    const value = await operation(controller.signal);
    return { value, latencyMs: Math.round(nowMs() - startedAt) };
  } catch (error) {
    if (timedOut) {
      throw new ProviderError(`The model request timed out after ${timeoutMs} ms.`, {
        code: "timeout",
        retryable: true,
        cause: error,
      });
    }
    if (callerAborted || isAbortLike(error)) {
      throw new ProviderError("The model request was cancelled.", {
        code: "aborted",
        retryable: false,
        cause: error,
      });
    }
    throw error;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (callerSignal) {
      callerSignal.removeEventListener("abort", abortFromCaller);
    }
  }
}

export async function fetchWithTimeout(url, init, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ProviderError("Fetch is unavailable in this runtime.", {
      code: "fetch_unavailable",
    });
  }

  try {
    return await runWithTimeout(
      (signal) => fetchImpl(url, { ...init, signal }),
      options,
    );
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    throw new ProviderError("Unable to reach the model service.", {
      code: "network_error",
      retryable: true,
      cause: error,
    });
  }
}
