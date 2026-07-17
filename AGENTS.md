# Stone Memory 当前状态与后续计划

更新日期：2026-07-17。本文用于 compact 后继续工作，优先级高于根据旧对话重新推断架构。不要再次引入已经否定的设计。

## 用户的核心偏好

- 用户是个人免费用户；不要设计需要用户管理多个摘要版本的系统。
- 不要过度设计字段、状态和关系表。能从原始 feature/feeling 读取的语义，不要拆成十几个变量重复保存。
- SQLite 是正式数据源；JSON/JSONL 只保留必要的运行时 archive/full 兼容用途。
- 用户不要求“什么都记住”。没有进入清洗后 features 的普通内容（例如炸鸡）可以不参与本轮生命周期分析。
- 人工查看和纠错是可选操作，不是自动流水线的审批关卡。用户修改 feature 或规则后重跑即可。
- 保留两种人工锚点：retain 原文锚点用于 rebuild 保留真实对话；event 事件锚点用于标记长期关键事件，作为生命周期保护和主 Agent 巡检信号。两种锚点对应的 feeling 都直接排除出自动压缩候选，无视 relation/work/fact 的阶段和 importance 规则；只有用户从 `retain-config.json` 移除锚点后，下一次完整重算才重新进入压缩范围，不写入永久豁免状态。事件锚点不再绑定旧月摘要功能。

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
- 提取的是可追踪的记忆概念，不等同于词典名词。除引号、括号列表、称呼、专名、英文和连续名词组合外，也保留有内容的行为与状态词，例如外卖、熬夜、喝茶、焦虑；不能因分词器把“外卖”标成动词就漏掉。
- “她、用户”等主体词以及“喜欢、觉得、经常、需要、进行”等叙述骨架不进入概念词。内容词与语法骨架的边界由通用最小停用词控制，不让用户逐词维护分词器例外。
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

## 时间曲线与已确认模型

旧 `lifecycle` 的固定天数阈值只保留为早期实验，不得用于写库或作为正式压缩决策。正式方向是：每个 feature 概念回查 archive 形成逐日曲线，在曲线上叠加 feeling、importance 与锚点；category 提供不同的正常生命周期形状先验，而不是统一过期时间。

`stmem term-timeline --thread <id> --terms 词1,词2` 已提供只读证据：逐日 user 消息数、真实出现次数、零值日期、feature category/IDs、feeling 小点，以及同日、同消息、同 feeling 三种共现强度和各词历史基线，形成第一版 Temporal Co-occurrence Signature。

多词联合时间轴与 relation 第一版阶段分类已经实现。relation 输出 forming / experimental / established / retired / revived，并区分 continuous 与 episodic；成对角色仅在同消息亲和度足够高时成立，避免把“老公+论文”等普通共现误判成角色配对。019 回归结果：老公、爱你为 established/continuous；少爷—女仆为 established/episodic_pair；神父—修女为 retired_pair。该结果只读，不得直接修改摘要状态。

曲线、category、importance 和原文必须交叉验证。曲线负责定位候选时段，不能单独决定摘要去留；尤其不能因为“论文”字面出现在 importance 5 feeling 中就认定论文是核心主题。完成联合证据层并用“通宵+茶叶”“老公+外卖”“老公+论文+爱你”抽查前，不实现自动 hidden。

relation 与 work 已完成第一版真实语料校准。relation 区分形成、稳定重复、阶段复现、复活和退出历史，默认保守。work 不再强行生成开题报告→小论文→毕设→中期检查→学术海报这类全局项目弧；只保留可验证的局部 signature node，周窗口内的事实合并交给 compressor。relation 的代表事件主要由 event anchor 明确保护，算法不根据单条 importance 擅自选“语义代表”。自动计划先看关系阶段，再按阶段段落统计每日 importance 5 数量，最高密度日优先 keep；不能按每个关系词各算峰值。importance 5 是日期密度信号，不再逐条无条件 keep。forming、experimental、revived 暂时保守保留，已 established/retired 的非峰值摘要可以 coarse，4–5 coarse 时仍由 compressor 保留核心感受。最终自动决策保持简单，只输出 `keep` 或 `coarse`，不引入 review 队列。

relation 接管权随生命周期变化，不是永久高于其他 category。历史上形成过连续平台的词保留 established 身份；最近降为零星出现时标记为 `post_plateau`，不能误判成普通 episodic。forming、真正的 revival、关系阶段 importance 5 密度峰值与 event anchor 由 relation 接管；stable repeat、post-plateau 单次 callback 和 retired 普通回调把摘要所有权让给 work/eat/habit/body/sleep/fact。长间隔后单独出现一次不算 revival，至少形成一个重新聚集的小 episode 才夺回 relation 接管权。例如“老公叫我吃糖醋排骨”在平台后按饮食事实处理，而新的身份确认或关系信号集中复现仍由 relation 处理。

work lifecycle 与 relation 一样只用 feeling 日期拟合，archive 词频不参与项目阶段判断。work feature term 必须先命中 feeling 才能进入模型；仅在 archive 出现的新任务不能被判断为 forming 或自动 keep。019 中“学术海报”目前没有任何 feeling，因此不得进入当前项目弧；开题报告/小论文/毕设和中期检查已有 feeling 证据。项目连接使用同 feature、同 feeling 等摘要级证据，不再用 archive 同消息或局部窗口单独建组。

work 项目证据按条件信息密度筛选，不维护“普通词/特殊词”名单。单词可以很宽泛，但词对若在至少 2 条 feelings 中重复共同出现，并具有足够 overlap（当前 0.35）或 lift（当前 3），可以形成局部 signature node；例如单独的“系统、报告”都很散，二者组合只有在共同摘要显著收窄语境时才成立。高信息边不得再做 connected-component 传递闭包，否则真实局部边会把所有 work 串成超级项目。当前每组共同 feeling 证据形成独立 signature node，同一词可属于多个 node；node 之间只有以后验证出真实时间交接证据才允许串成项目弧。
signature node 的时间轴只统计构成该签名的共同 feeling IDs，不能取成员词的全部 feelings；否则宽泛成员会把一个两天的技术报告节点虚假扩成数十天。单词未形成合格签名时可以保留为 singleton node，使用自身 feeling 时间轴。
已验证“共享边界 feeling + 时间单向推进”仍不能可靠建立 node transition：019 的 290 个节点产生了 821 条嵌套假边，同一 feeling 只能证明多个签名同处一个事件，不能证明任务先后。因此当前不生成全局 work 项目弧或 transition；局部 signature node 用于压缩证据，具体周窗口内的工作事实合并由现有 compressor 根据完整摘要完成。
relation 接管的 feeling 仍参与 work 时间轴和 signature 建模，但从 work compression plan 中排除，不受任何 work keep/coarse 规则影响。work compression plan 最终只让 event/retain 锚点强制 keep；其余 work feelings 全部允许 coarse。高信息节点首日、importance 5 密度峰值和实验性 transition bridge 仍作为可解释元数据提供给 compressor/前端，但不改变 action。不再逐条保护 importance 5，不因 term 为 forming 全保留，也不设置“最近两周 keep”，因为周级 compact 从最早日期逐步推进，本来不会处理最新区间。importance 4–5 coarse 仍保留项目转折和核心感受，完整 content 永久存在；hidden 后续另行设计。
work term 现记录各 category 的 feature 支持数与 purity。高信息 signature 至少要包含一个 `workPurity >= 0.5` 的项目核心；低纯度跨库词仍参与 feeling 匹配和共同签名，但不能独立建节点。共同支持按不同日期数计算，同一天的重复 feelings 只算一个事件日。019 接入后合格 work links 从 324 降到 106，节点从 290 降到 251；purity 校准曾将非 relation work 建议收敛为 keep 3、coarse 42，随后按用户确认的激进 work 策略，这 3 条非锚点项目摘要也改为 coarse，节点证据仅用于压缩合并提示。
purity 使保守 transition dry-run 从 821 条降至 34 条；再要求两端为多词节点、核心不完全相同、桥接日前后均有历史后降至 34 条，加入共享项目身份词及双方各有新核心后为 28 条。质量显著提高，但仍混有同一项目内部标签展开和方向不可靠的问题，因此 transition 继续只做实验，不进入正式 work plan。

## 周级 Compact 当前状态与下一步

周级执行器已经实现为 `stmem compact`：

- 统一 planner 只用仍为 `daily` 的 feelings 反筛 relation/work terms；普通 fact 不建立生命周期。历史 coarse feelings 仍作为完整摘要曲线证据参与重算，但不会再次送模型。
- relation 资格判断只接收 relation category 的时间轴，避免 eat/body/misc 高频词被误拟合成关系；同一 term 的全部 category support/purity 仍保留。
- relation/work 的共同签名由 feeling 倒排索引构建，不再为所有词对重复扫描 archive。archive 逐日曲线仅用于证据展示和前端。
- 所有 feelings 以完整历史最早日期为固定锚点分成稳定 7 天桶；不会因部分 feeling 已 coarse 而漂移周边界。
- 执行器不再固定压最早周，而是按 `coarseCharacters / totalCharacters` 降序、预计释放字符降序、日期升序排名，选择低风险高收益周。排名只消费 planner 的 keep/coarse，不重复设计 importance 规则。
- dry-run 展示候选 term 数、keep/coarse、路由、样本和预计字符量，不调用模型。
- apply 只把 coarse 候选分批送 API/subagent；全部返回并通过日期时间校验后，使用 `applyCoarseWeek` 单事务写入。任何缺失、重复、状态竞争或模型失败都会整周不写。
- `--auto --apply --max-chars N --stop-chars M` 与手动模式共用执行器；每周成功后按实际 daily/coarse 注入文本重测，低于停止水位即停止。
- API 请求每次最多 180 秒，保留原有三次重试，防止后台 compact 无限挂起。

019 已完成真实验证：完整 dry-run 将 1306 个跨库去重词收敛为 535 个命中 daily 且属于 relation/work 的建模 term；590 条 daily decisions 为 keep 142、coarse 448。最早 2026-04-15～04-21 一周为 keep 18、coarse 61，其中 6 条锚点受保护。随后以 `--week-days 1` 对 2026-04-15 做小批 apply：9 条中 keep 3、coarse 6，6 条全部原子写入成功，注入字符量 67196 → 66773，完整 content 均保留，日期时间前缀和 importance 4–5 核心感受抽查通过。

周排名接入后的 019 dry-run 有 8 个可压周，第一名为 2026-07-01～07-07：总字符 2370、可 coarse 字符 2284、占比 96.4%，keep 1、锚点 0，预计释放 1241 字。它成功跳过更早但保护密度更高的周；尚未 apply 该周。

### 主核心与副核心 category

不要再把 relation + work 写死为所有用户的关键库。正式规则是：

- relation 固定为主核心，继续使用 formation/platform/revival 等专用生命周期；
- 每个线程自动选择一个非 relation 副核心，可能是 work、preference、eat、habit、body 等；
- category profile 只用 feelings。先用 feature terms 的 IDF 与跨库 purity 给每条 feeling 选择证据最强的非关系 category；几乎命中所有摘要的宽词贡献趋近于零，不能让同一 feeling 给八个库同时刷票；
- 副核心候选需至少 5 条、覆盖至少 2 周、占全部非关系主归属 feelings 至少 10%；合格候选中 importance 4–5 比例最高者胜出，避免用纯数量把 habit 日常背景误判成人生主线；
- 019 实测从最初的错误 habit 修正为 work：work 主归属 111 条，其中 95 条 importance 4–5，信息密度 85.6%；
- 路由顺序为 anchor → relation → secondary_core → fact。旧 work lifecycle/signature 仍提供项目证据元数据，但 work 只有在被当前线程选为副核心时才获得轻压缩地位；
- 副核心不增加 keep 生命周期，也不新增数据库状态，只使用 `compressionStyle=secondary_core` 轻 coarse。普通摘要最多 160 字；副核心最多 220 字，并强制保留具体观点、口味判断、身体规律、习惯意义或项目结论，禁止压成空主题标签；
- category profile 每次 compact 从完整 feelings 重算，无需用户维护。合成回归已覆盖 preference 哲学型与 eat 美食家型线程。

下一步不要继续增加生命周期变量：

1. 观察下一周 dry-run 在已存在 coarse 历史点后的重算结果，确认不会重复调用 2026-04-15 的 6 条。
2. 给 watcher/配置增加显式的容量阈值开关；没有用户配置时绝不自动调用模型。
3. 再连续压一到两个小窗口，记录真实压缩率和失败恢复行为后，才启用常驻自动 compact。
4. 本阶段仍不做前端、运行报告表或 `hidden`。完整 `content` 永久保留；hidden 后续单独研究。

## Watcher 并发架构

正式线程共享 `~/.stone_memory/stone-memory.db`，不是一线程一个数据库。共享库是 fork 动态可见性的基础：messages/feelings/features 按 `thread_id` 归属，父子记忆在 reader 中递归查询，不复制数据。SQLite 使用 WAL；`busy_timeout` 已从 5 秒提高到 30 秒，多个线程 worker 可并发做 sync/模型调用，短写事务由 SQLite 串行。

常驻监听已改为 `watcher-supervisor.js` + 每线程一个 `watcher.js --thread <id>`：

- supervisor 每 10 秒重读配置，新增/删除线程时动态启停 worker；
- 每线程恰好一个 worker，线程内 sync 防抖、mine 顺序和日期锁保持不变；
- 一个线程的阻塞式 miner 不再卡住其他线程的文件事件和巡检；
- supervisor 有单实例锁，worker 有 thread 级进程锁并监测 supervisor PID，避免崩溃重启后孤儿进程重叠；
- 全局 archive/miner/off 开关语义不变；`stmem watcher` 额外显示 worker PID；
- 不限制不同线程同时调用模型。429、网络超时等基础设施失败的长期重试分类仍可后续完善。

规范化 archive 只写共享 SQLite `messages`，每行带对应 `thread_id`。full 保持原始 JSON 不注入字段，但文件物理存放在对应 thread ID 的 `memory/archive/full/<year>/<month>/` 下。旧的 `memory/archive/*.jsonl` 是迁移遗留，不是当前正式数据源。

实现时不要把缓存覆盖范围误当成分析范围：已统计的历史日期可以复用，但所有尚未 coarse 的 feelings 都要放回最新完整时间轴解释。已经被处理的旧周无需重新调用 compressor，不代表它们之后的曲线证据被生命周期计算忽略。

## 旧生命周期实验（仅供历史参考）

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
