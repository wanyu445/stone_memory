# Stone Memory（磐石记忆）

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Stone Memory 磐石记忆：不必重新认识。本地优先、可解释的 AI 记忆，经历在线程里不断延续。原文、摘要与特征组成可追溯的记忆层。">
</p>

<p align="center">
  <strong>本地优先的 AI 记忆与线程生命周期管理系统</strong><br>
  Claude Code / Codex
</p>

<p align="center">
  <a href="./package.json"><img src="./assets/readme/badges/version.svg" alt="Version: 1.2.0" height="20"></a>
  <a href="#安装"><img src="./assets/readme/badges/node.svg" alt="Node.js: 22+" height="20"></a>
  <a href="#当前架构"><img src="./assets/readme/badges/storage.svg" alt="Storage: SQLite" height="20"></a>
  <a href="./LICENSE"><img src="./assets/readme/badges/license.svg" alt="License: AGPL-3.0-only" height="20"></a>
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#cli-工作流">CLI 工作流</a> ·
  <a href="#mcp-server">MCP 接入</a> ·
  <a href="./sm-developer-docs/README.md">开发者文档</a>
</p>

> **新线程可以开始，但过去不应该归零。**
>
> 蒲苇韧如丝，磐石无转移。

Stone Memory 从 Claude Code、Codex 等聊天线程中归档纯对话，提炼事件摘要（feelings）与长期特征（features），再把规则、记忆、原文锚点和近期上下文重建回线程。

**记住了什么、为什么保留、来自哪段原文、下次会注入什么，都可以查看。** 系统不依赖 embedding 黑箱召回，而是通过关系阶段、项目证据、主副核心与 importance 管理记忆的保留与精简。

## 记忆如何延续

**对话归档 → 记忆挖掘 → 精简保留 → 线程重建**

- 🗂️ **归档与连接**：Claude Code / Codex 双运行时；通过 Binding 归档、导入、检查和重建线程，兼容现有 fork 动态记忆继承。
- 🌱 **摘要与特征**：API / Subagent 双通道挖掘与压缩；管理 feelings、features、原文锚点、事件锚点和规则文档。
- 🔎 **搜索与证据**：memory_search 轻量搜索返回摘要对应原文；deepsearch 交叉验证摘要与原文，生成 AI 第一人称深度报告。
- 🕰️ **生命周期**：结合 relation 关系阶段、work 项目证据与多词共同签名时间轴，决定旧摘要如何精简或保留。
- 🧵 **线程重建**：把人设与规则、可见摘要、锚点原文、近期上下文和保留的工具调用组合回目标线程。
- 🏡 **本地管理**：全局 SQLite、多记忆体、本地 Web 工作台，以及 supervisor + 每线程 worker 自动维护。

> [!NOTE]
> 周级 `daily → coarse` 精简与长期 `coarse → hidden` 仍在测试阶段。`hidden` 只停止 rebuild 注入，不删除完整 feeling；原文锚点与事件锚点会保护对应内容。

## 安装

**环境要求：Node.js 22 或更高版本。** 在本地仓库目录安装依赖：

```bash
node --version
cd /path/to/stone_memory
npm ci --omit=dev
```

<details>
<summary><strong>Linux / macOS</strong> · 配置命令行入口</summary>

### Linux / macOS

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/stmem" ~/.local/bin/stmem
stmem --help
```

如果 `~/.local/bin` 不在 `PATH`，将 `export PATH="$HOME/.local/bin:$PATH"` 加入 shell 配置。

</details>

<details>
<summary><strong>Windows</strong> · 配置命令行入口</summary>

### Windows

安装 Node.js 22+ 后，可将项目的 `bin` 目录加入 `PATH`，或在项目目录运行：

```cmd
npm ci --omit=dev
npm link
stmem --help
```

</details>

Subagent 模式还要求对应的 `codex` 或 `claude` CLI 可从 `PATH` 调用；API 模式不需要运行时 CLI。

## 快速开始

### Web 工作台

如果升级后提示有待领取的 Web API Token，先领取并立即保存；Token 只显示一次：

```bash
stmem web auth claim
stmem web dev
```

默认地址为 `http://127.0.0.1:4173`。在首页创建空记忆体，然后分别完成基本设置、API/挖掘方式、Binding、导入和 watcher 配置。创建动作会先生成稳定 `memoryId`。

`claim` 只领取升级迁移时已经生成的 Token。如果提示没有待领取 Token，但你需要为 Web API 创建或更换访问令牌，请执行：

```bash
stmem web auth rotate
```

随后使用输出的 Token 登录 Web；不要把它放进仓库、命令行参数、日志或截图。

```bash
stmem web status
stmem web dev                    # 后端源码变化时自动重启
```

<details>
<summary><strong>使用 CLI 创建和绑定记忆体</strong></summary>

### CLI 创建和绑定

正式写法统一使用 `--memory <memoryId>`。`--thread` 只为旧脚本保留，其值在兼容期解释为记忆体 ID，不是外部 Claude/Codex 线程 ID。

```bash
# 1. 创建空记忆体；输出中包含 memoryId
stmem memory create --name "我的记忆体"

# 2. 读取、校验和应用设置
stmem memory settings --memory <memoryId>
stmem memory settings --memory <memoryId> --batch-file settings.json --validate
stmem memory settings --memory <memoryId> --batch-file settings.json --apply

# 3. 添加 Binding；默认预览，确认后应用
stmem binding add --memory <memoryId> --batch-file binding.json
stmem binding add --memory <memoryId> --batch-file binding.json --apply

# 4. 只读诊断
stmem doctor --memory <memoryId> --json
```

用 `stmem memory --help` 和 `stmem binding --help` 查看当前参数。自动化或外部 Agent 在操作前还应运行：

```bash
stmem ai-help
stmem capabilities --json
```

旧版一次性 `stmem init --thread` 创建入口已经关闭。新记忆体必须使用 `memory create/settings` 与 `binding add`，不再把线程 ID 当作记忆体身份；`stmem init --memory` 仅保留为显式指定新版记忆体的兼容接入方式。

</details>

<details>
<summary><strong>配置 API profile</strong></summary>

### API profile

API profile 是全局凭据，由记忆体设置引用。凭据从 JSON 文件读取，不出现在进程参数中：

```bash
stmem api-profile set --batch-file api-profile.json --validate
stmem api-profile set --batch-file api-profile.json --apply
```

字段为 `id`、`key`、`model`，非 DeepSeek profile 还需 `baseUrl`。

</details>

## 当前架构

Stone Memory 以稳定的 `memoryId` 标识一套记忆。Claude/Codex 的线程 ID、会话目录和线程文件属于 Binding，可以在不移动 SQLite 记忆和开发者模块数据的情况下更换。

```text
memoryId
├── memory.json          名称、用途、人物、挖掘和重建设置
├── bindings.json        Claude/Codex 窗口连接；其中一个可为 primary
├── watcher.json         自动归档、挖掘、压缩等期望状态
├── memory/              原文 archive、导入记录和锚点配置
├── rules/               rebuild 时注入的人格与操作规则
└── logs/                该记忆体的运行日志

stone-memory.db          所有记忆体共享的正式记忆数据库
developer-module-data/   按 memoryId 隔离的开发者模块数据
```

正式状态变更统一经过 `stmem` CLI。Web 和 MCP 是参数适配与交互层，不各自维护另一套写入逻辑。SQLite 是 messages、feelings、features 和挖掘状态的正式数据源；JSON/JSONL 只承担配置、原文 archive、导入或导出等职责。

<details>
<summary><strong>展开项目目录与用户数据布局</strong></summary>

### 项目目录

```text
stone_memory/
├── bin/                       Linux/macOS 与 Windows CLI 入口
├── scripts/                   各 stmem 子命令和进程入口
├── src/
│   ├── lib/                   JSONL、锁、CLI 参数等通用能力
│   ├── mcp/                   MCP registry、core tools 与 server
│   ├── scenarios/             挖掘场景及其提示词
│   ├── security/              本地 Web 认证与安全能力
│   ├── services/              归档、挖掘、Binding、rebuild、watcher
│   ├── storage/               SQLite schema、store 与 reader
│   ├── tools/                 MCP 工具实现
│   └── web/
│       ├── routes/            本地 HTTP 路由
│       └── public/            原生 HTML/CSS/JS 前端
├── developer-adapters/        外部开发适配契约
├── developer-modules/         可审计的内置/开发者模块
├── operations/                Miner、Compressor、Subagent 指令模板
├── test/                      Node.js 测试
├── mcp-server.js              MCP stdio 入口
└── package.json
```

### 用户数据目录

新建记忆体使用以下布局：

```text
~/.stone_memory/
├── stmem.json                       全局注册表、API profiles、Web 配置
├── stone-memory.db                  全局 SQLite 正式数据源
├── watcher.pid                      唯一 supervisor 的 PID
├── web.pid / web.log                后台 Web 进程状态与日志
├── memories/
│   └── <memoryId>/
│       ├── .layout-v1.json          新布局完成凭据
│       ├── memory.json
│       ├── bindings.json
│       ├── watcher.json
│       ├── watcher-state.json       worker 实际运行状态
│       ├── .watcher.lock/           该记忆体唯一 worker 锁
│       ├── logs/
│       ├── rules/
│       │   ├── instructions.md
│       │   └── operations.md
│       └── memory/
│           ├── archive/full/YYYY/MM/YYYY-MM-DD.jsonl
│           ├── import/done/
│           ├── retain-config.json
│           └── audit-marks.json
├── developer-module-data/<memoryId>/<moduleId>/
└── backups/
```

旧安装仍可从 `runtimes/<runtime>/<purpose>/<旧ID>/` 读取。程序会根据布局凭据只选择一个可写根目录；不要手工拼接、复制或同时写入两套目录，也不要直接编辑 `stmem.json` 来“迁移”。

`stmem.json` 中的 API Key 属于敏感信息。不要提交 `~/.stone_memory`，也不要把 Key 放进命令行、日志、记忆体目录或 issue。

</details>

## CLI 工作流

以下 `<id>` 均指 `memoryId`。按任务展开命令；每项保留对应的预览、应用与操作说明。

<details>
<summary>🩺 <strong>状态与诊断</strong></summary>

### 状态与诊断

```bash
stmem status
stmem list
stmem doctor --memory <id> --json
stmem db status --memory <id>
```

</details>

<details>
<summary>🗂️ <strong>导入、同步和 Binding</strong></summary>

### 导入、同步和 Binding

导入默认只预览，加 `--apply` 才写入：

```bash
stmem import --source conversation.json --memory <id>
stmem import --source conversation.json --memory <id> --apply
stmem import --dir /path/to/exports --memory <id>
stmem sync --memory <id>

stmem binding list --memory <id>
stmem binding import --memory <id> --binding <bindingId>
stmem binding import --memory <id> --binding <bindingId> --apply
stmem binding batches --memory <id> --binding <bindingId>
stmem binding revert --memory <id> --batch <batchId>
stmem binding revert --memory <id> --batch <batchId> --apply
```

切换主 Binding 使用 `stmem binding switch`。它会先验证目标窗口、备份并生成确认计划；实际切换必须复用该计划返回的 token，不要跳过预览。

</details>

<details>
<summary>🌱 <strong>挖掘与审阅</strong></summary>

### 挖掘与审阅

```bash
stmem mine --memory <id> --date 2026-09-28
stmem mine --memory <id> --all
stmem mine --memory <id> --date 2026-09-28 --check --json

stmem scenario list
stmem scenario inspect life-supervision
stmem scenario set --memory <id> --scenario life-supervision --apply
stmem prompt show --memory <id>
```

`mine` 先生成 feelings，再从本轮 feelings 生成 features。可审阅模式使用 `stmem mine-review preview|list|mix|apply|discard`；`--check` 只展示实际 prompt、输入、上游响应和解析结果。

</details>

<details>
<summary>🕰️ <strong>压缩、隐藏与证据</strong></summary>

### 压缩、隐藏与证据

```bash
stmem compress --memory <id> --before 2026-09-01
stmem compact --memory <id>
stmem compact --memory <id> --apply
stmem hidden --memory <id>
stmem hidden --memory <id> --apply

stmem feature-phrases --memory <id>
stmem feature-evidence --memory <id>
stmem lifecycle --memory <id>
stmem term-timeline --memory <id> --terms "论文,答辩"
```

压缩和隐藏均先给出计划。`daily → coarse` 保存精简摘要；`hidden` 只停止 rebuild 注入，不删除完整 feeling。原文锚点 `retain` 和事件锚点 `event` 会保护对应内容。

</details>

<details>
<summary>📝 <strong>规则与记忆编辑</strong></summary>

### 规则与记忆编辑

```bash
stmem rules list --memory <id>
stmem rules import --memory <id> --batch-file rules.json
stmem rules update --memory <id> --batch-file rules.json
stmem memory update --memory <id> --batch-file feeling.json
stmem memory anchor --memory <id> --batch-file anchors.json
```

规则在 rebuild 时注入目标线程。不要绕过 CLI 直接修改 SQLite，也不要让 Web route 直接写正式数据。

</details>

<details>
<summary>🧵 <strong>线程检查与重建</strong></summary>

### 线程检查与重建

```bash
stmem rebuild --memory <id>             # dry-run
stmem rebuild --memory <id> --check     # 只读完整性检查
stmem rebuild --memory <id> --repair    # 备份并修复可恢复断链
stmem rebuild --memory <id> --apply     # 可立即应用的运行时
stmem rebuild --memory <id> --queue     # Claude Code 安全排队
```

重建会组合规则、可见 feelings、锚点原文、近期窗口和保留的工具调用。执行前先检查 dry-run；不要对宿主正在写入的 JSONL 另写替换脚本。

</details>

<details>
<summary>👀 <strong>Watcher</strong></summary>

### Watcher

```bash
stmem supervisor start
stmem supervisor status

stmem watcher status --memory <id>
stmem watcher on --memory <id>
stmem watcher off --memory <id>
stmem watcher set --memory <id> --archive on
stmem watcher set --memory <id> --miner on
stmem watcher set --memory <id> --compression off
stmem watcher set --memory <id> --dream off
```

系统只有一个 supervisor；它按 `watcher.json` 为各记忆体维护至多一个 worker。`watcher on/off/set` 只修改期望状态，不直接另起进程。Windows 可用 `stmem watcher service install|status|repair|remove` 管理 Task Scheduler 服务。

</details>

<details>
<summary>🧩 <strong>开发者模块</strong></summary>

### 开发者模块

```bash
stmem module list
stmem module inspect <moduleId>
stmem module paths <moduleId> --memory <id>
stmem module audit --strict
stmem module mcp status
```

模块源码位于 `developer-modules/`，持久数据位于 `~/.stone_memory/developer-module-data/<memoryId>/<moduleId>/`。模块命令由 manifest 登记并经 `stmem module` 执行，不要把运行数据写回源码目录。

</details>

## 局域网与手机连接

默认 Web 只监听 `127.0.0.1`。需要从手机访问时：

```bash
stmem web lan enable
stmem web lan status
stmem web login                       # 5 分钟、单次使用的配对二维码
stmem web auth devices
stmem web auth revoke --device <id>
stmem web lan disable
```

局域网模式强制认证。二维码只含短期配对邀请，不包含长期 API Token；设备会话可以单独撤销。局域网 HTTP 只适合可信网络，不等同于公网 HTTPS。

Windows 或 WSL2 mirrored 模式如被防火墙拦截，可在管理员终端运行：

```bash
stmem web lan firewall status
stmem web lan firewall install
stmem web lan firewall remove
```

规则只开放当前 Web TCP 端口、Private/LocalSubnet 范围。

## MCP Server

MCP 入口是仓库根目录的 `mcp-server.js`，使用 stdio JSON-RPC：

```json
{
  "mcpServers": {
    "stmem": {
      "command": "node",
      "args": ["/absolute/path/to/stone_memory/mcp-server.js"]
    }
  }
}
```

核心工具提供状态、搜索、证据、挖掘和 rebuild；启用的开发者模块可注册额外工具。MCP 根据宿主 session Binding 解析 `memoryId`，多记忆体且无法唯一判断来源时会拒绝默认选择。

MCP rebuild 分为 preview 和确认执行：执行端复用同一 MCP 会话内最近一次成功预览的参数。Codex 可立即应用并随后重启 app-server；Claude Code 使用安全队列，在下次主 MCP 启动阶段消费。

## 场景与指令

内置场景位于 `src/scenarios/`：

- `life-supervision`：生活监督，主要新建场景
- `accompany`：情感陪伴
- `coding`：编程与项目日志
- `study`：旧学习场景，兼容已有记忆体

`operations/` 保存正式 Miner、Compressor 和 Subagent 指令。单个记忆体的定制应通过 `stmem scenario` / `stmem prompt` 管理。

## 开发与验证

```bash
npm install
npm test
npm run dev
npm run audit:developer-modules
```

测试使用 Node 内置 test runner。修改 watcher、Binding、rebuild、数据路径或 Web 写接口时，应先运行相关测试，再运行完整 `npm test`。参与开发前请先阅读[开发约束](./sm-developer-docs/AGENTS.md)、[架构说明](./sm-developer-docs/architecture.md)与[贡献指南](./sm-developer-docs/contributing.md)。

[开发者文档](./sm-developer-docs/README.md) · [模块接入规范](./developer-modules/DEVELOPMENT.md) · [问题反馈](https://github.com/wanyu445/stone_memory/issues)

## 许可证

[GNU Affero General Public License v3.0](LICENSE)
