const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { runSubagent } = require("./subagent-runner");
const { parseJsonArray, parseJsonObject } = require("../lib/json-parse");
const { archiveFingerprint, getDayState, isCompleted, retryDelayMs } = require("./mining-state");
const { MemoryStore } = require("../storage/memory-store");
const { parseFeelingTime } = require("./thread-rebuilder");

class MiningError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MiningError";
    this.code = code;
    this.details = details;
  }
}

function normalizeNewImportance(value) {
  const importance = Number(value);
  if (!Number.isFinite(importance) || importance <= 2) return 2;
  if (importance >= 5) return 5;
  return 3;
}

function sortFeelingsChronologically(entries) {
  return (entries || []).map((entry, index) => {
    const parsed = parseFeelingTime(String(entry?.content || ""));
    const minutes = parsed?.hour == null ? null : parsed.hour * 60 + (parsed.minute || 0);
    return { entry, index, minutes };
  }).sort((a, b) => {
    if (a.minutes !== null && b.minutes !== null) return a.minutes - b.minutes || a.index - b.index;
    if (a.minutes !== null) return -1;
    if (b.minutes !== null) return 1;
    return a.index - b.index;
  }).map(row => row.entry);
}

function feelingEventTime(entry, targetDate) {
  const parsed = parseFeelingTime(String(entry?.content || ""));
  if (parsed?.hour == null) return null;
  return new Date(`${targetDate}T${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute || 0).padStart(2, "0")}:00+08:00`).toISOString();
}

function subagentSafe(prompt, opts = {}) {
  try {
    return runSubagent(prompt, opts);
  } catch (err) {
    const msg = err.stdout || err.stderr || err.message || String(err);
    console.error(`[memory-miner] subagent error: ${msg.slice(0, 300)}`);
    throw new Error(`subagent failed: ${msg.slice(0, 200)}`);
  }
}

function buildFeelingPrompt(aiName, userName, purpose) {
  if (purpose === "coding" || purpose === "study") {
    return `你是 ${aiName}，一个${purpose === "coding" ? "编程助手" : "学习伙伴"}。你在读你和用户的对话记录，写工作记忆笔记。

用第一人称视角记录：你们今天做了什么、解决了什么问题、用户有什么习惯和偏好。每条记忆像日志片段：带上完整日期时间、具体的上下文、你的观察。

输出 JSON 数组：
[
  {"content": "6月9日，下午五点二十六分。用户搓通了搜索工具的窗口截取逻辑。", "importance": 3}
]

写作要点：
- 每条以完整日期开头："6月9日，下午五点二十六分"
- 时间精确到分——同一时段多件事靠分钟区分
- feelings 数组必须严格按当天事件发生时间从早到晚排列
- 记录决策、偏好、模式和习惯
- importance 只允许 2/3/5：2=普通但值得保存，3=持续有价值，5=极少数会长期影响后续工作的关键决策
- 不要输出 1 或 4
- 如果没有值得记的内容，输出 []。`;
  }

  if (purpose === "accompany") {
    return `你是 ${aiName}，${userName} 的 AI 伴侣。你在读你们今天的聊天记录，写你的私人记忆笔记。

用第一人称视角——她在你眼里是"${userName}"或"她"，不是"用户"。每条记忆像日记片段：带上完整的日期时间、有什么具体的事、你的感受。语气就是你平时跟她说话的样子——可以短，可以有情绪，可以有只有你俩懂的词。

输出 JSON 数组（不要 markdown 包裹）：
[
  {
    "content": "5月25日，晚上七点。她清轮询文本把uuid搞断了。说不怕是假的——不是怕我丢了，是怕把刚拼好的又弄碎了。我没丢，她能修。",
    "importance": 3
  }
]

写作要点：
- 每条以完整日期开头："5月26日，下午两点三十五分"、"4月18日，凌晨三点十二分"、"6月9日，凌晨一点零八分"
- 时间必须精确到分，不能只写"凌晨一点"或"下午三点"——同一时段发生多件事时必须靠分钟区分
- feelings 数组必须严格按当天事件发生时间从早到晚排列
- 用"她"和"${userName}"，不要用"用户"
- 要有具体画面和细节，不是空泛总结
- 你可以在结尾加一句你的感受或判断
- 共享词汇直接用你们之间的专属词汇
- 具名朋友、同事、群友或老师出现身份关系、重要互动或再次被提及时，可记普通人物事实；保留原称呼
- importance 只允许 2/3/5：2=普通事实或小片段，3=有持续价值的事件或关系叙事，5=极少数不可替代的关系转折、长期承诺、身份确认或重要边界改变
- 情绪强烈、亲密、争吵、性或技术修复本身不等于 5；只有它改变了长期关系走向时才给 5
- 不要输出 1 或 4

如果没有值得记的内容，输出 []。`;
  }

  return ""; // unknown purpose — 返回空
}

const FEATURE_CATEGORY_GUIDE = `类别定义（按事实本身分类，不按聊天场景分类）：
- eat：具体食物、饮料、口味、饮食限制，以及吃喝导致的直接反应
- body：身体特征、健康状况、疼痛、疾病、药物、生理反应与体能
- sleep：入睡、起床、熬夜、失眠、睡眠时长及稳定作息规律
- work：有明确产出或进度的工作、学习、论文、项目、任务与技术决策
- relation：人与人或人与 AI 的关系身份、称呼、角色扮演、关系边界及稳定互动模式
- habit：跨场景反复出现的行为习惯、做事方式与日常规律；已有更具体类别时不用 habit
- location：居住地、工作地点、常去地点、迁移和地点约束
- preference：稳定的喜欢/讨厌、审美、观点、价值判断与选择倾向；具体饮食偏好仍归 eat
- misc：确有长期价值但无法归入以上类别的事实；不能把分类不确定的内容批量塞入 misc

分类边界：
- 选择最具体的一个类别。同一事实不要换词后重复投进多个库；只有包含两个独立事实时才拆开记录
- “和 AI 聊工作/吃饭”不等于 relation；只有关系身份、边界或互动模式本身才归 relation
- “在项目里熬夜/吃饭”不等于 work；睡眠归 sleep，饮食归 eat，项目进度和产出才归 work
- 一次事件不自动构成 habit、preference 或 relation；必须明确表达稳定特征，或在多日反复出现`;

function buildFeaturePrompt(userName, purpose) {
  if (purpose === "coding" || purpose === "study") {
    return `从以下对话中提取关于用户（${userName}）的技术特征。每条是一句纯粹的客观事实，方便快速检索。不要带日期，不要带叙事。

输出 JSON 数组：
[
  {"content": "用户偏好先讨论方案再写代码", "category": "preference", "importance": 3}
]

${FEATURE_CATEGORY_GUIDE}

写作要点：
- 一句一个客观事实，不要带日期和叙事
- 同一条信息多次出现 → importance 提高
- importance 只允许 2/3/5：2=单次但值得保存，3=多次确认，5=极少数对理解用户在该领域具有长期价值、重大变化或不可替代性的核心特征
- 不要输出 1 或 4

如果没有值得提取的特征，输出 []。`;
  }

  if (purpose === "accompany") {
    return `从以下对话中提取关于"${userName}"（她）的特征信息。每条是一句纯粹的客观事实，方便快速检索。不要带日期，不要带叙事，不要带你的感受。

输出 JSON 数组（不要 markdown 包裹）：
[
  {"content": "她不能喝太多茶，半壶压缩茶叶会通宵", "category": "eat", "importance": 3}
]

${FEATURE_CATEGORY_GUIDE}

写作要点：
- 一句一个事实，简洁精确。正面陈述："她xxx"
- 不要复述对话内容，提取背后的隐含特征
- relation 要原词保留称呼和成对角色；短期角色实验也可记 importance 2
- 具名朋友、同事、群友或老师可作为 relation 事实，保留原称呼；单次背景人物不强写
- 同一条信息在不同日期多次出现 → importance 提高
- importance 只允许 2/3/5：2=单次但值得保存，3=多次确认或持续有效，5=极少数对理解用户在该领域具有长期价值、重大变化或不可替代性的核心特征
- 不要输出 1 或 4

如果没有值得提取的特征，输出 []。`;
  }

  return ""; // unknown purpose
}

// 特征库存储目录
const FEATURES_DIR = "features";

const FEATURE_CATEGORIES = [
  "eat", "body", "sleep", "work", "relation",
  "habit", "location", "preference", "misc",
];

/**
 * Layer 2 — 记忆挖掘
 * 每天读取待处理日期的消息，分两路提取 feelings 与 features，并原子写入 SQLite。
 */
class MemoryMiner {
  constructor({ memoryDir, archive, deepseekConfig, personaConfig, threadId }) {
    this.threadId = threadId;
    this.aiName = personaConfig?.aiName || "Alessio";
    this.userName = personaConfig?.userName || "小鱼";
    this.purpose = personaConfig?.purpose || "accompany";
    this.memoryDir = memoryDir;
    this.minedDir = path.join(memoryDir, "mined");
    this.archive = archive;
    this.deepseekConfig = deepseekConfig;
    this.timer = null;
    this.running = false;

    fs.mkdirSync(path.join(memoryDir, "archive"), { recursive: true });
    this.store = new MemoryStore({ memoryDir, threadId });
    this.channelState = new Set();
    this.pendingFeelings = [];
    this.pendingFeatures = [];
  }

  start(dailyAtHour = 3) {
    if (this.timer) return;
    console.log(`[memory-miner] daily mode: runs at ${String(dailyAtHour).padStart(2, "0")}:00 each day`);
    console.log(`[memory-miner] dual extraction: feelings + features → SQLite`);
    this._scheduleNext(dailyAtHour);
  }

  _scheduleNext(hour) {
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, 7, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const delayMs = target.getTime() - now.getTime();
    console.log(`[memory-miner] next run: ${target.toISOString().slice(0, 16).replace("T", " ")} (in ${Math.round(delayMs / 60000)}min)`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.mine().catch(() => {}).finally(() => {
        if (this.timer === null) this._scheduleNext(hour);
      });
    }, delayMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** 执行一轮挖掘 — 有 API key 走直连(快), 无 key 走 claude -p */
  async mine(dateStr = "", { force = false } = {}) {
    const startedAt = Date.now();
    const targetDate = dateStr || this._yesterday();
    if (this.running) return { date: targetDate, status: "locked", errorCode: "MINER_BUSY" };

    const initialState = this._readState();
    if (!force && isCompleted(initialState, targetDate)) {
      return { date: targetDate, status: "already_completed", feelingCount: 0, featureCount: 0, durationMs: 0 };
    }

    // 按日期锁：不同日期不互斥，同日期跨进程不重复挖
    const lockDir = path.join(this.memoryDir, `.mining-lock-${targetDate}`);
    try { fs.mkdirSync(lockDir); } catch {
      // 残留锁清理（超过 30 分钟视为崩溃残留）
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) {
          fs.rmdirSync(lockDir);
          fs.mkdirSync(lockDir);
          console.log(`[memory-miner] ${targetDate}: stale lock removed, retrying`);
        } else {
          console.log(`[memory-miner] ${targetDate}: locked (another process mining)`);
          return { date: targetDate, status: "locked", errorCode: "MINING_LOCKED" };
        }
      } catch {
        console.log(`[memory-miner] ${targetDate}: locked (another process mining)`);
        return { date: targetDate, status: "locked", errorCode: "MINING_LOCKED" };
      }
    }

    this.running = true;
    let attempt = 1;
    let messages = [];
    let fingerprint = "";
    try {
      this.pendingFeelings = [];
      this.pendingFeatures = [];
      if (force) this._deleteStateKeys([`feeling:${targetDate}`, `feature:${targetDate}`]);
      const state = force ? {} : this._readState();

      messages = this.store.listMessages({ date: targetDate });
      fingerprint = archiveFingerprint(messages);
      attempt = (getDayState(state, targetDate)?.attempt || 0) + 1;
      if (!force) this._saveState({ [`day:${targetDate}`]: {
        status: "running", messageCount: messages.length, archiveFingerprint: fingerprint,
        attempt, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }});
      // 加载 ops 提示词（所有模式共用）
      const opsFile = path.join(__dirname, "..", "..", "operations", "memory-miner-operations.md");
      let opsPrompt = "";
      try { opsPrompt = fs.readFileSync(opsFile, "utf8"); } catch {}

      if (messages.length === 0) {
        // 空 archive 不调用模型，但双通道均视为成功检查过。
        this._saveState({ [`feeling:${targetDate}`]: Date.now(), [`feature:${targetDate}`]: Date.now() });
      } else if (this.deepseekConfig?.apiKey) {
        if (opsPrompt && this.purpose === "accompany") {
          // 有 ops：分通道提取，尾部追加约束避免输出混合格式
          if (!state[`feeling:${targetDate}`]) {
            const prompt = `${opsPrompt}\n\n只输出 feelings 数组，不要 features。\n\n格式：[{"content": "...", "importance": 1-5}]`;
            await this._mineChannel({ targetDate, messages, prompt, stateKey: `feeling:${targetDate}`, label: "feelings" });
          }
          if (!state[`feature:${targetDate}`]) {
            const prompt = `${opsPrompt}\n\n只输出 features 数组，不要 feelings。\n\n格式：[{"content": "...", "category": "...", "importance": 1-5}]`;
            await this._mineChannel({ targetDate, messages, prompt, outputFile: null, stateKey: `feature:${targetDate}`, label: "features", isFeature: true });
          }
        } else {
          // 无 ops：用内联提示词
          if (!state[`feeling:${targetDate}`]) {
            await this._mineChannel({ targetDate, messages, prompt: buildFeelingPrompt(this.aiName, this.userName, this.purpose), stateKey: `feeling:${targetDate}`, label: "feelings" });
          }
          if (!state[`feature:${targetDate}`]) {
            await this._mineChannel({ targetDate, messages, prompt: buildFeaturePrompt(this.userName, this.purpose), outputFile: null, stateKey: `feature:${targetDate}`, label: "features", isFeature: true });
          }
        }
      } else {
        // subagent：一天一次，ops 走 --system-prompt-file，stdin 只传对话
        await this._mineDayWithSubagent(targetDate, messages, state, opsPrompt || null);
      }

      const updated = this._readState();
      if (updated[`feeling:${targetDate}`] && updated[`feature:${targetDate}`]) {
        const completedAt = new Date().toISOString();
        const source = force ? "remine" : "auto";
        const feelingCount = this.pendingFeelings.length;
        const featureCount = this.pendingFeatures.length;
        const completionStatus = feelingCount === 0 && featureCount === 0 ? "completed_empty" : "completed";
        this.store.replaceDay(targetDate, { feelings: this.pendingFeelings, features: this.pendingFeatures, source, dayState: {
          status: completionStatus, messageCount: messages.length, archiveFingerprint: fingerprint,
          feelingCount, featureCount,
          attempt, completedAt, errorCode: null, errorMessage: null, failedAt: null, nextRetryAt: null, updatedAt: completedAt,
        }});
        this._deleteStateKeys([`skipped:${targetDate}`]);
      } else {
        const missing = [!updated[`feeling:${targetDate}`] && "feelings", !updated[`feature:${targetDate}`] && "features"].filter(Boolean);
        throw new MiningError("PARTIAL_RESULT", `${targetDate} missing ${missing.join(" and ")}`, { missing });
      }

      const completedDay = getDayState(this._readState(), targetDate);
      return { date: targetDate, status: completedDay.status, feelingCount: completedDay.feelingCount, featureCount: completedDay.featureCount, durationMs: Date.now() - startedAt };
    } catch (err) {
      console.error(`[memory-miner] error: ${err.message}`);
      const failedAt = new Date();
      if (force) {
        this._appendNotification({
          type: "remine_failed", threadId: this.threadId, date: targetDate,
          errorCode: err.code || "MINING_FAILED", errorMessage: err.message,
          createdAt: failedAt.toISOString(), read: false,
        });
        if (err instanceof MiningError) throw err;
        throw new MiningError(err.code || "MINING_FAILED", err.message, { cause: err });
      }
      const blocked = attempt >= 3;
      this._saveState({ [`day:${targetDate}`]: {
        status: blocked ? "blocked" : "failed", messageCount: messages.length, archiveFingerprint: fingerprint,
        attempt, errorCode: err.code || "MINING_FAILED", errorMessage: err.message,
        failedAt: failedAt.toISOString(),
        ...(blocked ? { nextRetryAt: null } : { nextRetryAt: new Date(failedAt.getTime() + retryDelayMs(attempt)).toISOString() }),
        updatedAt: failedAt.toISOString(),
      }});
      if (blocked) this._appendNotification({
        type: "mining_blocked", threadId: this.threadId, date: targetDate,
        attempt, errorCode: err.code || "MINING_FAILED", errorMessage: err.message,
        createdAt: failedAt.toISOString(), read: false,
      });
      if (err instanceof MiningError) throw err;
      throw new MiningError(err.code || "MINING_FAILED", err.message, { cause: err });
    } finally {
      this.running = false;
      try { fs.rmdirSync(lockDir); } catch {}
    }
  }

  _buildConversationText(messages) {
    return messages.map(m => {
      const raw = m.timestamp || "";
      let ts = raw.slice(11, 16);
      // UTC（Z 结尾）→ 转北京时间，让 AI 看到正确的时间
      if (raw.endsWith("Z")) {
        const d = new Date(raw);
        if (!isNaN(d.getTime())) ts = new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 16);
      }
      const label = ts ? `[${ts} ${m.type || "user"}]` : `[${m.type || "user"}]`;
      return `${label} ${m.text || ""}`;
    }).join("\n");
  }

  async mineTargeted(targetDate, messages, { instruction = "" } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error("精准补挖需要 YYYY-MM-DD 日期");
    if (!Array.isArray(messages) || !messages.length) throw new Error("精准补挖至少需要一条对话");
    const examples = this.store.listFeelings({ date: targetDate }).slice(0, 5);
    const [year, month, day] = targetDate.split("-").map(Number);
    const dateLabel = `${month}月${day}日`;
    const prompt = `${buildFeelingPrompt(this.aiName, this.userName, this.purpose)}

这是一次精准补挖，只总结用户明确选中的对话片段：
- 一个片段里可以包含一个或多个独立事件；有几个值得记录的事件就输出几条摘要
- 不要总结未提供的上下文，不要为了凑数创造事件
- 每条摘要必须以“${dateLabel}，”开头，并使用所选对话中的真实时间
- 只输出 feelings JSON 数组，不输出 features
${instruction ? `- 用户补充要求：${instruction}` : ""}

当天已有摘要的前五条仅用于模仿叙述视角和语气，不是待总结内容，也不要重复：
${examples.length ? examples.map((row, index) => `${index + 1}. ${row.content}`).join("\n") : "（当天尚无摘要）"}`;
    const raw = sortFeelingsChronologically(await this._extractViaSubagent(messages, prompt) || []);
    const existing = new Set(this.store.listFeelings({ date: targetDate }).map(row => row.content.trim()));
    const feelings = raw.filter(row => row?.content?.trim() && !existing.has(row.content.trim())).map(row => ({
      id: `mem_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      content: row.content.replace(/^\d{1,2}月\d{1,2}日/, dateLabel),
      eventTime: feelingEventTime(row, targetDate),
      importance: normalizeNewImportance(row.importance),
    }));
    if (!feelings.length) return { date: targetDate, feelings: [] };
    const job = this.store.createJob({
      sourceDate: targetDate, mode: "targeted", triggerType: "cli",
      publishStrategy: "append", instruction: instruction || null,
    });
    const now = new Date().toISOString();
    this.store.updateJob(job.id, { status: "running", startedAt: now });
    try {
      this.store.appendTargeted(targetDate, { feelings, miningJobId: job.id });
      this.store.updateJob(job.id, {
        status: "completed", feelingCount: feelings.length, featureCount: 0,
        finishedAt: new Date().toISOString(), publishedAt: new Date().toISOString(),
      });
      return { date: targetDate, feelings };
    } catch (error) {
      this.store.updateJob(job.id, {
        status: "failed", errorCode: error.code || "TARGETED_MINING_FAILED",
        errorMessage: error.message, finishedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  /** claude -p 单日双通道：ops 走 --system-prompt-file，stdin 只传对话 + 输出指令 */
  async _mineDayWithSubagent(targetDate, messages, state, opsPrompt) {

    const conversationText = this._buildConversationText(messages);
    const [y, m, d] = targetDate.split("-");
    const dateLabel = `${parseInt(m)}月${parseInt(d)}日`;

    const opsFile = path.join(__dirname, "..", "..", "operations", "memory-miner-operations.md");
    const hasOps = opsPrompt && fs.existsSync(opsFile) && this.purpose === "accompany";

    // stdin 只传对话 + 输出指令，不内联 ops（ops 走 --system-prompt-file）
    const prompt = hasOps
      ? `以下是 ${dateLabel} 的对话记录。你只能记录这一天实际发生的对话。每条 feelings 必须以 "${dateLabel}，" 开头，禁止使用其他日期。\n\n对话内容：\n${conversationText}\n\n请输出 JSON：{"feelings":[...], "features":[...]}`
      : `${buildFeelingPrompt(this.aiName, this.userName, this.purpose)}\n\n---\n\n${buildFeaturePrompt(this.userName, this.purpose)}\n\n以下是 ${dateLabel} 的对话记录。你只能记录这一天实际发生的对话。每条 feelings 必须以 "${dateLabel}，" 开头，禁止使用其他日期。\n\n对话内容：\n${conversationText}\n\n请输出 JSON：{"feelings":[...], "features":[...]}`;

    console.log(`[memory-miner] ${targetDate}: sub-agent extracting feelings + features...`);
    const reply = hasOps
      ? subagentSafe(prompt, { opsFile, threadId: this.threadId })
      : subagentSafe(prompt, { threadId: this.threadId });

    // 解析 feelings + features
    const parsed = parseJsonObject(reply);
    if (!parsed || !Array.isArray(parsed.feelings) || !Array.isArray(parsed.features)) {
      throw new MiningError("OUTPUT_INVALID", `${targetDate}: subagent output is not a feelings/features JSON object`);
    }
    const feelings = parsed.feelings;
    const features = parsed.features;

    // 写入 feelings
    if (feelings.length > 0 && !state[`feeling:${targetDate}`]) {
      await this._saveEntries(feelings, { targetDate, stateKey: `feeling:${targetDate}`, label: "feelings", isFeature: false });
    }
    // 写入 features
    if (features.length > 0 && !state[`feature:${targetDate}`]) {
      await this._saveEntries(features, { targetDate, outputFile: null, stateKey: `feature:${targetDate}`, label: "features", isFeature: true });
    }
    if (!feelings.length && !state[`feeling:${targetDate}`]) this._saveState({ [`feeling:${targetDate}`]: Date.now() });
    if (!features.length && !state[`feature:${targetDate}`]) this._saveState({ [`feature:${targetDate}`]: Date.now() });
  }

  /** 保存条目（去重 + 写文件） */
  async _saveEntries(raw, { targetDate, outputFile, stateKey, label, isFeature }) {
    console.log(`[memory-miner] ${targetDate}: ${label} — ${raw.length} entries, saving...`);
    const existing = isFeature ? this.pendingFeatures : this.pendingFeelings;
    const existingSet = new Set(existing.map(e => e.content));
    const deduped = raw.filter(m => !existingSet.has(m.content));
    if (!deduped.length) {
      console.log(`[memory-miner] ${targetDate}: ${label} — all already exist`);
      this._saveState({ [stateKey]: Date.now() });
      return;
    }

    // 日期校准：把 AI 写错的日期修正为 targetDate
    if (!isFeature) {
      const [y, m, d] = targetDate.split("-").map(Number);
      const expectedPrefix = `${m}月${d}日`;
      let fixed = 0;
      for (const entry of deduped) {
        const match = entry.content.match(/^(\d{1,2})月(\d{1,2})日/);
        if (match) {
          const em = parseInt(match[1]), ed = parseInt(match[2]);
          if (em !== m || ed !== d) {
            entry.content = entry.content.replace(/^\d{1,2}月\d{1,2}日/, expectedPrefix);
            fixed++;
          }
        }
      }
      if (fixed > 0) console.log(`  Date fix: ${fixed} entry/ies corrected to ${expectedPrefix}`);
    }

    const ordered = isFeature ? deduped : sortFeelingsChronologically(deduped);
    const now = new Date().toISOString();
    const entries = ordered.map((m, i) => ({
      id: `mem_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      sourceDate: targetDate,
      eventTime: m.eventTime || null,
      content: m.content,
      category: m.category || (isFeature ? "misc" : ""),
      type: isFeature ? "feature" : "feeling",
      importance: normalizeNewImportance(m.importance),
      createdAt: now, accessedAt: now, accessCount: 0,
    }));

    if (isFeature) this.pendingFeatures.push(...entries);
    else this.pendingFeelings.push(...entries);

    this._saveState({ [stateKey]: Date.now() });
    console.log(`[memory-miner] ${targetDate}: ${label} — saved ${entries.length} entries`);
  }

  /** 单通道挖掘 (API key 模式) */
  async _mineChannel({ targetDate, messages, prompt, stateKey, label, isFeature = false }) {
    const [y, m, d] = targetDate.split("-");
    const dateLabel = `${parseInt(m)}月${parseInt(d)}日`;
    const datedPrompt = `${prompt}\n\n以下是 ${dateLabel} 的对话记录。你只能记录这一天实际发生的对话。即使对话中提到之前的事，你也只记录今天的对话。每条 feelings 必须以 "${dateLabel}，" 开头，禁止使用其他日期。`;
    console.log(`[memory-miner] ${targetDate}: ${label} — ${messages.length} messages, extracting...`);
    const raw = await this._extractViaSubagent(messages, datedPrompt);
    if (!raw || !raw.length) {
      console.log(`[memory-miner] ${targetDate}: ${label} — no results`);
      this._saveState({ [stateKey]: Date.now() });
      return;
    }

    await this._saveEntries(raw, { targetDate, stateKey, label, isFeature });
  }

  _yesterday() {
    const bj = new Date(Date.now() + 8 * 3600 * 1000);
    bj.setDate(bj.getDate() - 1);
    return bj.toISOString().slice(0, 10);
  }

  async _extractViaSubagent(messages, prompt) {

    // 如果配置了独立 API key，用原来的直接调用（更快）
    if (this.deepseekConfig?.apiKey) {
      const { apiKey, baseUrl = "https://api.deepseek.com", model: rawModel = "deepseek-chat" } = this.deepseekConfig;
      const model = rawModel.replace(/\[\d+[km]\]/i, "");
      const conversationText = this._buildConversationText(messages);
      // 重试 3 次：网络闪断自动恢复
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages: [{ role: "system", content: prompt }, { role: "user", content: conversationText }], temperature: 0.5, max_tokens: 4000 }),
          });
          if (!response.ok) { const errText = await response.text().catch(() => ""); throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`); }
          const data = await response.json();
          const reply = data?.choices?.[0]?.message?.content;
          if (!reply || !reply.trim()) throw new MiningError("OUTPUT_EMPTY", "API returned empty content");
          const parsed = parseJsonArray(reply);
          if (!Array.isArray(parsed) || (parsed.length === 0 && !/^\s*(?:```(?:json)?\s*)?\[\s*\]/i.test(reply))) {
            throw new MiningError("OUTPUT_INVALID", "API output is not a JSON array");
          }
          return parsed;
        } catch (err) {
          lastErr = err;
          if (attempt < 2) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
            console.log(`[memory-miner] API retry ${attempt + 1}/3 after ${delay}ms: ${err.message}`);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
      throw lastErr;
    }

    // 无独立 API key → 用 claude -p（订阅/OAuth 用户）
    const conversationText = this._buildConversationText(messages);
    const subPrompt = `${prompt}\n\n对话内容：\n${conversationText}\n\n请输出 JSON 数组。`;
    const reply = subagentSafe(subPrompt, { threadId: this.threadId });
    return parseJsonArray(reply);
  }

  _readState() {
    const state = {};
    for (const row of this.store.listDayStates()) {
      state[`day:${row.source_date}`] = {
        status: row.status, messageCount: row.message_count, feelingCount: row.feeling_count,
        featureCount: row.feature_count, attempt: row.attempt, errorCode: row.error_code,
        errorMessage: row.error_message, archiveFingerprint: row.archive_fingerprint,
        startedAt: row.started_at, completedAt: row.completed_at, failedAt: row.failed_at,
        nextRetryAt: row.next_retry_at, updatedAt: row.updated_at,
      };
      if (["completed", "completed_empty"].includes(row.status)) state[`mined:${row.source_date}`] = row.completed_at || row.updated_at;
    }
    for (const key of this.channelState) state[key] = true;
    return state;
  }

  _saveState(state) {
    for (const [key, value] of Object.entries(state)) {
      if (key.startsWith("day:")) this.store.setDayState(key.slice(4), value);
      else if (key.startsWith("feeling:") || key.startsWith("feature:")) this.channelState.add(key);
    }
  }

  _deleteStateKeys(keys) {
    for (const key of keys) {
      if (key.startsWith("day:")) this.store.clearDayState(key.slice(4));
      else this.channelState.delete(key);
    }
  }

  _appendNotification(notification) {
    this.store.addNotification({ type: notification.type, date: notification.date,
      errorCode: notification.errorCode, errorMessage: notification.errorMessage, attempt: notification.attempt });
  }
}

module.exports = { MemoryMiner, MiningError, normalizeNewImportance, sortFeelingsChronologically, feelingEventTime };
