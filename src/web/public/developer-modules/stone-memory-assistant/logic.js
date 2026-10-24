(function (root, factory) {
  "use strict";
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  if (root) root.StoneAssistantLogic = value;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  const TERMINAL_MINING = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);
  const COMPLETE_DAY = new Set(["completed", "completed_empty"]);
  const NICKNAMES = Object.freeze(["青团", "团团", "小芽", "糯糯", "阿青", "小满", "奶盖", "小栗"]);
  const MOBILE_TAP_WINDOW_MS = 4000;

  function normalizeText(value) {
    return String(value || "").toLocaleLowerCase().replace(/[\s，。！？、；：,.!?;:()（）【】\[\]"“”'‘’_-]+/g, "");
  }

  function hashString(value) {
    const input = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function nicknameForThread(threadId) {
    const value = String(threadId || "").trim();
    return value ? NICKNAMES[hashString(value) % NICKNAMES.length] : "";
  }

  function isMobileAssistantEnvironment({ coarsePointer = false, width = 0, height = 0 } = {}) {
    return Boolean(coarsePointer) && (Number(width) <= 680 || Number(height) <= 520);
  }

  function mobileLauncherAction({ mobile = false, panelOpen = false, phase = "idle", armedUntil = 0, now = Date.now() } = {}) {
    if (!mobile) return panelOpen ? "close" : "open";
    if (panelOpen) return "close";
    if (phase !== "idle") return "open";
    return Number(armedUntil) > Number(now) ? "open" : "interact";
  }

  function beijingDateKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function shiftDate(dateKey, days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return "";
    const date = new Date(`${dateKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    return date.toISOString().slice(0, 10);
  }

  function parseCommand(raw) {
    const text = String(raw || "").trim();
    if (!text) return { type: "empty" };
    if (/^(?:介绍(?:一下)?(?:stone\s*memory|磐石记忆)?|stone\s*memory是什么|这个项目(?:是|做)什么)/i.test(text)) return { type: "intro" };
    if (/^(?:有什么待处理|检查一下|检查状态|现在怎么样|今日待办|待办)$/.test(text)) return { type: "todos" };
    if (/^(?:一键维护|自动维护|自动管理|全部处理|帮我整理)$/.test(text)) return { type: "auto_maintenance" };
    if (/^(?:停止挖掘|停止整理|取消挖掘)$/.test(text)) return { type: "stop_mining" };
    if (/^(?:预览重建|重建预览|重建前看看|这次会带什么记忆)$/.test(text)) return { type: "preview_rebuild" };
    if (/^(?:确认重建|应用重建|执行重建)$/.test(text)) return { type: "apply_rebuild" };
    if (/^(?:帮我)?(?:整理|挖掘)昨天(?:的记忆)?$/.test(text)) return { type: "mine_yesterday" };
    if (/^(?:帮我)?(?:整理|挖掘)今天(?:的记忆)?$/.test(text)) return { type: "mine_today" };
    const mine = text.match(/^(?:挖掘|整理)\s*(\d{4}-\d{2}-\d{2})$/);
    if (mine) return { type: "mine_date", date: mine[1] };
    const recent = text.match(/^(?:最近\s*)?(7|30)\s*天(?:摘要|总结|发生了什么)?$/);
    if (recent) return { type: "recent", days: Number(recent[1]) };
    return { type: "question", text };
  }

  function isInternalQuestion(raw) {
    const text = String(raw || "").trim();
    return /算法|原理|源码|源代码|代码实现|数据库结构|数据表结构|表结构|提示词|prompt|评分规则|内部阈值|系统架构|技术架构|内部调用|调用链|模型策略/i.test(text);
  }

  function matchKnowledge(query, entries, limit = 3) {
    const normalized = normalizeText(query);
    if (!normalized) return [];
    return (entries || []).map(entry => {
      const title = normalizeText(entry.title);
      const answer = normalizeText(entry.answer);
      let score = title === normalized ? 100 : title.includes(normalized) || normalized.includes(title) ? 45 : 0;
      for (const keyword of entry.keywords || []) {
        const key = normalizeText(keyword);
        if (!key) continue;
        if (normalized === key) score += 60;
        else if (normalized.includes(key)) score += Math.min(32, 10 + key.length * 2);
        else if (key.includes(normalized) && normalized.length >= 2) score += 8;
      }
      if (answer.includes(normalized) && normalized.length >= 3) score += 6;
      return { entry, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title)).slice(0, limit);
  }

  function pendingMiningDates(dates, today = beijingDateKey()) {
    return (dates || []).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(String(row.date || "")) && row.date < today && row.status === "pending").map(row => row.date).sort();
  }

  function createMiningPlan({ dates = [], mining = {}, automatic = false, mode = "" } = {}) {
    const selected = [...new Set(dates.map(String))].filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
    const rowsByDate = new Map((mining.dates || []).map(row => [String(row.date || ""), row]));
    return {
      dates: selected,
      automatic: automatic === true,
      mode: String(mode || ""),
      rows: selected.map(date => {
        const row = rowsByDate.get(date);
        return row ? { date, status: String(row.status || ""), messageCount: Number(row.messageCount) || 0 } : { date, status: "missing", messageCount: 0 };
      })
    };
  }

  function validateMiningPlan(plan, mining = {}, today = beijingDateKey()) {
    if (!plan || !["subagent", "api"].includes(plan.mode)) return { ok: false, code: "INVALID_MODE", message: "请重新选择有效的挖掘通道。" };
    if (!Array.isArray(plan.dates) || !plan.dates.length) return { ok: false, code: "EMPTY_DATES", message: "没有可以执行的挖掘日期。" };
    if (isMiningActive(mining.job)) return { ok: false, code: "MINING_ACTIVE", message: "当前已有挖掘任务运行，请等待它完成后再试。" };
    const current = new Map((mining.dates || []).map(row => [String(row.date || ""), row]));
    const snapshot = new Map((plan.rows || []).map(row => [String(row.date || ""), row]));
    const retryable = new Set(["pending", "failed", "partial_failed", "blocked"]);
    for (const date of plan.dates) {
      const before = snapshot.get(date);
      const row = current.get(date);
      if (!before || !row) return { ok: false, code: "DATE_MISSING", message: `${date} 的对话状态已经变化，请重新确认。` };
      const status = String(row.status || "");
      const messageCount = Number(row.messageCount) || 0;
      if (status !== before.status || messageCount !== before.messageCount) return { ok: false, code: "DATE_CHANGED", message: `${date} 的对话数量或挖掘状态已经变化，请重新确认。` };
      if (plan.automatic && (date >= today || status !== "pending")) return { ok: false, code: "AUTO_DATE_UNSAFE", message: `${date} 已不符合一键维护条件，请重新检查待办。` };
      if (!plan.automatic && !retryable.has(status)) return { ok: false, code: "DATE_NOT_RETRYABLE", message: `${date} 当前不能由小助理挖掘，请到正式工作台检查。` };
    }
    return { ok: true, code: "OK", message: "可以执行。" };
  }

  function isMiningActive(job) {
    return Boolean(job && ["queued", "running", "cancelling"].includes(job.status));
  }

  function canStopJob(mining, expectedJobId) {
    return Boolean(expectedJobId && isMiningActive(mining?.job) && mining.job.id === expectedJobId);
  }

  function needsRebuild(overview) {
    if (!overview || Number(overview.counts?.feelings || 0) < 1) return false;
    if (!overview.rebuild?.completedAt) return true;
    const mined = Date.parse(overview.lastMinedAt || "");
    const rebuilt = Date.parse(overview.rebuild.completedAt || "");
    return Number.isFinite(mined) && (!Number.isFinite(rebuilt) || mined > rebuilt);
  }

  function buildTodos({ overview = {}, mining = {}, today = beijingDateKey() } = {}) {
    const todos = [];
    if (isMiningActive(mining.job)) todos.push({ id: "mining-active", priority: 10, kind: "running", title: "记忆挖掘正在进行", detail: mining.job.currentDate ? `正在处理 ${mining.job.currentDate}` : "任务已经排队" });
    if (mining.job && ["failed", "completed_with_errors"].includes(mining.job.status)) {
      const failed = (mining.job.results || []).filter(row => row.status === "failed");
      todos.push({ id: "mining-failed", priority: 20, kind: "warning", title: "上次挖掘有失败项", detail: failed.length ? `${failed.length} 个日期需要检查或重试` : "请查看任务错误信息" });
    }
    const activeDates = isMiningActive(mining.job) ? new Set(mining.job.dates || []) : new Set();
    const pending = pendingMiningDates(mining.dates, today).filter(date => !activeDates.has(date));
    if (pending.length) todos.push({ id: "mining-pending", priority: 30, kind: "action", title: `${pending.length} 个日期等待挖掘`, detail: `${pending[0]}${pending.length > 1 ? ` 至 ${pending.at(-1)}` : ""}`, dates: pending });
    if (needsRebuild(overview)) todos.push({ id: "rebuild", priority: 40, kind: "action", title: "记忆更新后尚未重建上下文", detail: "请到正式工作台查看预览并确认执行" });
    if (overview.attention) todos.push({ id: "attention", priority: 50, kind: "warning", title: "记忆体需要注意", detail: String(overview.attention) });
    if (!todos.length) todos.push({ id: "ready", priority: 100, kind: "ready", title: "当前没有必须处理的待办", detail: "可以查询摘要或向我了解项目" });
    return todos.sort((a, b) => a.priority - b.priority);
  }

  function validTimestamp(value) {
    const timestamp = String(value || "");
    return Number.isFinite(Date.parse(timestamp)) ? timestamp : "";
  }

  function redactSensitiveText(value) {
    return String(value || "")
      .replace(/\b(?:authorization|bearer|token|api[_ -]?key)\b\s*[:=]?\s*[^\s,;]+/gi, "[敏感凭据已隐藏]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[敏感凭据已隐藏]")
      .replace(/https?:\/\/[^\s]+/gi, "[网络地址已隐藏]")
      .replace(/\\\\[^\s\\]+\\[^\r\n]+/g, "[本地路径已隐藏]")
      .replace(/[A-Za-z]:\\[^\r\n]+/g, "[本地路径已隐藏]")
      .replace(/\/(?:Users|home|var|tmp|etc)\/[^\s]+/g, "[本地路径已隐藏]")
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[敏感内容已隐藏]");
  }

  function friendlyErrorMessage(error) {
    const source = String(error?.message || error || "").trim();
    const safe = redactSensitiveText(source).slice(0, 240);
    if (/已有一项写入操作正在提交/.test(source)) return "已有一项写入操作正在提交，请稍后再试。";
    if (/当前已有挖掘任务|正在挖掘/.test(source)) return "当前已有挖掘任务运行，请等待它完成后再试。";
    if (/请重新选择有效的挖掘通道|请先选择有效的挖掘通道/.test(source)) return "请重新选择 Subagent 或 API 挖掘通道。";
    if (/\d{4}-\d{2}-\d{2}.*(?:已经变化|不符合一键维护条件|不能由小助理挖掘)|没有可以执行的挖掘日期/.test(source)) return safe;
    if (/原来的挖掘任务已经结束或发生变化/.test(source)) return "原来的挖掘任务已经结束或发生变化，没有发送停止请求。";
    if (/记忆体不存在|缺少.*(?:threadId|记忆体标识)/i.test(source)) return "无法找到当前记忆体，请从记忆体的插件工坊重新进入。";
    if (/(?:API|接口).*(?:Key|密钥|配置|不可用|失败)|(?:Key|密钥).*(?:缺少|无效)/i.test(source)) return "所选 API 通道暂不可用，请在正式设置页检查配置，或改用 Subagent。";
    if (/failed to fetch|network|econnrefused|socket|本地服务/i.test(source)) return "无法连接 Stone Memory 本地服务，请确认服务正在运行后重试。";
    return "操作暂时没有完成，请检查 Stone Memory 本地服务或前往正式工作台查看。";
  }

  function buildSystemLogs({ overview = {}, mining = {} } = {}) {
    const logs = [];
    const job = mining.job;
    if (job && validTimestamp(job.updatedAt || job.createdAt)) {
      const active = isMiningActive(job);
      const failed = job.status === "failed" || job.status === "completed_with_errors";
      logs.push({
        id: `system-job-${job.id || job.updatedAt || job.createdAt}`,
        source: "记忆系统",
        action: "挖掘任务",
        result: active ? "正在运行" : failed ? "存在失败项" : job.status === "cancelled" ? "已停止" : "已结束",
        detail: active && job.currentDate ? `正在处理 ${job.currentDate}` : `已处理 ${Number(job.completed) || 0}/${Array.isArray(job.dates) ? job.dates.length : 0} 个日期`,
        timestamp: job.updatedAt || job.createdAt,
        status: failed ? "failed" : active ? "running" : "completed"
      });
    }
    const recentRows = (mining.dates || []).filter(row => row.status !== "pending" && validTimestamp(row.updatedAt)).slice(0, 60);
    for (const row of recentRows) {
      const timestamp = validTimestamp(row.updatedAt);
      const completed = COMPLETE_DAY.has(row.status);
      const failed = ["failed", "partial_failed", "blocked"].includes(row.status);
      logs.push({
        id: `system-day-${row.date}-${timestamp}`,
        source: "记忆系统",
        action: "日期挖掘",
        result: completed ? `${row.date} 已完成` : failed ? `${row.date} 需要检查` : `${row.date} ${row.status}`,
        detail: completed ? `摘要 ${Number(row.feelingCount) || 0} 条 · 特征 ${Number(row.featureCount) || 0} 条` : "请前往正式挖掘工作台查看原因或决定是否重试。",
        timestamp,
        status: completed ? "completed" : failed ? "failed" : "running"
      });
    }
    const rebuildAt = validTimestamp(overview.rebuild?.completedAt);
    if (rebuildAt) {
      logs.push({
        id: `system-rebuild-${rebuildAt}`,
        source: "记忆系统",
        action: "重建上下文",
        result: "最近一次重建已完成",
        detail: "这是正式工作流报告的最近一次完成时间。",
        timestamp: rebuildAt,
        status: "completed"
      });
    }
    return logs;
  }

  function mergeLogs(systemLogs = [], assistantLogs = [], limit = 30) {
    return [...systemLogs, ...assistantLogs]
      .filter(item => item && validTimestamp(item.timestamp))
      .map(item => ({
        id: String(item.id || `${item.source}-${item.timestamp}-${item.action}`),
        source: item.source === "小助理" ? "小助理" : "记忆系统",
        action: String(item.action || "状态更新").slice(0, 80),
        result: String(item.result || "已记录").slice(0, 120),
        detail: String(item.detail || "没有更多详情。").slice(0, 300),
        timestamp: validTimestamp(item.timestamp),
        status: ["running", "failed", "completed", "waiting"].includes(item.status) ? item.status : "completed"
      }))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || b.id.localeCompare(a.id))
      .slice(0, Math.max(0, Number(limit) || 0));
  }

  return Object.freeze({
    TERMINAL_MINING,
    NICKNAMES,
    MOBILE_TAP_WINDOW_MS,
    normalizeText,
    hashString,
    nicknameForThread,
    isMobileAssistantEnvironment,
    mobileLauncherAction,
    beijingDateKey,
    shiftDate,
    parseCommand,
    isInternalQuestion,
    matchKnowledge,
    pendingMiningDates,
    createMiningPlan,
    validateMiningPlan,
    isMiningActive,
    canStopJob,
    needsRebuild,
    buildTodos,
    redactSensitiveText,
    friendlyErrorMessage,
    buildSystemLogs,
    mergeLogs
  });
});
