const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { getCfg, getThreadDir, listThreadIds, listMemoryIds, getMemoryRuntimeConfig } = require("../../config");
const { runSubagent } = require("../../services/subagent-runner");
const { readFeelings: readDatabaseFeelings, readFeatures: readDatabaseFeatures } = require("../../storage/memory-reader");
const { MemoryStore } = require("../../storage/memory-store");
const { resolveMcpThread } = require("../../services/mcp-thread-resolution");
const { buildMcpRebuildRequest, buildMcpRebuildPreviewArgs, buildMcpRebuildExecuteArgs } = require("../../services/mcp-rebuild-preview");
const { buildMcpMineArgs } = require("../../services/mcp-mine-command");
const { NotebookService } = require("../../services/notebook-service");
const { listMemories } = require("../../services/memory-setup");

const CONFIG_PATH = path.join(os.homedir(), ".stone_memory", "stmem.json");
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const LOG_FILE = path.join(os.homedir(), ".stone_memory", "logs", "mcp.log");
const SEARCH_ONLY = process.env.STMEM_SEARCH_ONLY === "1";
const NOTEBOOK_STEWARD_MODE = process.env.STMEM_NOTEBOOK_STEWARD === "1";
const SEARCH_THREAD_ID = String(process.env.STMEM_THREAD_ID || "").trim();
const MAX_DEEP_SEARCH_TOOL_CALLS = 5;
const MAX_NOTEBOOK_STEWARD_TOOL_CALLS = 6;
const rebuildPreviews = new Map();

function feelingDate(month, day, feeling) {
  let year;
  if (feeling && feeling.createdAt) { const y = new Date(feeling.createdAt).getFullYear(); if (!isNaN(y)) year = y; }
  if (!year) { const now = new Date(); year = parseInt(month) > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear(); }
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return null; }
}

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, "utf8"); } catch {}
}

function resolveThread(args = {}, cfg) {
  const config = cfg || {};
  let callingBinding = null;
  const sessionId = resolveMcpThread(args, config, listThreadIds(), process.env, {
    onResolveBinding(binding) { callingBinding = binding; },
  });
  const tc = getMemoryRuntimeConfig(sessionId);
  return {
    threadId: sessionId,
    bindingId: callingBinding?.bindingId || null,
    externalThreadId: callingBinding?.externalThreadId || null,
    runtime: callingBinding?.provider || tc.runtime || "claude",
    windowDays: args.context?.windowDays || args.window || tc.windowDays || 1,
    toolPairs: args.context?.toolPairs ?? args.toolPairs ?? tc.keepToolPairs ?? 15,
  };
}


module.exports = { fs, path, os, execFileSync, getCfg, getThreadDir, listThreadIds, listMemoryIds, runSubagent, readDatabaseFeelings, readDatabaseFeatures, MemoryStore, resolveMcpThread, buildMcpRebuildRequest, buildMcpRebuildPreviewArgs, buildMcpRebuildExecuteArgs, buildMcpMineArgs, NotebookService, listMemories, PROJECT_ROOT, SEARCH_ONLY, NOTEBOOK_STEWARD_MODE, SEARCH_THREAD_ID, MAX_DEEP_SEARCH_TOOL_CALLS, MAX_NOTEBOOK_STEWARD_TOOL_CALLS, rebuildPreviews, feelingDate, loadConfig, log, resolveThread };
