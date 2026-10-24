# Stone Memory 小助理

可拆卸的 Stone Memory 开发者模块，由 `@不知道昵称` 贡献。模块使用内置项目知识回答常见问题，并通过现有正式 Web API 协助检查和挖掘当前记忆体；需要读取维护配置的重建上下文由正式工作台完成。

## 入口

```text
/developer-modules/stone-memory-assistant/?threadId=<真实线程 ID>
```

模块只使用 `window.StoneDeveloperModule.threadId`，不会默认选择第一套记忆体。缺少或无法验证 `threadId` 时，所有管理动作保持禁用。

本 PR 只新增这个独立模块，不自动注册到主控制台入口。宿主服务静态托管模块目录后，可直接访问上面的 URL；返回入口、页面宽度和主题引导由 `/developer-kit/runtime.js` 与 `<stone-module-page>` 提供。

## 能力与边界

- 内置离线知识库：只回答产品用途、功能入口、操作影响和常见故障，不提供算法、提示词、数据库结构或源码架构说明。
- 首次导览：使用 8 个桌面端步骤介绍当前记忆体、待办、指定日期挖掘、一键维护、人工任务和工作日志；完成后可以随时重新查看。
- 只读待办：当前挖掘任务、昨天及更早的待挖掘日期、重建建议和概览注意事项。
- 确认后写入：用户明确选择 Subagent 或 API 通道后，通过正式接口启动挖掘；停止操作也需要确认。
- 一键维护：只处理昨天及更早、状态为待挖掘的日期；失败、部分失败和 blocked 日期不会自动重试。挖掘完成后引导用户到正式工作台预览和确认重建。
- 工作日志：最多合并展示 30 条系统状态和本次小助理操作，按日期分组并可展开；不记录消息正文、密钥、私人路径或完整错误堆栈，刷新页面后本次操作记录清空。
- 人工任务：为原文裁剪、对话导入、精准补挖和摘要管理说明真实操作路径，并返回同一个记忆体工作台；当前不会伪装成已打开内部子页面。
- 当前只复用正式的 overview、mining status、feelings、mining start 和 mining stop 链路；不会新增服务端路由或第二套写入链。

模块不会调用会返回密钥和本机路径的 settings 接口，也不会直接修改 SQLite、`stmem.json` 或线程文件，不会保存 API Key，不会在浏览器中建立第二套后台自动化。导入、重建、压缩、hidden、规则、watcher 设置、fork、删除和数据库维护只提供说明与引导。

模块不在浏览器中持久化导览进度、对话内容、昵称或业务状态。

记忆搜索继续使用主控制台的“记忆档案 → 全量对话”；本模块不重复提供搜索入口或时间轴查询。

本版本不提供通用 AI 对话、模型直连或自然语言意图识别。输入先匹配确定性命令，再使用离线产品知识库；未命中或涉及内部算法、提示词、数据库结构和源码实现时，返回固定的礼貌边界说明。未来如需接入 AI，应先由项目方提供安全的正式服务端接口。

## 手机浏览器

近期 Android Chrome 和 iPhone Safari 使用近全屏小助理面板。空闲状态下第一次点击右下角形象只播放互动并提示再次点击，4 秒内第二次点击才打开面板；挖掘运行、等待确认或失败时单击直接打开，方便及时查看任务状态。

面板打开后会暂时隐藏形象、锁定背景滚动，并根据 `visualViewport` 适配动态地址栏、软键盘和安全区。手机端不会在打开面板时自动弹出键盘；对话、工作日志和项目导览各自在面板内滚动。首次访问不会自动打开面板，导览可从主页面或面板内主动查看。第一次点击会轮换使用桌面端已有的可爱气泡，并附带再次点击提示。竖屏是主要体验，手机横屏保持面板、关闭按钮和输入区可访问；平板继续使用桌面布局。

## 抹茶布丁动画资源

`assets/mochabuding/NOTICE.md` 记录素材提供者、分发授权、格式和图集规格。运行时保留 `pet.json` 和透明 `spritesheet.webp`；图集为 1536 × 1872 px、8 列 × 9 行、单元格 192 × 208 px，九行依次对应 `idle`、左右奔跑、招手、跳跃、失败、等待、执行和检查状态。原始帧、生成过程和 QA 素材不纳入模块。

## 验证与拆除

```text
node --check src/web/public/developer-modules/stone-memory-assistant/app.js
node --check src/web/public/developer-modules/stone-memory-assistant/logic.js
node --check src/web/public/developer-modules/stone-memory-assistant/knowledge.js
node src/web/public/developer-modules/stone-memory-assistant/logic.test.js
node src/web/public/developer-modules/stone-memory-assistant/module.test.js
npm test
git diff --check
```

本模块不改变配置、SQLite、archive/full、活动线程或长期业务状态；刷新页面后本次小助理操作日志会清空。删除整个 `developer-modules/stone-memory-assistant/` 目录即可回滚，不会遗留数据库字段、配置或核心前端状态。提交 PR 时应附脱敏的桌面端、移动端和确认卡/工作日志截图，不能包含真实 threadId、对话、密钥、路径或服务器地址。
