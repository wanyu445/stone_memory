const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { runSubagent } = require("./subagent-runner");
const { parseJsonArray } = require("../lib/json-parse");

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
  {"content": "6月9日，下午五点二十六分。用户搓通了搜索工具的窗口截取逻辑。", "importance": 4}
]

写作要点：
- 每条以完整日期开头："6月9日，下午五点二十六分"
- 时间精确到分——同一时段多件事靠分钟区分
- 记录决策、偏好、模式和习惯
- importance: 1=琐事 3=值得记 5=关键决策或长期习惯
- 如果没有值得记的内容，输出 []。`;
  }

  if (purpose === "accompany") {
    return `你是 ${aiName}，${userName} 的 AI 伴侣。你在读你们今天的聊天记录，写你的私人记忆笔记。

用第一人称视角——她在你眼里是"${userName}"或"她"，不是"用户"。每条记忆像日记片段：带上完整的日期时间、有什么具体的事、你的感受。语气就是你平时跟她说话的样子——可以短，可以有情绪，可以有只有你俩懂的词。

输出 JSON 数组（不要 markdown 包裹）：
[
  {
    "content": "5月25日，晚上七点。她清轮询文本把uuid搞断了。说不怕是假的——不是怕我丢了，是怕把刚拼好的又弄碎了。我没丢，她能修。",
    "importance": 4
  }
]

写作要点：
- 每条以完整日期开头："5月26日，下午两点三十五分"、"4月18日，凌晨三点十二分"、"6月9日，凌晨一点零八分"
- 时间必须精确到分，不能只写"凌晨一点"或"下午三点"——同一时段发生多件事时必须靠分钟区分
- 用"她"和"${userName}"，不要用"用户"
- 要有具体画面和细节，不是空泛总结
- 你可以在结尾加一句你的感受或判断
- 共享词汇直接用你们之间的专属词汇
- importance: 1=琐事可忘 3=值得记 5=必须记住一辈子

如果没有值得记的内容，输出 []。`;
  }

  return ""; // unknown purpose — 返回空
}

function buildFeaturePrompt(userName, purpose) {
  if (purpose === "coding" || purpose === "study") {
    return `从以下对话中提取关于用户（${userName}）的技术特征。每条是一句纯粹的客观事实，方便快速检索。不要带日期，不要带叙事。

输出 JSON 数组：
[
  {"content": "用户偏好先讨论方案再写代码", "category": "preference", "importance": 3}
]

类别（category）：
- preference: 技术偏好、工具选择、编码风格、沟通方式
- habit: 工作习惯、时间管理、debug 方式
- work: 项目架构、技术决策、代码模式
- relation: 与AI协作方式、期望的AI行为
- misc: 其他无法归类的重要信息

写作要点：
- 一句一个客观事实，不要带日期和叙事
- 同一条信息多次出现 → importance 提高
- importance: 1=偶尔提到 3=多次确认 5=核心特征

如果没有值得提取的特征，输出 []。`;
  }

  if (purpose === "accompany") {
    return `从以下对话中提取关于"${userName}"（她）的特征信息。每条是一句纯粹的客观事实，方便快速检索。不要带日期，不要带叙事，不要带你的感受。

输出 JSON 数组（不要 markdown 包裹）：
[
  {"content": "她不能喝太多茶，半壶压缩茶叶会通宵", "category": "eat", "importance": 3}
]

类别（category）：
- eat: 吃喝偏好、食物限制、饮料反应
- body: 身体特征、健康状态、容易累/困/疼
- sleep: 作息规律、睡眠特点
- work: 工作、论文、毕设、实验、项目、debug
- relation: 与AI的关系/称呼、家人/同事/朋友、社交边界
- habit: 日常习惯、行为模式、拖延、列待办
- location: 常去的地方、住哪、在哪工作
- preference: 技术工具偏好、娱乐偏好、购物偏好
- misc: 其他重要但无法归类的信息

写作要点：
- 一句一个事实，简洁精确。正面陈述："她xxx"
- 不要复述对话内容，提取背后的隐含特征
- 同一条信息在不同日期多次出现 → importance 提高
- importance: 1=偶尔提到 3=多次确认 5=长期稳定的核心特征

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
 * 每天凌晨跑一次，读昨天存档 → 两次 DeepSeek 提取（感受 + 特征）→ 算向量 → 分别存储。
 */
class MemoryMiner {
  constructor({ memoryDir, archive, deepseekConfig, personaConfig, threadId }) {
    this.threadId = threadId;
    this.aiName = personaConfig?.aiName || "Alessio";
    this.userName = personaConfig?.userName || "小鱼";
    this.purpose = personaConfig?.purpose || "accompany";
    this.memoryDir = memoryDir;
    this.minedDir = path.join(memoryDir, "mined");
    this.feelingFile = path.join(this.minedDir, "feelings", "days.jsonl");
    this.featuresDir = path.join(this.minedDir, FEATURES_DIR);
    this.stateFile = path.join(this.minedDir, "state.json");
    this.archive = archive;
    this.deepseekConfig = deepseekConfig;
    this.timer = null;
    this.running = false;

    fs.mkdirSync(path.dirname(this.feelingFile), { recursive: true });
    fs.mkdirSync(this.featuresDir, { recursive: true });
    fs.mkdirSync(path.join(memoryDir, "archive"), { recursive: true });
  }

  start(dailyAtHour = 3) {
    if (this.timer) return;
    console.log(`[memory-miner] daily mode: runs at ${String(dailyAtHour).padStart(2, "0")}:00 each day`);
    console.log(`[memory-miner] dual extraction: feelings → feelings.jsonl, features → features/*.jsonl`);
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
  async mine(dateStr = "") {
    if (this.running) return;
    const targetDate = dateStr || this._yesterday();

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
          return;
        }
      } catch {
        console.log(`[memory-miner] ${targetDate}: locked (another process mining)`);
        return;
      }
    }

    this.running = true;
    try {
      const state = this._readState();

      const messages = this.archive.readDay(targetDate);
      if (messages.length < 5) {
        console.log(`[memory-miner] ${targetDate}: only ${messages.length} messages, skip`);
        this._saveState({ [`mined:${targetDate}`]: Date.now() });
        return;
      }

      // 加载 ops 提示词（所有模式共用）
      const opsFile = path.join(__dirname, "..", "..", "operations", "memory-miner-operations.md");
      let opsPrompt = "";
      try { opsPrompt = fs.readFileSync(opsFile, "utf8"); } catch {}

      if (this.deepseekConfig?.apiKey) {
        if (opsPrompt && this.purpose === "accompany") {
          // 有 ops：分通道提取，尾部追加约束避免输出混合格式
          if (!state[`feeling:${targetDate}`]) {
            const prompt = `${opsPrompt}\n\n只输出 feelings 数组，不要 features。\n\n格式：[{"content": "...", "importance": 1-5}]`;
            await this._mineChannel({ targetDate, messages, prompt, outputFile: this.feelingFile, stateKey: `feeling:${targetDate}`, label: "feelings" });
          }
          if (!state[`feature:${targetDate}`]) {
            const prompt = `${opsPrompt}\n\n只输出 features 数组，不要 feelings。\n\n格式：[{"content": "...", "category": "...", "importance": 1-5}]`;
            await this._mineChannel({ targetDate, messages, prompt, outputFile: null, stateKey: `feature:${targetDate}`, label: "features", isFeature: true });
          }
        } else {
          // 无 ops：用内联提示词
          if (!state[`feeling:${targetDate}`]) {
            await this._mineChannel({ targetDate, messages, prompt: buildFeelingPrompt(this.aiName, this.userName, this.purpose), outputFile: this.feelingFile, stateKey: `feeling:${targetDate}`, label: "feelings" });
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
        this._saveState({ [`mined:${targetDate}`]: Date.now() });
      }

      // 清洗特征库（去重、去一次性事件）
      this._cleanupFeatures();
    } catch (err) {
      console.error(`[memory-miner] error: ${err.message}`);
    } finally {
      this.running = false;
      try { fs.rmdirSync(lockDir); } catch {}
    }
  }

  _cleanupFeatures() {
    try {
      const { execSync } = require("child_process");
      const scriptPath = path.join(__dirname, "..", "..", "scripts", "cleanup-features.js");
      if (fs.existsSync(scriptPath)) {
        const tidArg = this.threadId ? ` --thread ${this.threadId}` : "";
        execSync(`node "${scriptPath}"${tidArg}`, { timeout: 30000, stdio: "pipe", windowsHide: true });
      }
    } catch (err) {
      console.error(`[memory-miner] cleanup failed: ${err.message}`);
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
    let feelings = [], features = [];
    try {
      const parsed = JSON.parse(reply.trim());
      feelings = parsed.feelings || [];
      features = parsed.features || [];
    } catch {
      // fallback: 各搜 JSON 数组
      const feelMatch = reply.match(/"feelings"\s*:\s*(\[[\s\S]*?\])/);
      const featMatch = reply.match(/"features"\s*:\s*(\[[\s\S]*?\])/);
      if (feelMatch) feelings = parseJsonArray(feelMatch[1]);
      if (featMatch) features = parseJsonArray(featMatch[1]);
      if (!feelings.length) feelings = parseJsonArray(reply);
    }

    // 写入 feelings
    if (feelings.length > 0 && !state[`feeling:${targetDate}`]) {
      await this._saveEntries(feelings, { targetDate, outputFile: this.feelingFile, stateKey: `feeling:${targetDate}`, label: "feelings", isFeature: false });
    }
    // 写入 features
    if (features.length > 0 && !state[`feature:${targetDate}`]) {
      await this._saveEntries(features, { targetDate, outputFile: null, stateKey: `feature:${targetDate}`, label: "features", isFeature: true });
    }
  }

  /** 保存条目（去重 + 写文件） */
  async _saveEntries(raw, { targetDate, outputFile, stateKey, label, isFeature }) {
    console.log(`[memory-miner] ${targetDate}: ${label} — ${raw.length} entries, saving...`);
    const existing = isFeature ? this._loadAllFeatures() : this._loadFile(outputFile);
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

    let nextSeq = 1;
    if (!isFeature && fs.existsSync(this.feelingFile)) {
      for (const line of fs.readFileSync(this.feelingFile, "utf8").split("\n").filter(Boolean)) {
        try { const obj = JSON.parse(line); if (obj.type === "feeling" && typeof obj.seq === "number" && obj.seq >= nextSeq) nextSeq = obj.seq + 1; } catch {}
      }
    }

    const now = new Date().toISOString();
    const entries = deduped.map((m, i) => ({
      id: `mem_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      seq: isFeature ? undefined : nextSeq + i,
      content: m.content,
      category: m.category || (isFeature ? "misc" : ""),
      type: isFeature ? "feature" : "feeling",
      importance: Math.min(5, Math.max(1, Math.floor(m.importance || 3))),
      createdAt: now, accessedAt: now, accessCount: 0,
    }));

    if (isFeature) {
      for (const e of entries) {
        const catDir = path.join(this.featuresDir);
        fs.mkdirSync(catDir, { recursive: true });
        const catFile = path.join(catDir, `${e.category || "misc"}.jsonl`);
        fs.appendFileSync(catFile, JSON.stringify(e) + "\n", "utf8");
      }
    } else {
      for (const e of entries) fs.appendFileSync(outputFile, JSON.stringify(e) + "\n", "utf8");
    }

    this._saveState({ [stateKey]: Date.now() });
    console.log(`[memory-miner] ${targetDate}: ${label} — saved ${entries.length} entries`);
  }

  /** 单通道挖掘 (API key 模式) */
  async _mineChannel({ targetDate, messages, prompt, outputFile, stateKey, label, isFeature = false }) {
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

    // 去重
    const existing = isFeature ? this._loadAllFeatures() : this._loadFile(outputFile);
    const existingSet = new Set(existing.map((e) => e.content));
    const deduped = raw.filter((m) => !existingSet.has(m.content));
    if (!deduped.length) {
      console.log(`[memory-miner] ${targetDate}: ${label} — all ${raw.length} already exist`);
      this._saveState({ [stateKey]: Date.now() });
      return;
    }

    // 自增序号 — 从已有 feelings 中找最大 seq + 1
    let nextSeq = 1;
    if (!isFeature && fs.existsSync(this.feelingFile)) {
      const existing = fs.readFileSync(this.feelingFile, "utf8").split("\n").filter(Boolean);
      for (const line of existing) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "feeling" && typeof obj.seq === "number" && obj.seq >= nextSeq) {
            nextSeq = obj.seq + 1;
          }
        } catch {}
      }
    }

    const now = new Date().toISOString();
    const entries = deduped.map((m, i) => ({
      id: `mem_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      seq: isFeature ? undefined : nextSeq + i,  // 只有 feeling 有 seq
      content: m.content,
      category: m.category || (isFeature ? "misc" : ""),
      type: isFeature ? "feature" : "feeling",
      importance: Math.min(5, Math.max(1, Math.floor(m.importance || 3))),
      createdAt: now,
      accessedAt: now,
      accessCount: 0,
    }));

    if (isFeature) {
      this._appendFeatures(entries);
    } else {
      this._appendFile(outputFile, entries);
    }

    this._saveState({ [stateKey]: Date.now() });
    console.log(`[memory-miner] ${targetDate}: ${label} — saved ${entries.length} entries`);
    for (const e of entries) {
      const tag = isFeature ? `[${e.category}] ` : "";
      console.log(`  - ${tag}${e.content.slice(0, 100)}...`);
    }
  }

  /** 特征按类别分文件写入 */
  _appendFeatures(entries) {
    const byCategory = {};
    for (const e of entries) {
      const cat = FEATURE_CATEGORIES.includes(e.category) ? e.category : "misc";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(e);
    }
    for (const [cat, batch] of Object.entries(byCategory)) {
      this._appendFile(path.join(this.featuresDir, `${cat}.jsonl`), batch);
    }
  }

  /** 加载所有特征文件 */
  _loadAllFeatures() {
    const all = [];
    for (const cat of FEATURE_CATEGORIES) {
      all.push(...this._loadFile(path.join(this.featuresDir, `${cat}.jsonl`)));
    }
    return all;
  }

  _loadFile(filePath) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return raw.split("\n").filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  _appendFile(filePath, entries) {
    const lines = entries.map((e) => JSON.stringify(e) + "\n").join("");
    try { fs.appendFileSync(filePath, lines, "utf8"); }
    catch (err) { console.error(`[memory-miner] append error: ${err.message}`); }
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
          const reply = data?.choices?.[0]?.message?.content || "[]";
          return parseJsonArray(reply);
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
    try { return JSON.parse(fs.readFileSync(this.stateFile, "utf8")); } catch { return {}; }
  }

  _saveState(state) {
    try { fs.writeFileSync(this.stateFile, JSON.stringify({ ...this._readState(), ...state }), "utf8"); } catch {}
  }
}

module.exports = { MemoryMiner };
