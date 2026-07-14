/**
 * AI 输出 JSON 解析 — 收拢 memory-miner.js 和 mcp-server.js 中重复的提取逻辑。
 *
 * 提供:
 *   - parseJsonArray(text)   — 解析 AI 输出的 JSON 数组（多级 fallback）
 *   - parseJsonObject(text)  — 解析 AI 输出的 JSON 对象
 */

/** 从 AI 文本输出中提取 JSON 数组。容错：直接 parse → markdown code fence → 空数组 */
function parseJsonArray(text) {
  const trimmed = text.trim();
  // 直接 parse
  try { const p = JSON.parse(trimmed); return Array.isArray(p) ? p : []; } catch {}
  // markdown code fence
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { const p = JSON.parse(fence[1].trim()); return Array.isArray(p) ? p : []; } catch {}
  }
  return [];
}

/** 从 AI 文本输出中提取 JSON 对象。容错：直接 parse → markdown code fence → null */
function parseJsonObject(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }
  return null;
}

module.exports = { parseJsonArray, parseJsonObject };
