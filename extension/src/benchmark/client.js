export class BenchmarkApiError extends Error {
  constructor(message, status = 0, code = "benchmark_error") {
    super(message);
    this.name = "BenchmarkApiError";
    this.status = status;
    this.code = code;
  }
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || "http://127.0.0.1:8765/api/v1").trim();
  return value.replace(/\/+$/, "");
}

async function request(baseUrl, path, init = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers || {})
      },
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new BenchmarkApiError(
        body?.error?.message || `Benchmark API returned HTTP ${response.status}`,
        response.status,
        body?.error?.code || "benchmark_http_error"
      );
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new BenchmarkApiError("Benchmark API request timed out", 0, "benchmark_timeout");
    }
    if (error instanceof BenchmarkApiError) throw error;
    throw new BenchmarkApiError(error.message || "Benchmark API is unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export function getBenchmarkHealth(baseUrl) {
  return request(baseUrl, "/health", { method: "GET" });
}

export function getBenchmarkStats(baseUrl) {
  return request(baseUrl, "/stats", { method: "GET" });
}

export function createBenchmarkTestSet(baseUrl, config) {
  return request(baseUrl, "/test-sets", {
    method: "POST",
    body: JSON.stringify(config)
  });
}

export function getBenchmarkTestSet(baseUrl, testSetId) {
  return request(baseUrl, `/test-sets/${encodeURIComponent(testSetId)}`, { method: "GET" });
}

export function submitBenchmarkAnswers(baseUrl, submission) {
  return request(baseUrl, "/submissions", {
    method: "POST",
    body: JSON.stringify(submission)
  }, 120_000);
}

export function getBenchmarkSubmission(baseUrl, submissionId) {
  return request(baseUrl, `/submissions/${encodeURIComponent(submissionId)}`, { method: "GET" });
}
