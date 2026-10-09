"use strict";

const { loadConfig, getMemoryRuntimeConfig } = require("../config");
const { resolveMiningApiCredentials } = require("./mining-engine-config");
const { buildMiningApiBody, normalizeMiningApiProfile } = require("./mining-api-profile");
const { runSubagent } = require("./subagent-runner");

function resolveConfiguredGenerationMode(threadId, { loadConfigImpl = loadConfig } = {}) {
  const normalizedThreadId = requiredThreadId(threadId);
  const config = loadConfigImpl();
  const thread = generationConfig(config, normalizedThreadId);
  return thread.minerMode === "api" ? "api" : "subagent";
}

async function runConfiguredGeneration({
  threadId,
  prompt,
  systemPrompt = "",
  opsFile = null,
  timeout = 180_000,
  temperature = 0.5,
}, {
  loadConfigImpl = loadConfig,
  resolveCredentialsImpl = resolveMiningApiCredentials,
  runSubagentImpl = runSubagent,
  fetchImpl = fetch,
} = {}) {
  const normalizedThreadId = requiredThreadId(threadId);
  const normalizedPrompt = String(prompt || "").trim();
  if (!normalizedPrompt) throw new Error("configured generation requires prompt");
  const config = loadConfigImpl();
  const thread = generationConfig(config, normalizedThreadId);
  if (thread.minerMode !== "api") {
    return normalizeText(runSubagentImpl(normalizedPrompt, {
      threadId: normalizedThreadId,
      opsFile: opsFile || undefined,
      timeout,
    }));
  }

  const credentials = resolveCredentialsImpl({
    config,
    threadId: normalizedThreadId,
    provider: thread.apiProvider,
  });
  const profile = normalizeMiningApiProfile(thread.miningApiProfile || thread.apiProfile || "optimized");
  const model = String(credentials.model || "").replace(/\[\d+[km]\]/i, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetchImpl(`${String(credentials.baseUrl).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify(buildMiningApiBody({
        profile,
        model,
        temperature,
        messages: [
          ...(String(systemPrompt || "").trim()
            ? [{ role: "system", content: String(systemPrompt).trim() }]
            : []),
          { role: "user", content: normalizedPrompt },
        ],
      })),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`API ${response.status}: ${detail.slice(0, 240)}`);
  }
  const payload = await response.json();
  return normalizeText(payload?.choices?.[0]?.message?.content);
}

function generationConfig(config, memoryId) {
  return config.memories?.[memoryId]
    ? getMemoryRuntimeConfig(memoryId, config)
    : config[memoryId] || {};
}

function normalizeText(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("模型没有返回奖励内容");
  return text;
}

function requiredThreadId(value) {
  const threadId = String(value || "").trim();
  if (!threadId || threadId === "." || threadId === ".." || /[\\/]/.test(threadId)) {
    throw new Error("invalid threadId");
  }
  return threadId;
}

module.exports = {
  resolveConfiguredGenerationMode,
  runConfiguredGeneration,
};
