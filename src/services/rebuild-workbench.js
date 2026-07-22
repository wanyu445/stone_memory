const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getCfg, getThreadDir } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { listDateFiles } = require("../lib/archive-paths");
const { findThreadSessionFile } = require("../lib/thread-session-file");
const { dateKeyFromTs } = require("./memory-archive");

function itemKey(timestamp, role, text) {
  return crypto.createHash("sha256").update(`${timestamp || ""}\0${role || ""}\0${text || ""}`).digest("hex").slice(0, 24);
}

function readJsonl(file) {
  const rows = [];
  let malformed = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    try { rows.push(JSON.parse(line)); } catch { malformed++; }
  }
  return { rows, malformed };
}

function sessionFile(threadId, runtime) {
  const root = getCfg("sessionDir", threadId);
  return findThreadSessionFile(root, threadId);
}

function missingSessionMessage(threadId) {
  const root = getCfg("sessionDir", threadId);
  return `无法重建：在配置的线程文件目录中没有找到线程 ${threadId}。请前往设置修改线程文件目录，或检查对应文件是否存在（当前目录：${root || "未配置"}）`;
}

function textFromBlocks(content, types) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter(block => types.includes(block.type)).map(block => block.text || "").filter(Boolean).join("\n").trim();
}

function inspectClaude(rows, cutoff, toolLimit) {
  const items = [], tools = [], outputs = new Map();
  for (const row of rows) {
    if (row.type === "user" && Array.isArray(row.message?.content)) for (const block of row.message.content) {
      if (block.type === "tool_result" && block.tool_use_id) outputs.set(block.tool_use_id, block.content || "");
    }
  }
  for (const row of rows) {
    if (!row.timestamp || row.timestamp.slice(0, 10) < cutoff) continue;
    if (["user", "assistant"].includes(row.type)) {
      const text = textFromBlocks(row.message?.content, ["text", "thinking"]);
      if (text && !text.includes("<!-- stmem-rule:") && !text.includes("<memory_context>")) items.push({
        id: itemKey(row.timestamp, row.type, text), timestamp: row.timestamp, role: row.type, context: text,
      });
    }
    if (row.type === "assistant" && Array.isArray(row.message?.content)) for (const block of row.message.content) {
      if (block.type !== "tool_use" || !block.id || !outputs.has(block.id)) continue;
      tools.push({ id: block.id, timestamp: row.timestamp, name: block.name || "tool", context: JSON.stringify(block.input || {}).slice(0, 500), output: String(outputs.get(block.id) || "").slice(0, 500) });
    }
  }
  return { items: items.reverse(), tools: toolLimit > 0 ? tools.slice(-toolLimit).reverse() : [] };
}

function inspectCodex(rows, cutoff, toolLimit) {
  const items = [], tools = [], outputs = new Map();
  for (const row of rows) if (row.type === "response_item" && row.payload?.type === "function_call_output") outputs.set(row.payload.call_id, row.payload.output || "");
  for (const row of rows) {
    if (!row.timestamp || row.timestamp.slice(0, 10) < cutoff || row.type !== "response_item") continue;
    if (row.payload?.type === "message" && ["user", "assistant"].includes(row.payload.role)) {
      const text = textFromBlocks(row.payload.content, ["input_text", "output_text"]);
      if (text && !text.includes("<!-- stmem-rule:") && !text.includes("<memory_context>")) items.push({
        id: itemKey(row.timestamp, row.payload.role, text), timestamp: row.timestamp, role: row.payload.role, context: text,
      });
    }
    if (row.payload?.type === "function_call" && row.payload.call_id && outputs.has(row.payload.call_id)) tools.push({
      id: row.payload.call_id, timestamp: row.timestamp, name: row.payload.name || "function", context: String(row.payload.arguments || "").slice(0, 500), output: String(outputs.get(row.payload.call_id) || "").slice(0, 500),
    });
  }
  return { items: items.reverse(), tools: toolLimit > 0 ? tools.slice(-toolLimit).reverse() : [] };
}

function conversationDates(rows, runtime) {
  const dates = new Set();
  for (const row of rows) {
    let role, text;
    if (runtime === "codex") {
      if (row.type !== "response_item" || row.payload?.type !== "message") continue;
      role = row.payload.role;
      text = textFromBlocks(row.payload.content, ["input_text", "output_text"]);
    } else {
      role = row.type;
      text = textFromBlocks(row.message?.content, ["text", "thinking"]);
    }
    if (!["user", "assistant"].includes(role) || !text) continue;
    if (text.includes("<!-- stmem-rule:") || text.includes("<memory_context>")) continue;
    const date = dateKeyFromTs(row.timestamp);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date);
  }
  return [...dates].sort();
}

function conversationWindow(rows, runtime, windowDays) {
  const dates = conversationDates(rows, runtime);
  const activeDates = dates.slice(-Math.max(1, windowDays));
  const fallback = new Date().toISOString().slice(0, 10);
  return { cutoff: activeDates[0] || fallback, referenceDate: activeDates.at(-1) || fallback, activeDates };
}

function latestConversationDate(rows, runtime) {
  return conversationDates(rows, runtime).at(-1) || null;
}

function buildRebuildPreview(threadId, { windowDays = 3, toolPairs = 30 } = {}) {
  const runtime = getCfg("runtime", threadId, "claude");
  const file = sessionFile(threadId, runtime);
  if (!file) throw new Error(missingSessionMessage(threadId));
  const { rows, malformed } = readJsonl(file);
  const { cutoff, referenceDate, activeDates } = conversationWindow(rows, runtime, windowDays);
  const result = runtime === "codex" ? inspectCodex(rows, cutoff, toolPairs) : inspectClaude(rows, cutoff, toolPairs);
  return { threadId, runtime, file, windowDays, toolPairs, referenceDate, cutoff, activeDates, malformed, ...result };
}

function checkClaude(rows, threadId) {
  const uuids = new Set(rows.map(row => row.uuid).filter(Boolean));
  const duplicates = rows.map(row => row.uuid).filter(Boolean).filter((id, index, all) => all.indexOf(id) !== index);
  const sessionIds = new Set(rows.filter(row => row.type === "system" && row.subtype === "init").map(row => row.session_id).filter(Boolean));
  const orphans = rows.filter(row => row.parentUuid && !uuids.has(row.parentUuid) && !sessionIds.has(row.parentUuid));
  const toolUses = new Set(), toolResults = new Set();
  for (const row of rows) for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
    if (block.type === "tool_use" && block.id) toolUses.add(block.id);
    if (block.type === "tool_result" && block.tool_use_id) toolResults.add(block.tool_use_id);
  }
  const missingResults = [...toolUses].filter(id => !toolResults.has(id));
  const missingUses = [...toolResults].filter(id => !toolUses.has(id));
  return { threadId, runtime: "claude", duplicates: duplicates.length, orphanParents: orphans.length, missingToolResults: missingResults.length, missingToolUses: missingUses.length };
}

function checkCodex(rows, threadId) {
  const metas = rows.filter(row => row.type === "session_meta");
  const calls = new Set(rows.filter(row => row.type === "response_item" && row.payload?.type === "function_call").map(row => row.payload.call_id).filter(Boolean));
  const outputs = new Set(rows.filter(row => row.type === "response_item" && row.payload?.type === "function_call_output").map(row => row.payload.call_id).filter(Boolean));
  return { threadId, runtime: "codex", missingSessionMeta: metas.length ? 0 : 1, duplicateSessionMeta: Math.max(0, metas.length - 1), missingToolResults: [...calls].filter(id => !outputs.has(id)).length, missingToolCalls: [...outputs].filter(id => !calls.has(id)).length };
}

function checkThreadIntegrity(threadId) {
  const runtime = getCfg("runtime", threadId, "claude"), file = sessionFile(threadId, runtime);
  if (!file) throw new Error(missingSessionMessage(threadId));
  const { rows, malformed } = readJsonl(file);
  const details = runtime === "codex" ? checkCodex(rows, threadId) : checkClaude(rows, threadId);
  const issues = malformed + Object.entries(details).filter(([key]) => !["threadId", "runtime"].includes(key)).reduce((sum, [, value]) => sum + value, 0);
  return { file, malformed, ...details, issues, healthy: issues === 0 };
}

function repairThreadIntegrity(threadId) {
  const before = checkThreadIntegrity(threadId);
  if (before.healthy) return { repaired: false, before, after: before, message: "线程结构完整，无需修复" };
  const file = before.file;
  const { rows } = readJsonl(file);
  const backup = `${file}.integrity.${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}.bak`;
  fs.copyFileSync(file, backup);
  let output = rows;
  if (before.runtime === "claude") {
    const init = rows.find(row => row.type === "system" && row.subtype === "init");
    const root = init?.session_id || threadId;
    let parent = root;
    output = rows.map(row => {
      if (!row.uuid) return row;
      const next = { ...row, uuid: crypto.randomUUID(), parentUuid: parent };
      parent = next.uuid;
      return next;
    });
  } else {
    const seenMeta = { value: false };
    output = rows.filter(row => {
      if (row.type !== "session_meta") return true;
      if (seenMeta.value) return false;
      seenMeta.value = true; return true;
    });
    if (!seenMeta.value) output.unshift({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: threadId, timestamp: new Date().toISOString(), cwd: process.cwd(), originator: "codex" } });
  }
  const temp = `${file}.repair-${process.pid}`;
  fs.writeFileSync(temp, output.map(JSON.stringify).join("\n") + "\n", "utf8");
  fs.renameSync(temp, file);
  const after = checkThreadIntegrity(threadId);
  return { repaired: true, backup, before, after, message: after.healthy ? "已修复并通过复查" : "已修复结构链；仍有无法自动补造的工具调用配对" };
}

function loadRebuildPlan(file) {
  if (!file) return { excludedMessages: new Set(), excludedTools: new Set() };
  const plan = JSON.parse(fs.readFileSync(file, "utf8"));
  return { excludedMessages: new Set(plan.excludedMessages || []), excludedTools: new Set(plan.excludedTools || []) };
}

function claudeMessageKey(row) {
  if (!["user", "assistant"].includes(row.type)) return null;
  const text = textFromBlocks(row.message?.content, ["text", "thinking"]);
  return text ? itemKey(row.timestamp, row.type, text) : null;
}

function codexMessageKey(row) {
  if (row.type !== "response_item" || row.payload?.type !== "message" || !["user", "assistant"].includes(row.payload.role)) return null;
  const text = textFromBlocks(row.payload.content, ["input_text", "output_text"]);
  return text ? itemKey(row.timestamp, row.payload.role, text) : null;
}

function trimRows(rows, runtime, excludedMessages, excludedTools) {
  const removedTimestamps = new Set();
  let removedMessages = 0, removedTools = 0;
  const output = [];
  for (const original of rows) {
    const key = runtime === "codex" ? codexMessageKey(original) : claudeMessageKey(original);
    if (key && excludedMessages.has(key)) {
      if (original.timestamp) removedTimestamps.add(original.timestamp);
      removedMessages++; continue;
    }
    if (runtime === "codex" && original.type === "response_item" && ["function_call", "function_call_output"].includes(original.payload?.type) && excludedTools.has(original.payload?.call_id)) {
      removedTools++; continue;
    }
    if (runtime === "claude" && ["user", "assistant"].includes(original.type) && Array.isArray(original.message?.content)) {
      const blocks = original.message.content.filter(block => {
        const toolId = block.type === "tool_use" ? block.id : block.type === "tool_result" ? block.tool_use_id : null;
        if (toolId && excludedTools.has(toolId)) { removedTools++; return false; }
        return true;
      });
      if (!blocks.length) continue;
      output.push({ ...original, message: { ...original.message, content: blocks } });
      continue;
    }
    output.push(original);
  }
  return { rows: output, removedTimestamps, removedMessages, removedTools };
}

function writeJsonlAtomic(file, rows) {
  const temp = `${file}.trim-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, rows.map(JSON.stringify).join("\n") + "\n", "utf8");
  fs.renameSync(temp, file);
}

function permanentlyTrimThread(threadId, { excludedMessages = [], excludedTools = [] } = {}) {
  const messageSet = new Set(excludedMessages), toolSet = new Set(excludedTools);
  if (!messageSet.size && !toolSet.size) return { removedMessages: 0, removedTools: 0, archiveMessages: 0, fullRecords: 0 };
  const runtime = getCfg("runtime", threadId, "claude"), file = sessionFile(threadId, runtime);
  if (!file) throw new Error(missingSessionMessage(threadId));
  const current = readJsonl(file);
  if (current.malformed) throw new Error("活动线程包含损坏 JSON，永久裁剪前请先检查并修复");
  const trimmed = trimRows(current.rows, runtime, messageSet, toolSet);
  writeJsonlAtomic(file, trimmed.rows);

  // full 是重建源之一；若之前重建曾备份过同一条近期消息，必须同步清除，
  // 否则它会在下一次 rebuild 中重新出现。这里不生成可恢复副本。
  let fullRecords = 0;
  const fullDir = path.join(getThreadDir(threadId), "memory", "archive", "full");
  for (const { file: fullFile } of listDateFiles(fullDir)) {
    const source = readJsonl(fullFile);
    if (source.malformed) continue;
    const result = trimRows(source.rows, runtime, messageSet, toolSet);
    const removed = source.rows.length - result.rows.length;
    if (removed || result.removedTools) { writeJsonlAtomic(fullFile, result.rows); fullRecords += removed; }
  }

  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const store = new MemoryStore({ memoryDir, threadId });
  let archiveMessages = 0;
  try {
    const remove = store.db.prepare("DELETE FROM messages WHERE thread_id=? AND timestamp=?");
    archiveMessages = store.db.transaction(timestamps => {
      let count = 0;
      for (const timestamp of timestamps) count += remove.run(threadId, timestamp).changes;
      return count;
    })([...trimmed.removedTimestamps]);
  } finally { store.close(); }
  return { removedMessages: trimmed.removedMessages, removedTools: trimmed.removedTools, archiveMessages, fullRecords };
}

module.exports = { itemKey, inspectClaude, inspectCodex, conversationDates, conversationWindow, latestConversationDate, buildRebuildPreview, checkThreadIntegrity, repairThreadIntegrity, loadRebuildPlan, permanentlyTrimThread, trimRows, sessionFile };
