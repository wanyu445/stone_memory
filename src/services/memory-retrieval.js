const fs = require("fs");
const path = require("path");

function textSimilarity(query, target) {
  const qWords = new Set(query.toLowerCase().split(/\s+/).filter((w) => w.length > 1));
  const tWords = target.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!qWords.size || !tWords.length) return 0;
  let hits = 0;
  for (const w of tWords) {
    if (qWords.has(w)) hits++;
  }
  return hits / Math.max(qWords.size, tWords.length);
}

// 中文关键词提取
const STOP_CHARS = new Set("的了是我不你他她它这也那就还和与或吗呢吧啊哈呀嘛哦很都也再又没被把从到让给在对为因所以虽然但是因为如果只是之后然后可以需要应该已经不会没有不能知道觉得感觉什么怎么为啥干嘛不用不要".split(""));
const MEANINGFUL_SINGLE = new Set("吃喝睡饿困累痛哭笑骂疯爱恨怕想抱亲舔摸咬抓打踢跑走坐站躺洗刷写读看听唱叫喊说问吵闹玩买卖花赚存取丢捡亮暗热冷香臭酸甜苦辣咸淡红绿黑白大小快慢轻重长短新旧好坏早晚日夜春夏秋冬".split(""));

function extractKeywords(text) {
  const cleaned = text.replace(/[，。！？、；：""''（）【】《》\s\n\.\?\!,;:"'\(\)\[\]<>]/g, "|");
  const segments = cleaned.split("|").filter(Boolean);
  const keywords = new Set();
  for (const seg of segments) {
    if (/^\d+$/.test(seg) || /^[a-zA-Z]+$/.test(seg)) continue;
    // 有意义的单字关键词
    for (const ch of seg) {
      if (MEANINGFUL_SINGLE.has(ch)) keywords.add(ch);
    }
    // 2-gram
    for (let i = 0; i <= seg.length - 2; i++) {
      const bigram = seg.slice(i, i + 2);
      if (!STOP_CHARS.has(bigram[0]) && !STOP_CHARS.has(bigram[1])) {
        keywords.add(bigram);
      }
    }
    // 3-gram
    for (let i = 0; i <= seg.length - 3; i++) {
      keywords.add(seg.slice(i, i + 3));
    }
  }
  return [...keywords];
}

/** 关键词命中率 — 查询中的关键词在目标文本中出现了多少 */
function keywordHitRate(queryKeywords, targetText) {
  if (!queryKeywords.length) return 0;
  let hits = 0;
  for (const kw of queryKeywords) {
    if (targetText.includes(kw)) hits++;
  }
  return hits / queryKeywords.length;
}

// 主动检索触发词 — 消息里带这些关键词说明用户在主动翻记忆
const ACTIVE_RECALL_PATTERNS = [
  /还记得/, /之前说/, /上次/, /上回/, /以前/, /过去/,
  /记得不/, /记不记得/, /有没有印象/, /回忆/,
  /忘了没/, /忘了吗/, /提醒我/, /帮我想/,
];

function isActiveRecall(text) {
  return ACTIVE_RECALL_PATTERNS.some((p) => p.test(text));
}

class MemoryRetrieval {
  constructor({ memoryDir }) {
    this.minedDir = path.join(memoryDir, "mined");
    this.index = new Map();
    this.loaded = false;
  }

  loadIndex() {
    this.index.clear();
    let count = 0;

    // 加载感受记忆
    count += this._loadFile(path.join(this.minedDir, "feelings", "days.jsonl"));
    // 兼容旧文件
    const legacyFile = path.join(this.minedDir, "memories.jsonl");
    if (fs.existsSync(legacyFile)) {
      count += this._loadFile(legacyFile);
    }
    // 加载特征记忆
    const featuresDir = path.join(this.minedDir, "features");
    try {
      const files = fs.readdirSync(featuresDir).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        count += this._loadFile(path.join(featuresDir, f));
      }
    } catch {}

    this.loaded = true;
    const feelingCount = [...this.index.values()].filter((e) => e.type === "feeling" || !e.type).length;
    const featureCount = this.index.size - feelingCount;
    console.log(`[memory-retrieval] loaded ${this.index.size} memories (${feelingCount} feelings + ${featureCount} features)`);
  }

  _loadFile(filePath) {
    let count = 0;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry?.id && entry?.content) {
            this.index.set(entry.id, entry);
            count++;
          }
        } catch {}
      }
    } catch {}
    return count;
  }

  /**
   * 搜索记忆
   * @param {string} queryText
   * @param {object} opts — {topK, threshold}
   *   - 不传 opts: 自动模式（日常对话，高门槛，少结果）
   *   - 传 opts: 手动模式（主动检索，低门槛，多结果）
   */
  async search(queryText, opts = {}) {
    if (!this.loaded) this.loadIndex();
    if (!this.index.size) return [];

    // 自动模式 vs 手动模式
    const isActive = isActiveRecall(queryText);
    const topK = opts.topK ?? (isActive ? 5 : 1);
    const threshold = opts.threshold ?? (isActive ? 0.2 : 0.35);

    const queryKeywords = extractKeywords(queryText);

    const scored = [];
    for (const entry of this.index.values()) {
      const vecScore = textSimilarity(queryText, entry.content);
      // 关键词增益 — 查询和记忆共享具体词汇时加成
      const kwHit = keywordHitRate(queryKeywords, entry.content);
      const kwBoost = kwHit > 0.15 ? 1.2 : (kwHit > 0.05 ? 1.1 : (kwHit > 0 ? 1.04 : 1.0));
      const score = vecScore * kwBoost * (1 + (entry.importance || 3) * 0.03);
      scored.push({ ...entry, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, topK).filter((r) => r.score > threshold);

    const now = new Date().toISOString();
    for (const r of results) {
      const entry = this.index.get(r.id);
      if (entry) {
        entry.accessCount = (entry.accessCount || 0) + 1;
        entry.accessedAt = now;
      }
    }

    return results.map(({ id, content, category, importance, score, createdAt }) => ({
      id, content, category, importance, score, createdAt,
    }));
  }

  /** 日常自动注入 — 只在高相关时触发 */
  async buildMemoryContext(queryText) {
    const memories = await this.search(queryText);
    if (!memories.length) return "";
    const lines = ["Relevant past memories:"];
    for (const mem of memories) {
      lines.push(`- ${mem.content}`);
    }
    return lines.join("\n");
  }

  get size() {
    return this.index.size;
  }
}

module.exports = { MemoryRetrieval, isActiveRecall };
