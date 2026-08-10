import { ProviderError } from "./provider-error.js";
import { runWithTimeout } from "./fetch-timeout.js";

function getHeader(headers, name) {
  if (!headers) {
    return undefined;
  }
  if (typeof headers.get === "function") {
    return headers.get(name) || undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return String(value);
    }
  }
  return undefined;
}

async function readResponseText(response) {
  if (typeof response?.text === "function") {
    return response.text();
  }
  if (typeof response?.json === "function") {
    return JSON.stringify(await response.json());
  }
  return "";
}

function tryParseJson(text) {
  if (!text || !text.trim()) {
    return { data: null, parsed: false };
  }
  try {
    return { data: JSON.parse(text), parsed: true };
  } catch {
    return { data: null, parsed: false };
  }
}

function extractErrorMessage(payload, rawText, status) {
  const error = payload?.error;
  const message = typeof error?.message === "string"
    ? error.message
    : typeof payload?.message === "string"
      ? payload.message
      : typeof rawText === "string" && rawText.trim()
        ? rawText.trim().slice(0, 500)
        : `The model service returned HTTP ${status}.`;
  return message;
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Send JSON and normalize HTTP, network, timeout, and invalid-JSON errors.
 */
export async function postJsonRequest(request) {
  const fetchImpl = request.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ProviderError("Fetch is unavailable in this runtime.", {
      code: "fetch_unavailable",
      protocol: request.protocol,
    });
  }

  let response;
  let rawText;
  let latencyMs = 0;
  try {
    const outcome = await runWithTimeout(async (signal) => {
      const result = await fetchImpl(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal,
      });
      const text = await readResponseText(result);
      return { response: result, rawText: text };
    }, {
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    response = outcome.value.response;
    rawText = outcome.value.rawText;
    latencyMs = outcome.latencyMs;
  } catch (error) {
    if (error instanceof ProviderError) {
      error.protocol ||= request.protocol;
      throw error;
    }
    throw new ProviderError("Unable to reach the model service.", {
      code: "network_error",
      protocol: request.protocol,
      retryable: true,
      cause: error,
    });
  }

  const status = Number.isInteger(response?.status) ? response.status : 0;
  const ok = typeof response?.ok === "boolean" ? response.ok : status >= 200 && status < 300;
  const requestId = getHeader(response?.headers, "x-request-id")
    || getHeader(response?.headers, "request-id")
    || getHeader(response?.headers, "anthropic-request-id");
  const parsed = tryParseJson(rawText);

  if (!ok) {
    throw new ProviderError(extractErrorMessage(parsed.data, rawText, status), {
      code: "http_error",
      status,
      protocol: request.protocol,
      requestId,
      retryable: retryableStatus(status),
      details: {
        errorType: parsed.data?.error?.type || parsed.data?.error?.code,
      },
    });
  }

  if (!parsed.parsed || parsed.data === null || typeof parsed.data !== "object") {
    throw new ProviderError("The model service returned an invalid JSON response.", {
      code: "invalid_response",
      status,
      protocol: request.protocol,
      requestId,
      retryable: false,
    });
  }

  return {
    data: parsed.data,
    status,
    requestId,
    latencyMs,
    headers: response?.headers,
  };
}
