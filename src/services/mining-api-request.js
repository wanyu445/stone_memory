// Bounded transport recovery. Never include credentials or provider bodies in errors.
async function requestMiningApi(url, options, { timeoutMs = 120000, backoffMs = 500, fetchImpl = globalThis.fetch } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retry = false;
    let received = false;
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      received = true;
      if (!response.ok) {
        const error = Object.assign(new Error(`API HTTP ${response.status}`), { code: `API_HTTP_${response.status}` });
        retry = [429, 502, 503, 504, 524].includes(response.status);
        await response.body?.cancel();
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (!error.code?.startsWith("API_HTTP_")) {
        if (controller.signal.aborted) error = Object.assign(new Error("API request timed out"), { code: "API_TIMEOUT" });
        else if (!received) error = Object.assign(new Error("API connection failed"), { code: "API_CONNECTION" });
        else error = Object.assign(new Error("API response is not valid JSON"), { code: "API_RESPONSE_INVALID" });
        retry = ["API_TIMEOUT", "API_CONNECTION"].includes(error.code);
      }
      if (!retry || attempt === 1) throw error;
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, backoffMs));
  }
}
module.exports = { requestMiningApi };
