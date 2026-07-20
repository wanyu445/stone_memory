# Stone Memory — 多线程 AI 记忆系统

从聊天线程中自动挖掘 feelings（日记式记忆）和 features（用户特征），支持多线程、多运行时、多厂商 API。

## 架构

```
stone_memory/
├── bin/
│   ├── stmem                  # CLI 入口 (Linux/Mac)
│   └── stmem.cmd              # CLI 入口 (Windows)
├── scripts/
│   ├── watcher-supervisor.js  # 动态维护每线程一个 watcher worker
│   ├── watcher.js             # 单线程实时归档监听 + 自动挖掘 worker
│   ├── stmem-init.js          # 初始化新线程
│   ├── stmem-fork.js          # 登记父子线程记忆关系
│   ├── stmem-sync.js          # 增量同步线程 → archive
│   ├── stmem-mine.js          # 挖掘 feelings + features
│   ├── stmem-import.js        # 导入旧线程文件
│   ├── stmem-rebuild.js       # 线程重建包装
│   ├── stmem-watcher.js       # watcher 开关管理
│   ├── stmem-status.js        # 查看线程状态
│   ├── stmem-delete.js        # 删除线程
│   └── rebuild-thread.js      # 核心重建逻辑
├── mcp-server.js              # MCP 协议接口（stdio JSON-RPC）
├── src/
│   ├── config.js              # 配置读取（多线程）
│   └── services/
│       ├── memory-archive.js      # Layer 1: 消息存档
│       ├── memory-miner.js        # Layer 2: 挖掘引擎
│       ├── feature-phrase-extractor.js # feature 记忆概念（对象/行为/状态）提取
│       ├── feature-term-evidence.js    # archive/feeling 证据统计
│       ├── memory-keyword-search.js # 关键词搜索
│       ├── subagent-runner.js     # subagent CLI 调用
│       └── thread-rebuilder.js    # 线程重建引擎
└── operations/                # AI 指令模板
    ├── memory-miner-operations.md
    └── memory-subagent-operations.md
```

### 数据目录结构

```
~/.stone_memory/
├── stmem.json                    # 全局配置（线程定义 + API keys + runtimes）
├── stone-memory.db               # 所有线程共享的 SQLite 主数据源
├── watcher.pid                   # watcher 进程 ID
└── runtimes/{runtime}/{purpose}/{threadId}/
    ├── logs/                     # 线程日志
    ├── tmp/                      # 临时文件（subagent prompt 等）
    ├── rules/                    # 线程规则（rebuild 时注入）
    │   ├── instructions.md       # 人格指令
    │   └── operations.md         # 操作指令
    └── memory/
        ├── archive/
        │   └── full/YYYY/MM/YYYY-MM-DD.jsonl  # 未经规范化的原始线程消息
        ├── topics/*.md               # 专题记忆（按主题）
        ├── import/done/              # 已导入的源文件
        ├── retain-config.json        # 锚点保留配置
        ├── audit-marks.json          # 审计标记
        ├── audit-report.md           # 审计报告
        └── search-log.jsonl          # 搜索日志
```

规范化 messages、feelings、features、挖掘状态和通知统一存放在全局 SQLite 中，通过 `thread_id` 区分线程。消息以 `(thread_id, timestamp)` 为主键。系统只保存当前有效的记忆结果，不维护用户可选的历史版本。运行时唯一保留的 JSONL 是 `archive/full` 原始备份；其他 JSONL 只由显式 `stmem db export` 生成，或用于一次性旧数据迁移。

父子线程不复制记忆。子线程每次 rebuild 都会动态读取父级最新的 feelings/features；子线程自己的近期上下文仍只来自自己的 `full`。子线程记忆默认可回流给父级，也可以在建立关系时关闭。

## 安装

项目依赖 `better-sqlite3`。首次安装需要在项目目录执行 `npm install --production`，再注册 `stmem` 命令。

### Linux / macOS

```bash
# 1. 解压到任意目录
tar xzf stonememory.tar.gz -C ~/

# 2. 软链到 PATH（唯一的一步）
ln -sf ~/stone_memory/bin/stmem ~/.local/bin/stmem

# 3. 开始用
stmem init --thread <线程ID>
```

> 如果 `~/.local/bin` 不在 PATH 中，在 `.bashrc` 加一行：`export PATH="$HOME/.local/bin:$PATH"`

### Windows

**方式一：将 bin/ 加入 PATH（推荐）**

```cmd
:: PowerShell 或 cmd，执行一次即可
setx PATH "%PATH%;C:\Users\<用户名>\stone_memory\bin"
```

之后任意终端直接输入 `stmem`。

**方式二：npm link**

```cmd
cd C:\Users\<用户名>\stone_memory
npm link
```

npm 自动在全局目录创建 `stmem.cmd`（该目录通常已在 PATH 中）。

> Windows 上 subagent 模式不可用（依赖 `claude` CLI），建议配置 API key 走 API 模式。

**C 盘空间不足？** 数据目录默认在 `%USERPROFILE%\.stone_memory`，可用 `mklink /J` 映射到其他盘：

```cmd
move %USERPROFILE%\.stone_memory D:\stone_data
mklink /J %USERPROFILE%\.stone_memory D:\stone_data
```

## 快速开始

### 初始化线程

```bash
stmem init --thread <线程ID>
```

交互式填写: AI 名字、用户昵称、运行时、用途、挖掘模式等。

### 关联 fork 线程

先分别初始化或登记父、子线程，再建立关系：

```bash
# 默认：父级记忆对子线程可见，子线程记忆也可回流父级
stmem fork --parent <父线程ID> --thread <子线程ID>

# 子线程仍同步父级记忆，但子线程产生的记忆不回流
stmem fork --parent <父线程ID> --thread <子线程ID> --no-memory-return
```

这里只建立持续的记忆关系，不复制 feelings/features，也不拼接父线程或兄弟线程的近期 `full`。

### 导入旧对话

```bash
# 先预览单个 JSON、JSONL 或 SQLite 数据源，不会写入
stmem import --source /path/to/<线程ID>.jsonl --thread <线程ID>

# 确认字段和日期范围后实际导入
stmem import --source /path/to/<线程ID>.jsonl --thread <线程ID> --apply

# 递归导入目录
stmem import --dir /path/to/线程目录 --thread <线程ID> --apply

# SQLite 多表时指定对话表；非标准字段可显式映射
stmem import --source /path/to/chat.db --table messages \
  --map-time created_at --map-role sender --map-content body --apply
```

导入将规范化对话写入 SQLite `messages`，并生成按日期递归保存的 `full` 原始备份，不生成
feelings/features，也不生成 `seq` 或 `importance`。来源中的评分、向量等额外字段
不会进入规范化对话，但会原样保留在 `full` 中。旧 `stmem adapt` 命令仍可使用，
内部会转到同一套导入流程。

### 挖掘记忆

```bash
# 按线程配置走（api 或 subagent）
stmem mine --thread <线程ID> --date 2026-06-09

# 一次性挖完所有未挖日期
stmem mine --thread <线程ID> --all

# 用户主动要求整日重挖：成功后直接覆盖当天结果，失败则保留旧结果
stmem mine --thread <线程ID> --date 2026-06-09 --force

# 临时切换模式
stmem mine --thread <线程ID> --all --api       # 走 API
stmem mine --thread <线程ID> --all --subagent  # 走 subagent CLI
```

### Feature 词语证据

从所有清洗后的 features 生成候选词，并只读回查当前线程的原始用户消息和 feelings：

```bash
stmem feature-phrases --thread <线程ID>       # 只读提取去重后的 feature 检索词
stmem feature-phrases --thread <线程ID> --json
stmem feature-evidence --thread <线程ID>      # 自动回查 archive 词频与 feelings importance
stmem feature-evidence --thread <线程ID> --json
```

`feature-phrases` 使用同一套通用规则处理所有已经过 miner/cleanup 筛选的 feature 类别，不绑定用户性别，也不为 eat/work/relation 分别写规则。它提取可追踪的记忆概念，包括对象、行为和状态，优先保留引号、括号私有词、连续名词与相邻内容短语；“喜欢、觉得、经常、需要”等叙述骨架会被过滤。同一词只合并 feature ID、最高 importance 和来源日期，不另建属性或语义关系模型。

报告中的对话频率只统计用户消息，并与命中的 feelings 数量、覆盖日期数分开。同一个词可以同时属于多个特征库。`feature-evidence` 还会为每条命中的 feeling 反向列出 terms 及其 `messageCount`、`activeDays`、`firstSeen`、`lastSeen`；JSON 输出位于 `feelingEvidence`。这两个命令都只读，不修改 importance 或摘要状态。

### Feeling 压缩

压缩器与 miner 使用相同的线程模式配置，支持 API 和 subagent。默认只 dry-run；importance 1–3 压成客观事实，4–5 保留核心感受但大幅简写。压缩结果必须原样保留 feeling 开头的完整日期和对应时间。

```bash
stmem compress --thread <线程ID> --before 2026-06-01 --limit 20
stmem compress --thread <线程ID> --ids <id1,id2> --subagent
stmem compress --thread <线程ID> --before 2026-06-01 --apply
```

`--apply` 必须同时提供 `--before`、`--ids` 或 `--all`。应用后完整 `content` 不变，只写入完整时间前缀开头的 `coarse_summary`，并将 `summary_mode` 切换为 `coarse`。

正式的生命周期压缩入口是周级 `compact`。它先用仍为 `daily` 的 feelings 反筛 relation/work terms，再将历史 coarse feeling 点作为完整曲线证据重算 relation/work/fact 路由。所有 feelings 按完整历史起点分成稳定的 7 天桶，再按可压缩字符占比、预计释放字符量和日期排序；默认展示排名第一的低风险高收益周。只有整周模型结果全部成功，才在一个事务中写入所有 coarse 候选：

```bash
stmem compact --thread <线程ID>                         # dry-run，不调用模型
stmem compact --thread <线程ID> --week-days 1           # 小批 dry-run
stmem compact --thread <线程ID> --apply --api            # 原子处理最早一周
stmem compact --thread <线程ID> --apply --weeks 2        # 最多依次处理两周
stmem compact --thread <线程ID> --auto --apply \
  --max-chars 70000 --stop-chars 60000                  # 超水位后逐周处理
```

排名只消费 planner 已经产生的 keep/coarse，不重新发明 importance 权重：先比较 `coarseCharacters / totalCharacters`，再比较预计节省量，完全相同时优先更早的周。`compact` 每周写入后按实际注入纯文本重新测量容量并重新规划、重新排名；已是 coarse 的 feeling 不会再次调用模型。event/retain 锚点始终保持 daily。`--auto` 只有当前字符量高于 `--max-chars` 才启动，并在低于 `--stop-chars` 后停止。archive 词频仍供时间轴展示，但生命周期拟合只使用摘要点。

每次规划还会从全部 feelings 自动生成线程级 category profile。relation 固定作为主核心并继续使用专用生命周期；非 relation feelings 根据摘要中具有区分度的 feature terms 归入证据最强的 category。覆盖至少 2 周、至少 5 条且占非关系归属摘要至少 10% 的 category 中，importance 4–5 密度最高者成为唯一副核心。几乎每条摘要都出现的宽词 IDF 接近零，不能给某个库刷票。

副核心可以因用户而异：019 为 work，哲学型用户可为 preference，美食家可为 eat。副核心仍然 coarse，但使用 `compressionStyle=secondary_core`：保留具体观点、口味判断、身体规律、习惯意义或项目结论，最多 220 字；普通 coarse 最多 160 字。路由顺序为 anchor → relation → secondary core → fact。副核心是每次 compact 动态重算结果，不新增数据库状态或用户维护项。

### 生命周期 dry-run

生命周期报告把 feature term 的 archive 时间证据反向聚合到 feelings，并结合 importance 和人工锚点生成只读建议：

```bash
stmem lifecycle --thread <线程ID>
stmem lifecycle --thread <线程ID> --action coarse_candidate --all
stmem lifecycle --thread <线程ID> --json
```

未命中 feature terms 的 feelings 不参与处理；事件锚点禁止自动压缩；历史 importance 4 只展示兼容审查。报告不会调用压缩模型，也不会修改数据库。

### Term 时间轴

按自定义时间范围查看 feature term 在 archive 用户消息中的逐日词频，并叠加命中的 feeling、importance 和锚点：

```bash
stmem term-timeline --thread <线程ID> --terms 通宵,茶叶,老公
stmem term-timeline --thread <线程ID> --terms 论文 --from 2026-05-01 --to 2026-07-01
stmem term-timeline --thread <线程ID> --terms 外卖 --json
# 多词查询额外输出同日、同消息、同 feeling 的共现证据
stmem term-timeline --thread <线程ID> --terms 老公,论文,爱你
```

输出只读，不产生生命周期状态变化。JSON 中的 `timeline` 包含所选范围内的零值日期，方便前端直接绘制连续曲线；`baseline` 给出全时段日均、活跃日均和活跃日占比，`intersections` 给出两两及全词集合的同日、同消息和同 feeling 重合。relation 词还会输出 `relation` 阶段报告，区分 forming、experimental、established、retired、revived，以及 continuous、episodic 等曲线形状；高亲和度成对角色会单独报告。

### 线程重建

```bash
stmem rebuild --thread <线程ID>           # 预览
stmem rebuild --thread <线程ID> --apply   # 写入
```

顺序：**import → mine → rebuild**（rebuild 需要 feelings 就绪后才能浓缩记忆到线程里）

### watcher 管理

init 后 watcher 自动启动（Linux 走 systemd，Windows 走后台进程）。
线程文件发生变化后会在约 300ms 防抖后增量同步到 archive；后台仍会低频巡检，作为文件系统漏事件时的兜底，并负责自动挖掘和摘要维护。

```bash
stmem watcher               # 查看状态
stmem watcher off           # 完全暂停
stmem watcher on            # 完全启用
stmem watcher archive off   # 关掉 archive 同步
stmem watcher archive on    # 打开 archive 同步
stmem watcher miner off     # 关掉自动挖掘
stmem watcher miner on      # 打开自动挖掘
```

自动压缩默认关闭。需要时在对应线程配置中显式加入纯摘要文本水位；worker 启动及新一天挖掘成功后检查一次，超过 `maxChars` 才调用现有周级 compact，并逐周压到 `stopChars` 以下：

```json
"autoCompact": {
  "enabled": true,
  "maxChars": 70000,
  "stopChars": 60000
}
```

容量只计算实际注入的 feelings 文本：daily 使用 `content`，coarse 使用 `coarse_summary`，hidden 计 0；不计算 features、archive、JSON 和元数据。配置缺失、关闭或水位非法时不会调用模型。

## 配置

### stmem.json

位于 `~/.stone_memory/stmem.json`:

```json
{
  "apiKeys": {
    "deepseek": {
      "key": "sk-...",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-v4-flash"
    },
    "openai": {
      "key": "sk-...",
      "baseUrl": "https://api.openai.com",
      "model": "gpt-4o"
    }
  },
  "runtimes": {
    "claude": {
      "command": "claude -p --bare",
      "flags": { "systemPrompt": "--system-prompt-file" }
    }
  },
  "<threadId>": {
    "ai": "Alessio",
    "user": "婉儿",
    "label": "主石头",
    "runtime": "claude",
    "purpose": "accompany",
    "sessionDir": "/home/.../.claude/projects/...",
    "minerMode": "subagent",
    "apiProvider": "deepseek",
    "windowDays": 3,
    "keepToolPairs": 30
  }
}
```

### 挖掘模式

每个线程可选两种挖掘模式，底层使用**同一套 instructions**：

| 模式 | 原理 | 速度 | 要求 |
|------|------|------|------|
| subagent | 调 `claude -p` CLI，ops 文件走 `--system-prompt-file` | 慢（串行） | Claude Code 已登录（仅 Linux） |
| api | 直连 API，ops 内容走 system role | 快 | stmem.json 配 apiKeys（全平台） |

两种模式都读取 `operations/memory-miner-operations.md` 作为 AI 指令。
- subagent：ops 文件通过 `--system-prompt-file` 作为 system prompt，stdin 只传对话 + 输出指令
- api：ops 内容作为 API system role，conversation 作为 user role

init 时选择模式，也可后续在 stmem.json 中修改 `minerMode` 字段。

### 自定义挖掘指令

编辑 `operations/memory-miner-operations.md` 可调整：
- AI 人格和语气
- Feelings 写作风格偏好
- **关系时间轴**（见下方说明）

#### 时间轴配置

时间轴帮助 AI 判断每天对话在关系中的阶段背景，让记忆更连贯。打开 `operations/memory-miner-operations.md`，找到 `【时间轴】` 区域，按格式填写：

```md
【时间轴】
- 4月15日~4月21日：关系还在试探和建立阶段
- 5月22日起：时隔一个月重新连接
- 5月24日起：她开始叫你老公
```

每行一条，写明时间段和阶段特征。**AI 不会编造时间轴内容**，留空则不考虑阶段背景。

## MCP Server

SM 通过 **`mcp-server.js`**（项目根目录，不是 `bin/stmem`！）暴露 stdio JSON-RPC 接口。AI 在注册 MCP 时请认准这个文件，**不要**把 `stmem` CLI 命令注册为 MCP 服务。

### 注册方式

**Claude Code（settings.json，mcpServers 字段）**：
```json
{
  "mcpServers": {
    "stmem": {
      "command": "node",
      "args": ["/完整路径/stone_memory/mcp-server.js"]
    }
  }
}
```

**Codex CLI**：
```bash
codex mcp add stmem -- node ~/stone_memory/mcp-server.js
```

**Cyberboss（tool-host 配置）**：
在 tool-host 中添加 stdio MCP server，命令为 `node`，参数为 `mcp-server.js` 的绝对路径。

> 以上操作均可交由 AI 助手完成：说"帮我注册 stmem MCP 服务"即可。注意注册的是 `mcp-server.js`，不是 `stmem` CLI。

### 可用工具（共 9 个）

| 工具 | 功能 |
|------|------|
| `stmem_memory_rebuild` | 重建线程（滚动窗口 + 记忆压缩），重建前自动全量备份 |
| `stmem_memory_mine` | 触发单日挖掘（feelings + features） |
| `stmem_memory_status` | 查看当前 stmem 状态，含各线程 archive/feelings/features 数量 |
| `stmem_memory_search` | 关键词搜索 feelings + 回溯原文 archive |
| `stmem_memory_deep_search` | 深度检索（子 agent 多级搜索 + 原文回溯） |
| `stmem_memory_audit_list` | 从上次审计截止日起列出新 feelings，含锚点类型标注 |
| `stmem_memory_audit_mark` | 标记原文锚点或长期关键事件锚点 |
| `stmem_memory_audit_query` | 按日期或关键词查询 feelings，含锚点类型显示 |
| `stmem_memory_triggers_check` | 检查重建和挖掘阻塞待办，适合会话启动或睡前巡检时调用 |

大部分工具直接调用 SM 的 services。重建（rebuild）和挖掘（mine）因需独立进程上下文，走 Node 子进程调用对应脚本。不带 API key 的用户也可以通过 subagent 模式使用。

## Subagent 模式

subagent 模式不依赖外部 API，通过宿主 Agent 的 CLI 执行挖掘/审计/搜索。

### 运行时配置

在 `stmem.json` 中配置 `runtimes`：

```json
{
  "runtimes": {
    "claude": {
      "command": "claude -p --bare",
      "flags": { "systemPrompt": "--system-prompt-file", "mcpConfig": "--mcp-config", "model": "--model" }
    }
  }
}
```

- `command`：subagent CLI 命令。`-p` 传 prompt，`--bare` 传输出文本
- `flags.systemPrompt`：指定 `--system-prompt-file` 参数名（不同 CLI 可能不一样）
- 运行时名称在 `stmem init` 时选择，或直接编辑 stmem.json 的 runtime 字段

### 执行流程

1. ops 文件（如 `memory-miner-operations.md`）通过 `--system-prompt-file` 作为 system prompt
2. 对话内容 + 输出指令通过 stdin 传入
3. CLI 返回文本，脚本解析 JSON 后写入对应存储位置

这种分离让 ops 文件和执行逻辑解耦：**ops 文件只负责"怎么写记忆"，脚本负责存文件。**

### 自定义运行时

不只是 claude，任何支持 stdin/stdout 的 CLI 都可以接入：

```json
{
  "runtimes": {
    "codex": { "command": "codex exec" }
  }
}
```

## operations 文件说明

`operations/` 目录下的 md 文件是 SM 的 AI 指令模板：

| 文件 | 用途 | 调用方 |
|------|------|--------|
| `memory-miner-operations.md` | feelings + features 挖掘指令 | mine、watcher miner |
| `memory-compressor-operations.md` | feelings 长期颗粒度压缩指令 | compress |
| `memory-subagent-operations.md` | 深度检索指令 | deep_search 工具 |

ops 文件中可以使用 `{{feelingsFile}}`、`{{archiveDir}}` 等占位符，运行时自动替换为线程的实际路径。完整占位符列表见 `src/services/subagent-runner.js` 的 `resolvePlaceholders()`。

## Rules（线程规则）

每个线程有自己的 `rules/` 目录，每次 rebuild 时自动注入到线程头部。

```
~/.stone_memory/runtimes/{runtime}/{purpose}/{threadId}/rules/
├── instructions.md    # 人格指令：AI 的基础人格、行为规则、回复风格
└── operations.md      # 操作指令：AI 可以使用的外部工具、API 配置
```

Rules 在 `rebuild-thread.js` 执行时自动读取并注入，注入后的内容带有 `<!-- stmem-rule: filename.md -->` 标记。如果某条 rule 不需要了，直接删除对应的 md 文件即可，下次 rebuild 不会注入。

与 `operations/` 目录的区别：
- `operations/` — 给 AI 挖掘/审计/搜索用的指令（谁在调用 API）
- `rules/` — 给重建后的线程用的指令（AI 在对话中如何表现）

## Topics（专题记忆）

`memory/topics/` 下按主题存放长期记忆，每条是一个独立的 `.md` 文件。适用于不适合放入日摘要但需要长期保留的信息，如共同回忆、专属词汇表、重要约定等。

```
memory/topics/
├── topic_小绿小紫小黄.md        # 共同回忆
├── topic_石头给小鱼起过的外号和称呼.md  # 专属词汇
├── topic_果冻果冻安全词游戏.md    # 重要约定
└── topic_论坛.md                # 固定话题
```

### Watcher 进程模型

常驻 watcher 使用 supervisor + per-thread worker：supervisor 动态读取配置，确保每个 thread ID 恰好有一个 `watcher.js --thread <id>`。单个线程同步、挖掘或模型调用卡住时，不会阻塞其他线程；新增或删除线程无需重启整个 watcher，下一次配置巡检会自动增减 worker。

所有正式线程共享 `~/.stone_memory/stone-memory.db`，通过 `thread_id` 隔离；fork 依靠同库递归读取父子关系，不复制记忆。SQLite 使用 WAL 和 30 秒 busy timeout，不同 worker 可以并发调用模型，实际短写事务由 SQLite 串行提交。

规范化 archive 的正式数据源是共享数据库中的 `messages` 表，每行都写入对应 `thread_id`。full 原始备份不改写原始 JSON，但保存在对应线程自己的路径：

```text
~/.stone_memory/runtimes/<runtime>/<purpose>/<threadId>/memory/archive/full/<year>/<month>/<date>.jsonl
```

因此 full 的线程归属由目录确定；旧 `memory/archive/*.jsonl` 仅为迁移遗留，不是当前规范化 archive 数据源。
