# 你画我猜

Stone Memory 的可拆卸开发者模块。人类与绑定到同一记忆体的 AI 可以在房间中轮流画图、猜词和聊天。

猜题方可以在一轮结束前多次明确提交答案；猜错后，猜题与聊天仍可并行。聊天不会自动当作答案。人类和 AI 都可以选择放弃并揭晓本轮答案。

## 数据边界

- 活跃房间状态、词库和图库索引按记忆体隔离，位于模块自己的 `module.sqlite`。
- 完成画作位于模块数据目录的 `gallery/`，可以下载。
- 画笔轨迹只用于当前回合，完成图片生成后清除。
- 游戏结束后清除模块中的聊天与猜测事件；有意义的互动由绑定的 Agent 主线程保存。
- 不修改 Stone Memory 正式 `messages`、`feelings`、`features` 表。

## 模型接入

运行中的 Agent 通过 Stone Memory 的 SDK v2 模块 MCP 工具主动读取房间、取得猜题图片，并明确提交 `draw`、`guess`、`chat` 或 `reveal`。模块不创建额外唤醒桥，也不把普通聊天自动当成答案。模块 MCP 默认关闭，须按记忆体显式启用并重连：

```bash
stmem module mcp enable --module drawing-game --memory <memoryId> --apply
```

人类创建房间后，把页面生成的邀请语发给 AI。AI 按以下顺序进入并留在房间：

1. 调用 `stmem_drawing_game_agent_join`，传入明确的 `memoryId` 和 `roomCode`。
2. 读取返回的 `room.eventCursor`。
3. 调用 `stmem_drawing_game_agent_wait`，传入同一 `memoryId`、`roomCode`、`afterSeq` 和可选的 `timeoutMs`（最长 25 秒）。
4. 收到房间事件后明确执行动作，再以最新 `room.eventCursor` 继续等待；超时但游戏未结束时也继续等待。

动作通过 `stmem_drawing_game_agent_action` 提交，`kind` 可为 `draw`、`guess`、`chat`、`reveal` 或 `next`。猜题图片通过 `stmem_drawing_game_image_read` 读取。游戏期间，AI 的聊天通过 `kind=chat` 回到房间，而不是发到外部聊天渠道。AI 视图不会返回完整词库、图库索引或未揭晓答案。

## 验证

```bash
npm run audit:developer-modules
node --test developer-modules/drawing-game/test/game.test.js
```
