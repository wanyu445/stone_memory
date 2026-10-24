# Stone Memory（磐石记忆）

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Stone Memory 磐石记忆">
</p>

<p align="center">
  <strong>本地优先的 Agent 记忆管理与线程重建系统</strong><br>
  支持 Claude Code / Codex
</p>

<p align="center">
  <a href="./package.json"><img src="./assets/readme/badges/version.svg" alt="Version" height="20"></a>
  <a href="#安装"><img src="./assets/readme/badges/node.svg" alt="Node.js 22+" height="20"></a>
  <a href="#系统架构"><img src="./assets/readme/badges/storage.svg" alt="SQLite" height="20"></a>
  <a href="./LICENSE"><img src="./assets/readme/badges/license.svg" alt="AGPL-3.0-only" height="20"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#线程重建">线程重建</a> ·
  <a href="#cli-参考">CLI</a> ·
  <a href="#mcp-接入">MCP</a> ·
  <a href="./sm-developer-docs/README.md">开发者文档</a>
</p>

**Stone Memory 是一个本地优先的 Agent 连续性底座。** 它面向长期使用的 Claude Code / Codex 线程，将对话归档、长期记忆、原文证据与上下文重建组织为可管理的工作流。

与仅在需要时检索历史事实的方案不同，Stone Memory 将**线程重建（Rebuild）**作为核心能力：在线程需要更换时，依据规则、长期摘要、证据锚点、近期对话和必要的工具调用记录，重新组织下一线程的工作上下文。

项目包含两个互补的部分：

- **记忆与线程重建**：保存可追溯的长期历史，管理记忆生命周期，并将相关历史重新带入工作上下文。
- **琢石坊**：以开发者模块承载笔记、收藏、游戏、生活档案、项目资料等结构化数据和工具，避免将所有长期状态塞进自然语言记忆。

> **让过去继续构成现在，也让长期生活有地方生长。**

## 核心能力

| 能力 | 说明 |
| --- | --- |
| **线程重建** | 组合规则、可见摘要、原文锚点、近期对话和必要的工具调用历史；提供预览、检查、修复和受控执行入口。 |
| **对话归档与记忆挖掘** | 连接 Claude Code / Codex 线程，支持 API / Subagent 双通道摘要生成、审阅和提示词管理。 |
| **证据检索** | `memory_search` 返回与摘要关联的原文；`deepsearch` 结合摘要和原文开展进一步分析。 |
| **记忆生命周期** | 根据关系阶段、项目证据与时间线管理长期摘要的精简与注入可见性。 |
| **多记忆体** | 以稳定的 `memoryId` 隔离记忆体；通过 Binding 连接具体运行时线程。 |
| **本地运行与管理** | SQLite 持久化、统一 CLI、本地 Web 工作台、MCP 接口以及 supervisor / worker 后台维护。 |
| **模块化扩展** | 琢石坊开发者模块独立管理结构化数据与工具，数据按记忆体隔离。 |

> [!NOTE]
> 周级 `daily → coarse` 精简和长期 `coarse → hidden` 仍在测试阶段。`hidden` 仅停止对应内容在 Rebuild 中的常规注入，不等于删除完整记录。

## 系统架构

```text
                Claude Code / Codex
                         │
                         ▼
                  Runtime Binding
                         │
                         ▼
                    对话归档
                         │
                         ▼
                记忆挖掘与审阅
                         │
                         ▼
                 SQLite 记忆存储
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
        生命周期管理          检索 / 原文证据
              │                     │
              └──────────┬──────────┘
                         ▼
             Rebuild：上下文选择与组装
                         ▲
                 规则 / 近期对话 /
                   保留的工具调用
                         │
                         ▼
                  新的运行时线程

   Web 工作台 ─┐
   MCP Server ─┼──> stmem CLI ──> 正式状态变更
   CLI 用户  ──┘

   琢石坊开发者模块 ──> 独立的结构化模块数据
```

### 数据与身份边界

- **`memoryId` 是长期记忆体身份**。Claude Code / Codex 的线程 ID、会话文件及目录属于 Binding，可独立于记忆体数据更换。
- **SQLite 是正式记忆数据源**，存储 messages、feelings、features 和挖掘状态；JSON / JSONL 用于配置、原文归档、导入和导出等。
- **正式状态变更统一通过 `stmem` CLI**。Web 和 MCP 提供交互及参数适配，不各自维护另一套正式写入逻辑。
- **琢石坊模块数据与自然语言记忆分离**，并按 `memoryId` 隔离持久化数据。

详细目录和开发约束见[架构文档](./sm-developer-docs/architecture.md)与[开发者文档](./sm-developer-docs/README.md)。

## 安装

**环境要求：Node.js 22 或更高版本。**

```bash
git clone https://github.com/wanyu445/stone_memory.git
cd stone_memory
node --version
npm ci --omit=dev
```

### Linux / macOS

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/stmem" ~/.local/bin/stmem
stmem --help
```

如果 `~/.local/bin` 不在 `PATH` 中，请将 `export PATH="$HOME/.local/bin:$PATH"` 加入 shell 配置并重新加载。

### Windows

在项目目录执行：

```cmd
npm ci --omit=dev
npm link
stmem --help
```

> API 挖掘模式不要求宿主 CLI；Subagent 模式还要求对应的 `codex` 或 `claude` CLI 可从 `PATH` 调用。

## 快速开始

### 1. 启动 Web 工作台

```bash
stmem web dev
```

默认本地地址：`http://127.0.0.1:4173`。

如果是升级安装且提示有待领取的 Web API Token，执行：

```bash
stmem web auth claim
```

`claim` 仅用于领取迁移时已生成的 Token。如果没有待领取 Token，但需要创建或更换访问令牌：

```bash
stmem web auth rotate
```

Token 应妥善保存，不要提交到仓库、粘贴到 Issue 或包含在截图中。

### 2. 创建记忆体并连接线程

在 Web 工作台创建记忆体，设置使用场景与挖掘方式，再配置 Claude Code / Codex 的 Binding。创建后会得到稳定的 `memoryId`。

你也可以使用 CLI 创建：

```bash
stmem memory create --name "我的记忆体"
stmem memory settings --memory <memoryId>
stmem binding list --memory <memoryId>
stmem doctor --memory <memoryId> --json
```

配置变更支持先校验、再应用：

```bash
stmem memory settings --memory <memoryId> --batch-file settings.json --validate
stmem memory settings --memory <memoryId> --batch-file settings.json --apply

stmem binding add --memory <memoryId> --batch-file binding.json
stmem binding add --memory <memoryId> --batch-file binding.json --apply
```

`settings.json` 和 `binding.json` 需要按照当前命令接口填写。先通过 `stmem memory --help`、`stmem binding --help` 或 Web 工作台确认字段；不要直接复制占位文件名执行。

### 3. 检查运行状态

```bash
stmem status
stmem list
stmem doctor --memory <memoryId> --json
```

如需后台自动归档与维护：

```bash
stmem supervisor start
stmem supervisor status
stmem watcher status --memory <memoryId>
stmem watcher on --memory <memoryId>
```

> `watcher on/off/set` 修改期望状态，由 supervisor 管理对应 worker；不直接创建额外独立进程。

## 线程重建

线程重建是 Stone Memory 的核心工作流。它不把完整历史逐字复制到新线程，也不只注入一份固定的人格设定，而是从不同层级选择能够支持后续推理和任务延续的材料。

典型重建输入包括：

1. 人格、操作规则和长期约束；
2. 当前可见的长期摘要（feelings）；
3. 需要保护的原文与事件锚点；
4. 最近的真实对话；
5. 需要保留的工具调用与行动历史。

重建内容的规模取决于模型、上下文预算、使用场景和用户配置，并不存在适用于所有 Agent 的固定 Token 长度。

### 预览、检查与执行

```bash
stmem rebuild --memory <memoryId>          # dry-run，预览重建
stmem rebuild --memory <memoryId> --check  # 只读完整性检查
stmem rebuild --memory <memoryId> --repair # 备份并修复可恢复断链
stmem rebuild --memory <memoryId> --apply  # 可立即应用的运行时
stmem rebuild --memory <memoryId> --queue  # Claude Code 安全排队
```

**建议先检查 dry-run 输出，再决定是否执行。** 不要直接修改宿主正在写入的线程 JSONL，也不要绕过内置检查自行替换线程内容。

### 能力边界

Rebuild 旨在提高线程切换时的历史连续性，**不保证新旧线程内部状态完全等价**，也不能保证模型必然使用每一条历史证据。实际效果受摘要质量、原文完整性、宿主格式、模型能力和上下文预算影响。

## 记忆管理与检索

### 归档与同步

```bash
stmem import --source conversation.json --memory <memoryId>
stmem import --source conversation.json --memory <memoryId> --apply
stmem sync --memory <memoryId>

stmem binding list --memory <memoryId>
stmem binding import --memory <memoryId> --binding <bindingId>
stmem binding import --memory <memoryId> --binding <bindingId> --apply
```

导入命令默认先预览，明确使用 `--apply` 后才执行写入。

### 挖掘与审阅

```bash
stmem mine --memory <memoryId> --all
stmem mine --memory <memoryId> --date 2026-09-28 --check --json

stmem scenario list
stmem scenario inspect life-supervision
stmem prompt show --memory <memoryId>
```

挖掘过程先生成 feelings，再由本轮 feelings 生成 features。审阅工作流提供 `stmem mine-review preview|list|mix|apply|discard`。

### 生命周期与证据

```bash
stmem compress --memory <memoryId> --before 2026-09-01
stmem compact --memory <memoryId>
stmem compact --memory <memoryId> --apply
stmem hidden --memory <memoryId>
stmem hidden --memory <memoryId> --apply

stmem feature-phrases --memory <memoryId>
stmem feature-evidence --memory <memoryId>
stmem lifecycle --memory <memoryId>
stmem term-timeline --memory <memoryId> --terms "论文,答辩"
```

`daily → coarse` 用于精简摘要；`hidden` 控制 Rebuild 注入可见性，而不是删除完整 feeling。原文锚点和事件锚点可以保护对应内容。

## CLI 参考

以下命令以 `<memoryId>` 代表记忆体身份，而非 Claude Code / Codex 线程 ID。

| 操作 | 命令 |
| --- | --- |
| 系统状态 | `stmem status` |
| 记忆体列表 | `stmem list` |
| 诊断 | `stmem doctor --memory <memoryId> --json` |
| 数据库状态 | `stmem db status --memory <memoryId>` |
| 记忆体设置 | `stmem memory settings --memory <memoryId>` |
| Binding 列表 | `stmem binding list --memory <memoryId>` |
| Rebuild 预览 | `stmem rebuild --memory <memoryId>` |
| Supervisor 状态 | `stmem supervisor status` |
| Watcher 状态 | `stmem watcher status --memory <memoryId>` |
| 模块列表 | `stmem module list` |
| 模块审计 | `stmem module audit --strict` |
| Agent 可用能力 | `stmem capabilities --json` |
| Agent 使用说明 | `stmem ai-help` |

旧版 `--thread` 仅作为兼容参数保留，其值在兼容期解释为记忆体 ID；新工作流应使用 `--memory`。旧版 `stmem init --thread` 创建入口已经关闭。

## MCP 接入

仓库根目录的 `mcp-server.js` 提供 stdio JSON-RPC MCP Server。

示例配置：

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

MCP 提供状态、搜索、证据、挖掘及 Rebuild 等工具，启用的开发者模块也可注册额外工具。

MCP 根据宿主 session Binding 解析 `memoryId`；如果存在多个记忆体且无法唯一确定来源，不会擅自选择默认记忆体。

Rebuild 采用预览与确认执行流程。Codex 可以在适用条件下立即应用；Claude Code 使用安全队列，在后续主 MCP 启动阶段消费。

## Web、局域网与手机连接

Web 默认仅监听 `127.0.0.1`。需要从手机访问时：

```bash
stmem web lan enable
stmem web lan status
stmem web login
stmem web auth devices
stmem web auth revoke --device <deviceId>
stmem web lan disable
```

`stmem web login` 生成短期、单次使用的配对二维码（默认有效期 5 分钟）。二维码不直接包含长期 API Token；已配对设备的会话可单独撤销。

**安全提示：** 局域网 HTTP 适用于可信网络，不等同于公网 HTTPS。不要未经认证或加密就将 Web 服务直接暴露到互联网。

Windows 或 WSL2 mirrored 模式如遇防火墙限制，可在管理员终端检查相关规则：

```bash
stmem web lan firewall status
stmem web lan firewall install
stmem web lan firewall remove
```

## 琢石坊与开发者模块

长期 Agent 除了需要自然语言记忆，还会产生笔记、收藏、游戏进度、生活档案和项目资料等结构化数据。

琢石坊将这些能力放在独立模块中，而不是把所有状态塞入摘要或重建上下文。

```bash
stmem module list
stmem module inspect <moduleId>
stmem module paths <moduleId> --memory <memoryId>
stmem module audit --strict
stmem module mcp status
```

模块源码位于 `developer-modules/`，持久数据按记忆体隔离在：

```text
~/.stone_memory/developer-module-data/<memoryId>/<moduleId>/
```

模块命令通过 manifest 登记，由 `stmem module` 执行。不要把运行时数据写回模块源码目录。

参见[开发者模块规范](./developer-modules/DEVELOPMENT.md)。

## 运行场景

内置场景位于 `src/scenarios/`：

| 场景 | 标识 | 主要用途 |
| --- | --- | --- |
| 生活监督 | `life-supervision` | 习惯、日常活动与长期监督 |
| 情感陪伴 | `accompany` | 长期对话与关系历史 |
| 编程日志 | `coding` | 项目开发与任务连续性 |
| 学习（兼容） | `study` | 旧学习场景兼容 |

不同场景可以采用不同的挖掘提示词与重建策略。单个记忆体的定制应通过 `stmem scenario` 和 `stmem prompt` 管理。

## 数据布局

```text
~/.stone_memory/
├── stmem.json                 # 全局注册表、API profiles、Web 配置
├── stone-memory.db            # SQLite 正式记忆数据源
├── watcher.pid                # Supervisor 进程标识
├── memories/
│   └── <memoryId>/
│       ├── memory.json        # 记忆体设置
│       ├── bindings.json      # 运行时线程绑定
│       ├── watcher.json       # 自动维护期望状态
│       ├── watcher-state.json # Worker 实际运行状态
│       ├── logs/
│       ├── rules/
│       │   ├── instructions.md
│       │   └── operations.md
│       └── memory/
│           ├── archive/full/
│           ├── import/done/
│           ├── retain-config.json
│           └── audit-marks.json
├── developer-module-data/
└── backups/
```

旧安装可能仍包含 `runtimes/<runtime>/<purpose>/<旧ID>/` 布局。迁移时不要手动复制两套可写数据目录，也不要直接编辑 `stmem.json` 或 SQLite 来绕过正式迁移流程。

**请保护 `~/.stone_memory` 中的凭据和对话数据。** 不要将其提交到 GitHub 或上传到公开 Issue。


## 设计理念与技术取舍

### 为什么不是只做一个历史事实检索器？

长期交互中，真正需要延续的不只是「发生过什么」，还包括事件之间的因果关系、判断变化、重要原文与近期任务状态。

人格设定与规则可以描述 Agent 应当如何行动，但未必能解释某种认识为何形成。Stone Memory 希望让模型有机会基于历史证据重新推理，而不是只能读取预先压缩好的结论。

> **规则告诉它应该怎样。过去帮助它理解，为什么会走到现在。**

### 为什么保留自然语言历史？

结构化状态适合保存确定的字段与操作结果；自然语言则适合保留关系、经历、动机和判断形成过程中的细节。

Stone Memory 同时使用 SQLite 和自然语言材料：数据库负责可靠地保存、组织和管理状态，模型负责在当前上下文中解释相关证据。

这并不意味着每条历史都必须永久注入。系统通过生命周期、锚点和重建配置，决定哪些内容直接进入工作上下文，哪些留待需要时检索。

### 为什么将琢石坊与记忆核心分离？

一杯饮料的评分、一局游戏的存档和一个项目的任务列表都有各自的结构，不适合全部转写为自然语言摘要。

因此 Stone Memory 保持记忆核心相对集中，把非自然语言的长期数据与工具能力交给开发者模块。核心负责连续性，模块负责各自的数据结构与业务逻辑。

> **新线程可以开始，但过去不应该归零。**
>
> 蒲苇韧如丝，磐石无转移。


## 开发与验证

```bash
npm install
npm test
npm run dev
npm run audit:developer-modules
```

测试使用 Node.js 内置 test runner。修改 watcher、Binding、Rebuild、存储路径或 Web 写接口时，应先运行相关测试，再运行完整测试集。

开发前建议阅读：

- [开发者文档](./sm-developer-docs/README.md)
- [架构说明](./sm-developer-docs/architecture.md)
- [开发约束](./sm-developer-docs/AGENTS.md)
- [贡献指南](./sm-developer-docs/contributing.md)
- [模块接入规范](./developer-modules/DEVELOPMENT.md)
- [问题反馈](https://github.com/wanyu445/stone_memory/issues)

[贡献者名单](./CONTRIBUTORS.md)

## 许可证

[GNU Affero General Public License v3.0](./LICENSE)
