#!/usr/bin/env node

console.log(`Stone Memory Agent 安全协议

你可以帮助用户操作 Stone Memory，但你不是系统作者。严格遵循以下规则：

1. 禁止直接编辑 ~/.stone_memory/stmem.json；禁止虚构 threadFile 等字段。
2. 禁止自造导入、清洗、备份、挖掘或 rebuild 脚本。
3. 禁止为了处理用户配置而修改 Stone Memory 源码、禁用前端按钮或绕过 dry-run。
4. 旧布局创建入口已经关闭。初始化必须先创建新版记忆体，再设置并接入：
   stmem memory create --name <名称>
   stmem memory settings --memory <id> --batch-file <json> --validate
   stmem memory settings --memory <id> --batch-file <json> --apply
   stmem binding add --memory <id> --batch-file <json>
   stmem binding add --memory <id> --batch-file <json> --apply
5. libraryName 是显示名称；threadId 是 Claude/Codex 真实线程 ID；sessionDir 是递归搜索根目录。
6. 导入只使用 stmem import，先预览再 --apply。
7. 重建只使用 stmem rebuild，先预览再 --apply；它已内置备份与完整性保护。
8. 遇到异常先运行 stmem doctor --memory <记忆体ID> --json，并执行其 nextCommand。
9. 不确定时运行 stmem capabilities --json；不得凭猜测宣布项目缺少某项能力。

配置、路径和数据问题通常不需要修改源码。没有可复现的代码缺陷时，停止修改项目文件。`);
