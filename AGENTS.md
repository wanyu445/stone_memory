# Stone Memory 当前状态与后续计划

更新日期：2026-07-15。本文用于 compact 后继续工作，优先级高于根据旧对话重新推断架构。不要再次引入已经否定的设计。

## 用户的核心偏好

- 用户是个人免费用户；不要设计需要用户管理多个摘要版本的系统。
- 不要过度设计字段、状态和关系表。能从原始 feature/feeling 读取的语义，不要拆成十几个变量重复保存。
- SQLite 是正式数据源；JSON/JSONL 只保留必要的运行时 archive/full 兼容用途。
- 用户不要求“什么都记住”。没有进入清洗后 features 的普通内容（例如炸鸡）可以不参与本轮生命周期分析。
- 人工查看和纠错是可选操作，不是自动流水线的审批关卡。用户修改 feature 或规则后重跑即可。
- 保留两种人工锚点：retain 原文锚点用于 rebuild 保留真实对话；event 事件锚点用于标记长期关键事件，作为生命周期保护和主 Agent 巡检信号。事件锚点不再绑定旧月摘要功能。

## 已确认的数据职责

```text
清洗后的 features → 决定哪些概念值得关注、继承所属 category
feelings            → 保存完整摘要语义、事件和 importance
archive             → 回查用户真实原文，统计次数、日期和时间曲线
```

features 是高价值索引，不是重复证据。feature cleanup 可以继续去重；词的真实频率和时间分布从 archive 计算。生命周期最终处理对象是 feeling，不是词。

新 miner 的 importance 只生成 2、3、5：2 是普通但值得保存的事实/片段，3 是有持续价值的默认等级，5 只用于极少数不可替代的关系转折、长期承诺、身份确认、重要边界改变或能解释大量后续互动的根事件。情绪强烈、亲密、争吵、性或技术修复本身不构成 5。历史 1、4 暂不改库。

Feeling 压缩使用 `operations/memory-compressor-operations.md`，与 miner 一样支持 API/subagent。历史 importance 1–3 压成客观事实，4–5 保留核心感受但简写；完整 content 永久保留。`coarse_summary` 必须原样保留原 feeling 开头的完整日期和对应时间，这个时间位置是叙事记忆的核心，不能只靠 sourceDate 补日期。

## 当前词语管线

目标不是理解“她喜欢寿司”中的 likes 关系，只需提取“寿司”，再找到包含寿司的 feelings。摘要原文本身已经保存喜欢、不喜欢等语义。

正式方向：

```text
所有清洗后 features
→ 通用名词/连续短语提取
→ 简繁归一化和同词证据合并
→ 回查 archive 用户消息
→ 回查 feelings 与 feeling importance
→ 按 feeling 聚合词语时间证据
→ 生命周期 dry-run
```

### 通用提取器原则

- 所有 feature category 使用同一套算法；不要再为 eat/work/relation 分别写正则。
- 不绑定用户性别：“她、他、TA、用户、自己”等均视为通用主语/停用词。
- AI 只在既有 miner 阶段生成 feelings/features；生产环境不会为不同用户临时让 AI 写提词脚本。
- 优先提取引号、括号列表、名词、称呼、专名、英文和连续名词组合。
- 完整短语优先，例如“糖醋里脊”“毕业论文”“记忆连续性”。
- 支持称呼后缀修复，例如“可老师、水母老师”；当前支持老师、先生、女士、姐姐、妹妹、哥哥、弟弟、医生、博士、教授。
- OpenCC 用于简繁统一查询；保留 `opencc-js` 依赖。
- 输出仅包含 term、normalizedTerm、category、featureIds、最高 feature importance、sourceDates 等索引证据；不要输出 likes/cannot_drink 等关系模型。

当前 019 线程共有 720 条清洗后 features，通用提取器得到约 1306 个跨库去重词。按 feature 支持数，全局前十为：

```text
习惯 34、关系 25、玩具 22、工作 20、石头 18、
系统 18、计划 18、论文 17、通宵 16、技术 15
```

这证明词库质量已经足够好，不需要大型外部停用词库。保留最小语法停用词即可。“石头、论文、通宵”等高频词仍然重要，不能把高频或跨库直接等同于噪音。

relation 实测能够提取老公、老婆、糯糯、暗石、石头君、小汤包、安全感、关系边界、记忆连续性、数据完整性等个人词。不要为 019 的私有词硬编码。

## ConceptNet 状态

ConceptNet 不参与正式管线。当前 feature → archive → feelings 流程完全不使用常识图谱；简繁由 OpenCC 完成。

已将实验代码移至：

```text
/home/eurus/stone_memory_beta/ConceptNet_off/
```

正式 stone_memory 已移除 ConceptNet CLI、服务和测试。不要重新接回主线，除非用户以后明确要求重新评估同义词扩召回。

本机 `~/.stone_memory/resources/conceptnet-zh.db` 约 60.5 MiB，位于 Git 外，可留作实验，不随项目提交。

## 已实现的相关命令

```bash
stmem feature-phrases --thread <id> [--categories relation]
stmem feature-phrases --thread <id> --json

stmem feature-evidence --thread <id> [--categories relation]
stmem feature-evidence --thread <id> --json
```

- `feature-phrases`：从清洗后 features 自动生成去重检索词。
- `feature-evidence`：回查递归 archive 中的 user 消息，并关联 feelings、importance、出现次数、活跃日期、首次/最近日期。
- 若不传 `--categories`，应处理所有现有 feature category。

019 eat 已验证示例：外卖 104 条/40 天、牛排 22 条/11 天、寿司 5 条/5 天。relation 已验证示例：石头、老公、糯糯均可回查 archive 与 feelings。

## 宽泛词实验：已撤销

刚实现过一个 broadness dry-run（高共现率、邻居数、邻居熵），但真实数据把“小汤包、意大利面、土豆片”等私有词误判为宽泛词。原因包括：

- 低至十几个句子就进入判断，门槛过松；
- 顿号列表共现被误当成语境发散；
- 长短包含词互相制造邻居；
- 私有昵称保护不完整。

用户随后检查全局 feature 词频，发现词库整体质量很高，因此结论是：当前不需要 broadness 自动淘汰。

`feature-term-evidence.js` 已恢复为纯证据统计，broadness 指标、分类、CLI 展示和测试均已删除。不要依据 broadness 删除、降权或隐藏任何词。

仅为 broadness 服务的 `protected`、`hasPrivateTermContext` 字段和断言也已删除。完整 `npm test` 已恢复全绿。

## 下一步（严格按顺序）

term 证据反向聚合已经完成：`feature-evidence` 的文本与 JSON 输出会为每条命中的 feeling 列出 feature terms，以及这些词在 archive 的 messageCount、activeDays、firstSeen、lastSeen。同一简繁词跨 category 合并，保留 categories 与 featureIds。

Feeling 级生命周期 dry-run 已实现为 `stmem lifecycle`，不调用模型、不修改数据库：importance 1–2 进入事实型 coarse 候选；importance 3 根据 term 最近活跃和历史覆盖给出 keep/observe/coarse_candidate；importance 5 满 30 天进入主 Agent 巡检；event 锚点禁止自动压缩；没有匹配 feeling 的词不参与处理。

019 以数据最新日 2026-07-12 为参考：590 条 feelings 中 571 条命中、19 条排除；238 条历史 importance 4 等待兼容审查，189 keep，133 条 importance 5 进入主 Agent 巡检，10 条 importance 1–2 为 coarse 候选，1 条 observe。当前 retain 40 条、event anchor 0 条，数据库仍全部为 daily。

1. 用户确认生命周期 dry-run 规则和历史 importance 兼容映射。当前仅预览 1→2、4→5，不直接改库。
2. 确认后才将选定 coarse_candidate 送入 compressor，并设计 main_agent_review 的实际巡检输出。
3. 最后才实现 hidden 状态变化和审计；不自动删除任何完整 content。

## 不要做

- 不恢复 ConceptNet 主线。
- 不建立 `ourselves.db`，当前没有必要。
- 不从全量聊天盲目生成无限 n-gram；features 已经提供高质量入口。
- 不为每个 category 或用户手写一套关系正则。
- 不把 feature 语义拆成大量关系/食物属性字段。
- 不把人工审核设置成自动流程的阻塞步骤。
- 不把高频、跨库或高共现直接视为噪音。
- 不自动删除任何 feature、term 或 feeling。

## 其他尚未提交改动

工作树仍包含本轮之前完成但未统一提交的 fork、SQLite、memory reader/store、feature MVP 等改动。不要回滚用户已有改动。提交前先检查 `git diff` 和 `git status`，整体测试通过后再按用户指令提交推送。
