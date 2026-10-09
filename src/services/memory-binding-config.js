const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getMemoryContext, listMemoryIds, loadConfig } = require("../config");
const { findThreadSessionFile, listCodexSuccessors, resolveThreadSession, runtimeSessionMeta } = require("../lib/thread-session-file");
const { MemoryStore } = require("../storage/memory-store");
const { openDatabase } = require("../storage/database");
const { addBinding: registerBinding } = require("./memory-bindings");
const { writeJson } = require("./memory-setup");
const { saveConfig } = require("./thread-setup");
const { rebalanceWatcherBindings } = require("./watcher-bindings");
const { associateRebuildStateWithBinding } = require("./rebuild-log");

const PROVIDERS = new Set(["claude", "codex"]);
const MODES = new Set(["primary", "parallel", "child", "import_only"]);

function bindingId(memoryId, provider, externalThreadId) {
  return `binding_${crypto.createHash("sha256").update(`${memoryId}\0${provider}\0${externalThreadId}`).digest("hex").slice(0, 20)}`;
}

function bindingFile(memoryId) {
  const context = getMemoryContext(memoryId);
  if (context.layout !== "memory-v1") throw new Error("旧布局记忆体需先迁移后再使用新 Binding 配置");
  return { context, file: path.join(context.root, "bindings.json") };
}

function readBindingConfig(memoryId) {
  const { file } = bindingFile(memoryId);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  return { schemaVersion: 1, revision: Math.max(0, Number(value.revision) || 0), primaryBindingId: value.primaryBindingId || null, bindings: Array.isArray(value.bindings) ? value.bindings : [] };
}

function validateBindingInput(memoryId, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Binding 必须是 JSON 对象");
  const unknown = Object.keys(input).filter(key => !["provider", "externalThreadId", "sessionRoot", "mode", "enabled"].includes(key));
  if (unknown.length) throw new Error(`不支持的 Binding 字段：${unknown.join("、")}`);
  const provider = String(input.provider || "").trim().toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error("Binding provider 必须是 claude 或 codex");
  const externalThreadId = String(input.externalThreadId || "").trim();
  if (!externalThreadId || !/^[A-Za-z0-9._:-]+$/u.test(externalThreadId)) throw new Error("需要填写合法的外部线程 ID");
  const rawRoot = String(input.sessionRoot || "").trim();
  const sessionRoot = path.resolve(rawRoot || ".");
  if (!rawRoot || !fs.existsSync(sessionRoot) || !fs.statSync(sessionRoot).isDirectory()) throw new Error(`线程搜索目录不存在：${sessionRoot}`);
  const resolvedThreadFile = findThreadSessionFile(sessionRoot, externalThreadId);
  if (!resolvedThreadFile) throw new Error(`在指定目录中找不到线程 ${externalThreadId} 的 JSONL 文件`);
  const mode = String(input.mode || "parallel").trim();
  if (!MODES.has(mode)) throw new Error(`不支持的 Binding 模式：${mode}`);
  return { id: bindingId(memoryId, provider, externalThreadId), memoryId, provider, externalThreadId, sessionRoot, resolvedThreadFile, mode, enabled: input.enabled !== false };
}

function planBindingAdd(memoryId, input) {
  const config = readBindingConfig(memoryId);
  const binding = validateBindingInput(memoryId, input);
  for (const candidateMemoryId of listMemoryIds()) {
    if (candidateMemoryId === memoryId) continue;
    let candidate;
    try { candidate = readBindingConfig(candidateMemoryId); } catch { continue; }
    const occupied = candidate.bindings.find(item => item.externalThreadId === binding.externalThreadId);
    if (occupied) {
      throw new Error(`当前窗口已绑定到其他记忆体（${candidateMemoryId}），Stone Memory 不支持改绑`);
    }
  }
  const existing = config.bindings.find(item => item.id === binding.id);
  const capacity = existing ? { bindings: config.bindings, stoppedBindingIds: [] } : rebalanceWatcherBindings([...config.bindings, binding]);
  return { dryRun: true, action: existing ? "existing" : "create", binding: existing || binding, revision: config.revision, stoppedBindingIds: capacity.stoppedBindingIds };
}

function applyBindingAdd(memoryId, input, { preserveWatcher = false } = {}) {
  const { context, file } = bindingFile(memoryId);
  const plan = planBindingAdd(memoryId, input);
  const config = readBindingConfig(memoryId);
  const candidate = plan.binding;
  const existing = config.bindings.find(item => item.id === candidate.id);
  if (existing) return { applied: true, changed: false, binding: existing, config };
  const now = new Date().toISOString();
  const binding = { ...candidate, createdAt: now, updatedAt: now };
  const capacity = rebalanceWatcherBindings([...config.bindings, binding]);
  const next = { ...config, revision: config.revision + 1, primaryBindingId: config.primaryBindingId || binding.id, bindings: capacity.bindings.map(item => item.id === binding.id ? { ...item, createdAt: now, updatedAt: now } : item) };
  const original = fs.readFileSync(file, "utf8");
  const memoryFile = path.join(context.root, "memory.json");
  const originalMemory = fs.readFileSync(memoryFile, "utf8");
  const watcherFile = path.join(context.root, "watcher.json");
  const originalWatcher = fs.readFileSync(watcherFile, "utf8");
  const originalRegistry = loadConfig();
  const firstBinding = config.bindings.length === 0;
  const memoryDir = path.join(context.root, "memory");
  const probe = openDatabase(memoryDir);
  const threadExisted = !!probe.prepare("SELECT 1 FROM threads WHERE id=?").get(memoryId);
  probe.close();
  const store = new MemoryStore({ memoryDir, threadId: memoryId });
  try {
    store.db.transaction(() => {
      writeJson(file, next);
      store.registerThread({ runtime: binding.provider, purpose: null, label: null });
      const storedBinding = next.bindings.find(item => item.id === binding.id);
      registerBinding(store, { provider: binding.provider, externalThreadId: binding.externalThreadId, threadFile: binding.resolvedThreadFile, mode: next.primaryBindingId === binding.id ? "primary" : binding.mode, enabled: storedBinding?.enabled !== false });
      for (const stoppedId of capacity.stoppedBindingIds) {
        const stopped = next.bindings.find(item => item.id === stoppedId);
        if (!stopped) continue;
        store.db.prepare("UPDATE memory_bindings SET enabled=0,updated_at=? WHERE memory_id=? AND provider=? AND external_thread_id=?")
          .run(now, memoryId, stopped.provider, stopped.externalThreadId);
      }
      const memory = JSON.parse(originalMemory);
      if (memory.status !== "active") {
        memory.status = "active";
        memory.updatedAt = now;
        writeJson(memoryFile, memory);
        const registry = loadConfig();
        registry.memories = registry.memories || {};
        registry.memories[memoryId] = {
          ...(registry.memories[memoryId] || {}), memoryId, label: memory.label,
          status: "active", createdAt: memory.createdAt, updatedAt: now,
        };
        saveConfig(registry);
      }
      if (firstBinding && !preserveWatcher) {
        const watcher = JSON.parse(originalWatcher);
        writeJson(watcherFile, {
          ...watcher,
          enabled: true,
          modules: { ...(watcher.modules || {}), archive: true, miner: true },
          updatedAt: now,
        });
      }
    })();
  } catch (error) {
    fs.writeFileSync(file, original, { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(memoryFile, originalMemory, { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(watcherFile, originalWatcher, { encoding: "utf8", mode: 0o600 });
    saveConfig(originalRegistry);
    if (!threadExisted) store.db.prepare("DELETE FROM threads WHERE id=?").run(memoryId);
    throw error;
  } finally {
    store.close();
  }
  return { applied: true, changed: true, binding: next.bindings.find(item => item.id === binding.id), config: next, stoppedBindingIds: capacity.stoppedBindingIds, automationEnabled: firstBinding };
}

function legacyBindingInput(memoryId) {
  const context = getMemoryContext(memoryId);
  const config = readBindingConfig(memoryId);
  if (config.bindings.length || !context.legacyKey) return null;
  const legacy = loadConfig()[context.legacyKey] || {};
  const provider = legacy.runtime === "codex" ? "codex" : "claude";
  const externalThreadId = String(legacy.externalThreadId || context.legacyKey || "").trim();
  const sessionRoot = String(legacy.sessionDir || "").trim();
  if (!externalThreadId || !sessionRoot) return null;
  return { provider, externalThreadId, sessionRoot, mode: "primary", enabled: true };
}

function migrateLegacyBinding(memoryId, { apply = false } = {}) {
  const config = readBindingConfig(memoryId);
  if (config.bindings.length) return { memoryId, changed: false, reason: "bindings-exist", config };
  const input = legacyBindingInput(memoryId);
  if (!input) return { memoryId, changed: false, reason: "legacy-binding-not-found", config };
  if (!apply) return planBindingAdd(memoryId, input);
  const result = applyBindingAdd(memoryId, input, { preserveWatcher: true });
  if (result.changed && result.binding?.id === result.config?.primaryBindingId) {
    associateRebuildStateWithBinding(memoryId, result.binding.id);
  }
  return result;
}

function planBindingSuccessorDiscovery(memoryId) {
  const config = readBindingConfig(memoryId);
  const existing = new Set(config.bindings.map(item => `${item.provider}\0${item.externalThreadId}`));
  const candidates = [], leaves = [], supersededExternalThreadIds = new Set();
  const seen = new Set();
  const roots = new Map();
  for (const binding of config.bindings.filter(item => item.mode !== "import_only")) {
    const key = `${binding.provider}\0${binding.sessionRoot}`;
    if (!roots.has(key)) roots.set(key, { provider: binding.provider, sessionRoot: binding.sessionRoot, externalThreadIds: [] });
    roots.get(key).externalThreadIds.push(binding.externalThreadId);
  }
  for (const { provider, sessionRoot, externalThreadIds } of roots.values()) {
    const successors = provider === "codex"
      ? listCodexSuccessors(sessionRoot, externalThreadIds)
      : externalThreadIds.flatMap(externalThreadId => {
        const resolved = resolveThreadSession({ root: sessionRoot, threadId: externalThreadId, runtime: "claude" });
        return (resolved?.branches || []).map(branch => ({
          id: branch.threadId, parentId: branch.parentThreadId, file: branch.file,
          mtimeMs: runtimeSessionMeta(branch.file, "claude").mtimeMs,
        }));
      });
    const parentIds = new Set(successors.map(item => item.parentId).filter(Boolean));
    const leafNodes = successors.filter(item => !parentIds.has(item.id));
    if (leafNodes.length) {
      for (const id of externalThreadIds) supersededExternalThreadIds.add(id);
      for (const node of successors) if (parentIds.has(node.id)) supersededExternalThreadIds.add(node.id);
    }
    for (const successor of leafNodes) {
      const key = `${provider}\0${successor.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const leaf = {
        provider,
        externalThreadId: successor.id,
        sessionRoot,
        mode: "child",
        enabled: true,
        parentExternalThreadId: successor.parentId,
        resolvedThreadFile: successor.file,
        mtimeMs: successor.mtimeMs,
      };
      leaves.push(leaf);
      if (!existing.has(key)) candidates.push(leaf);
    }
  }
  const primaryLeaf = [...leaves].sort((a, b) => b.mtimeMs - a.mtimeMs || b.resolvedThreadFile.localeCompare(a.resolvedThreadFile))[0] || null;
  return {
    dryRun: true, action: "discover-successors", memoryId, revision: config.revision,
    changed: candidates.length > 0 || supersededExternalThreadIds.size > 0,
    topology: leaves.length <= 1 ? "linear" : "branched",
    candidates, leaves, primaryLeaf,
    supersededExternalThreadIds: [...supersededExternalThreadIds],
  };
}

function applyBindingSuccessorDiscovery(memoryId) {
  const plan = planBindingSuccessorDiscovery(memoryId);
  const added = [], stoppedBindingIds = [];
  for (const candidate of plan.candidates) {
    const result = applyBindingAdd(memoryId, {
      provider: candidate.provider,
      externalThreadId: candidate.externalThreadId,
      sessionRoot: candidate.sessionRoot,
      mode: candidate.mode,
      enabled: candidate.enabled,
    });
    if (result.changed) added.push(result.binding);
    stoppedBindingIds.push(...(result.stoppedBindingIds || []));
  }
  let primaryChanged = false;
  if (plan.primaryLeaf) {
    const current = readBindingConfig(memoryId);
    const primary = current.bindings.find(item => item.provider === plan.primaryLeaf.provider && item.externalThreadId === plan.primaryLeaf.externalThreadId);
    if (primary && current.primaryBindingId !== primary.id) {
      applyBindingPrimary(memoryId, primary.id);
      associateRebuildStateWithBinding(memoryId, primary.id);
      primaryChanged = true;
    }
  }
  const disabledBindingIds = [];
  for (const binding of readBindingConfig(memoryId).bindings) {
    if (binding.enabled === false || !plan.supersededExternalThreadIds.includes(binding.externalThreadId)) continue;
    applyBindingState(memoryId, binding.id, "disable");
    disabledBindingIds.push(binding.id);
  }
  return {
    dryRun: false,
    applied: true,
    changed: added.length > 0 || primaryChanged || disabledBindingIds.length > 0,
    action: plan.action,
    memoryId,
    added,
    topology: plan.topology,
    leaves: plan.leaves,
    primaryLeaf: plan.primaryLeaf,
    primaryChanged,
    disabledBindingIds,
    stoppedBindingIds: [...new Set(stoppedBindingIds)],
    config: readBindingConfig(memoryId),
  };
}

function getConfiguredBinding(memoryId, id) {
  const config = readBindingConfig(memoryId);
  const binding = config.bindings.find(item => item.id === id);
  if (!binding) throw new Error(`Binding 不存在：${id}`);
  return binding;
}

function resolvePrimaryBinding(memoryId, { requireFile = true } = {}) {
  const config = readBindingConfig(memoryId);
  if (!config.primaryBindingId) throw new Error("记忆体尚未设置主窗口 Binding");
  const binding = config.bindings.find(item => item.id === config.primaryBindingId);
  if (!binding) throw new Error("主窗口 Binding 不存在");
  const resolvedThreadFile = findThreadSessionFile(binding.sessionRoot, binding.externalThreadId);
  if (requireFile && !resolvedThreadFile) throw new Error(`主窗口文件已失效：找不到线程 ${binding.externalThreadId}`);
  return { ...binding, resolvedThreadFile: resolvedThreadFile || null, bindingRevision: config.revision };
}

function switchToken(memoryId, config, binding, file) {
  const stat = fs.statSync(file);
  return crypto.createHash("sha256").update([
    memoryId, config.revision, config.primaryBindingId || "", binding.id,
    file, stat.size, Math.floor(stat.mtimeMs),
  ].join("\0")).digest("hex");
}

function planBindingSwitch(memoryId, id) {
  const config = readBindingConfig(memoryId);
  const binding = getConfiguredBinding(memoryId, id);
  if (binding.enabled === false) throw new Error("不能切换到已停用的 Binding");
  const resolvedThreadFile = findThreadSessionFile(binding.sessionRoot, binding.externalThreadId);
  if (!resolvedThreadFile) throw new Error(`目标窗口已失效：找不到线程 ${binding.externalThreadId}`);
  return {
    dryRun: true, action: config.primaryBindingId === id ? "already-primary" : "switch",
    memoryId, fromBindingId: config.primaryBindingId, toBindingId: id,
    binding: { ...binding, resolvedThreadFile }, revision: config.revision,
    planToken: switchToken(memoryId, config, binding, resolvedThreadFile),
  };
}

function planBindingPrimary(memoryId, id) {
  const config = readBindingConfig(memoryId);
  const binding = getConfiguredBinding(memoryId, id);
  return {
    dryRun: true, action: config.primaryBindingId === id ? "already-primary" : "set-primary",
    changed: config.primaryBindingId !== id, memoryId,
    fromBindingId: config.primaryBindingId, toBindingId: id, binding, revision: config.revision,
  };
}

function applyBindingPrimary(memoryId, id) {
  const plan = planBindingPrimary(memoryId, id);
  if (!plan.changed) return { ...plan, dryRun: false, applied: true };
  const { context, file } = bindingFile(memoryId);
  const config = readBindingConfig(memoryId);
  const now = new Date().toISOString();
  const next = {
    ...config, revision: config.revision + 1, primaryBindingId: id,
    bindings: config.bindings.map(item => ({
      ...item,
      mode: item.id === id ? "primary" : (item.id === config.primaryBindingId && item.mode === "primary" ? "parallel" : item.mode),
      updatedAt: item.id === id || item.id === config.primaryBindingId ? now : item.updatedAt,
    })),
  };
  const original = fs.readFileSync(file, "utf8");
  writeJson(file, next);
  try {
    const store = new MemoryStore({ memoryDir: path.join(context.root, "memory"), threadId: memoryId });
    try {
      store.db.transaction(() => {
        store.db.prepare("UPDATE memory_bindings SET mode='parallel',updated_at=? WHERE memory_id=? AND mode='primary'").run(now, memoryId);
        store.db.prepare("UPDATE memory_bindings SET mode='primary',enabled=1,updated_at=? WHERE memory_id=? AND provider=? AND external_thread_id=?")
          .run(now, memoryId, plan.binding.provider, plan.binding.externalThreadId);
      })();
    } finally { store.close(); }
  } catch (error) {
    fs.writeFileSync(file, original, { encoding: "utf8", mode: 0o600 });
    throw error;
  }
  return { ...plan, dryRun: false, applied: true, changed: true, config: next };
}

function applyBindingSwitch(memoryId, id, { confirmedPlan, rebuild } = {}) {
  if (typeof rebuild !== "function") throw new Error("Binding 切换缺少正式 rebuild 执行器");
  const plan = planBindingSwitch(memoryId, id);
  if (!confirmedPlan || confirmedPlan !== plan.planToken) throw new Error("Binding 切换计划已过期，请重新预览");
  if (plan.action === "already-primary") return { applied: true, changed: false, ...plan };
  const { context, file } = bindingFile(memoryId);
  if (context.watcherConfig?.enabled) {
    throw new Error("记忆体 watcher 正在运行；安全改绑需先通过正式 watcher CLI 停用，改绑完成后再恢复");
  }
  const config = readBindingConfig(memoryId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dataRoot = path.dirname(path.dirname(context.root));
  const backup = path.join(dataRoot, "backups", "binding-switch", memoryId, `${stamp}-${path.basename(plan.binding.resolvedThreadFile)}`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(plan.binding.resolvedThreadFile, backup);
  const originalConfig = fs.readFileSync(file, "utf8");
  try {
    const rebuildResult = rebuild(plan.binding);
    if (!rebuildResult || rebuildResult.status !== 0) throw new Error(rebuildResult?.error || `目标窗口 rebuild 失败（退出码 ${rebuildResult?.status ?? "未知"}）`);
    const now = new Date().toISOString();
    const next = {
      ...config, revision: config.revision + 1, primaryBindingId: id,
      bindings: config.bindings.map(item => ({
        ...item,
        mode: item.id === id ? "primary" : (item.id === config.primaryBindingId && item.mode === "primary" ? "parallel" : item.mode),
        updatedAt: item.id === id || item.id === config.primaryBindingId ? now : item.updatedAt,
      })),
    };
    writeJson(file, next);
    const store = new MemoryStore({ memoryDir: path.join(context.root, "memory"), threadId: memoryId });
    try {
      store.db.transaction(() => {
        store.db.prepare("UPDATE memory_bindings SET mode='parallel',updated_at=? WHERE memory_id=? AND mode='primary'").run(now, memoryId);
        store.db.prepare("UPDATE memory_bindings SET mode='primary',enabled=1,updated_at=? WHERE memory_id=? AND provider=? AND external_thread_id=?")
          .run(now, memoryId, plan.binding.provider, plan.binding.externalThreadId);
      })();
    } finally { store.close(); }
    return { applied: true, changed: true, memoryId, fromBindingId: config.primaryBindingId, toBindingId: id, backup, rebuild: rebuildResult.output || "completed", config: next };
  } catch (error) {
    fs.writeFileSync(file, originalConfig, { encoding: "utf8", mode: 0o600 });
    fs.copyFileSync(backup, plan.binding.resolvedThreadFile);
    throw error;
  }
}

function planBindingState(memoryId, id, action) {
  if (!["enable", "disable", "remove"].includes(action)) throw new Error(`不支持的 Binding 操作：${action}`);
  const config = readBindingConfig(memoryId);
  const binding = getConfiguredBinding(memoryId, id);
  if (action === "remove" && config.primaryBindingId === id) {
    throw new Error("不能删除主 Binding；请先把另一个窗口设为主 Binding");
  }
  const changed = action === "remove" || binding.enabled !== (action === "enable");
  const proposed = action === "enable" && changed
    ? config.bindings.map(item => item.id === id ? { ...item, enabled: true } : item)
    : config.bindings;
  const capacity = action === "enable" && changed ? rebalanceWatcherBindings(proposed) : { bindings: proposed, stoppedBindingIds: [] };
  return { dryRun: true, action, changed, memoryId, binding, revision: config.revision, stoppedBindingIds: capacity.stoppedBindingIds };
}

function applyBindingState(memoryId, id, action) {
  const plan = planBindingState(memoryId, id, action);
  if (!plan.changed) return { ...plan, dryRun: false, applied: true };
  const { context, file } = bindingFile(memoryId);
  const config = readBindingConfig(memoryId);
  const now = new Date().toISOString();
  const proposedBindings = action === "remove"
    ? config.bindings.filter(item => item.id !== id)
    : config.bindings.map(item => item.id === id ? { ...item, enabled: action === "enable", updatedAt: now } : item);
  const capacity = action === "enable" ? rebalanceWatcherBindings(proposedBindings) : { bindings: proposedBindings, stoppedBindingIds: [] };
  const stoppedBindingIds = capacity.stoppedBindingIds;
  const finalBindings = capacity.bindings;
  const next = { ...config, revision: config.revision + 1, bindings: finalBindings };
  const original = fs.readFileSync(file, "utf8");
  writeJson(file, next);
  try {
    const store = new MemoryStore({ memoryDir: path.join(context.root, "memory"), threadId: memoryId });
    try {
      // SQLite keeps the provenance row even after configuration removal because
      // imported messages and import batches may still reference this Binding.
      store.db.prepare("UPDATE memory_bindings SET enabled=?,updated_at=? WHERE memory_id=? AND provider=? AND external_thread_id=?")
        .run(action === "enable" ? 1 : 0, now, memoryId, plan.binding.provider, plan.binding.externalThreadId);
      for (const stoppedId of stoppedBindingIds) {
        const stopped = next.bindings.find(item => item.id === stoppedId);
        if (!stopped || stopped.id === id) continue;
        store.db.prepare("UPDATE memory_bindings SET enabled=0,updated_at=? WHERE memory_id=? AND provider=? AND external_thread_id=?")
          .run(now, memoryId, stopped.provider, stopped.externalThreadId);
      }
    } finally { store.close(); }
  } catch (error) {
    fs.writeFileSync(file, original, { encoding: "utf8", mode: 0o600 });
    throw error;
  }
  return { applied: true, changed: true, action, memoryId, bindingId: id, config: next, stoppedBindingIds };
}

module.exports = {
  bindingId, readBindingConfig, validateBindingInput, planBindingAdd, applyBindingAdd,
  getConfiguredBinding, resolvePrimaryBinding, planBindingSwitch, applyBindingSwitch,
  planBindingPrimary, applyBindingPrimary,
  planBindingState, applyBindingState,
  migrateLegacyBinding, planBindingSuccessorDiscovery, applyBindingSuccessorDiscovery,
};
