# 味觉档案（taste-journal）

贡献人：@lykketutu

奶茶、甜品、外卖的口味小档案馆。聊天里随口一提，AI 通过统一 CLI 记一笔；页面负责月历打卡、集章复购、配置对比、口味画像和月度报告，回答"这个还值不值得再点"。

## 安装

把整个 taste-journal 目录放入：

developer-modules/taste-journal/

Stone Memory Web 会扫描 module.json 并自动在插件工坊注册入口。前端使用 /developer-kit/runtime.js、stone-module-page 外壳和主题变量，不需要修改主前端 app.js。

## 记录链路

- **AI 自动记录**：在模块页面「小店」里点"点亮 AI 记录"，通过 Stone 正式 rules API 向当前记忆体写入 `taste-journal.md` 规则（内容与 `prompts/default.md` 一致，两处需同步修改）。下次 rebuild 后，AI 在你提到吃喝时执行 `stmem module taste-journal add --memory <id> --batch-file <json>` 落盘，只回一句话确认。拿不准的内容 AI 只转发原话，模块存为待整理草稿。
- **手动记录**：页面右下角"记一笔"。同一品牌+品名自动归并到同一张档案卡（模糊相似会提示可合并）；不填配置时沿用上次的配置。
- 查重与归并都在模块命令内完成，AI 记录不需要先读旧数据。

## 数据模型

- 档案卡（产品）：品牌 + 品名唯一；品类、口味标签、回购判定（自动算或手动覆盖）。
- 尝试记录：日期、评分（档位可自定义，默认 特别喜欢/尝鲜一次/避雷，带正/中/负极性）、配置（糖度/冰量/小料等键值对）、短评、价格（可选）。
- 集章：每条记录一枚章，档位阈值可配（默认 1/3/5/8 → 点头之交/常客/老主顾/本命）；计数实时从记录计算，不存聚合值。
- 配置分歧：同一配置维度出现"有特别喜欢也有避雷"时，卡片展开对比行并给出点单口诀。
- 月度报告：统计层本地计算；叙事层由主 AI 通过 `stmem module taste-journal digest` 写回，可在报告卡里一键采纳它提议的新评分档或标签。

## 数据与同步

- 全部数据按 memoryId 隔离，保存在模块数据目录 `developer-module-data/<memory-id>/taste-journal/` 下：`journal.json`（档案卡+记录）、`settings.json`（评分档位、集章档位、花销开关）、`digests.json`（AI 整理）、`drafts.json`（待整理草稿）。读写通过 manifest 登记的 `list/add/update/stats/digest` 命令完成，前端不直接落盘。
- "点亮 AI 记录"与暂停、删除规则都通过 Stone 正式 rules API 完成，与 pregnancy-game 同款通道。
- 模块不写 messages、feelings、features，不调用模型，不保存 API Key。

## 拆除与回滚

删除 developer-modules/taste-journal/ 即可拆除页面。模块数据目录与 taste-journal.md 规则不会被自动删除；请先在「小店」里清空数据或手动删除 `~/.stone_memory/developer-module-data/<memory-id>/taste-journal/` 与该规则。删除后主前端不受影响。

## 1.1.0 · MCP 与 memoryId

以 2026-09-30 上游 main（aa0e26d）的 developer-modules/DEVELOPMENT.md 第 17 节及正式版 v1.2.0 实际宿主为基准。Provider 通过 SDK v2 注册五个工具：stmem_taste_journal_list、stats、add、update、digest。只读工具复用原 reader，写入通过 context.runCommand → 正式模块 CLI。没有新服务、新数据目录或数据迁移。

按记忆体授权，默认关闭。使用 `stmem module mcp enable --module taste-journal --memory <memoryId>` 预览，确认后加 `--apply`。停用使用同样的 disable 命令。重新连接 MCP 后生效；不需要增加第二个 MCP 服务。

当前 v1.2.0 运行代码按会话 Binding 绑定 context.memoryId，Provider 不接受 memoryId/threadId 输入。未绑定的会话不加载模块，不能自动选第一个记忆体。施工文档残留了旧版“客户端必传 memoryId”的说明；实际工具定义及测试遵从当前宿主。读取不会创建模块数据文件；写入正文使用宿主私有临时 batch 文件，不进入命令行。

MCP 的 options 为键值列表，以支持自定义配置名：`[{"key":"糖度","value":"微糖"}]`；CLI 和网页仍为原键值对象。删除、清空、合并或移除评分档必须先取得用户确认并传 confirm:true。其他校验、归并、评分和报告语义复用原正式命令。读写错误采用固定代码，不回传服务器路径。

前端现在读取宿主 memoryId，CLI 提示和自动记录规则改为 --memory，并优先使用 MCP。安装升级不自动覆盖已保存的用户规则，也不自动改变 MCP 权限；管理员安装时另行备份并启用获授权记忆体。旧规则模板可在小店重新点亮更新；自行修改过的规则应先比对。

回退到 1.0.0 模块包即可，数据格式不变。先通过正式 CLI 停用 taste-journal MCP，再回退代码；保留所有味觉数据与规则。

## 测试

MCP 测试：在已装入目标模块的 SM 测试宿主中，设置 STMEM_TEST_CORE 为该宿主绝对路径，再运行 `node --test developer-modules/taste-journal/test/mcp.test.cjs`。测试只创建隔离 HOME 和合成数据，覆盖真实 MCP 进程及 CLI，不使用线上数据。

```powershell
node --check frontend/domain.js
node --check frontend/app.js
node --check backend/commands/add.js
node --check backend/commands/list.js
node --check backend/commands/update.js
node --check backend/commands/stats.js
node --check backend/commands/digest.js
node --test test/module.test.cjs
```

`test/preview.html` 是本地预览台（内存版宿主 + 演示数据），用任意静态服务器指向模块目录后打开 `/test/preview.html` 即可离线查看页面。
