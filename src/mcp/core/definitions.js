const TOOLS = [
  {
    name: "stmem_memory_rebuild",
    description: "Apply the latest successful rebuild preview using runtime-safe routing: Codex applies immediately and must restart at once; Claude Code queues for the next MCP load.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "目标记忆体 ID。只指定记忆体时使用其当前主 Binding。" },
        thread: { type: "string", description: "发起请求的当前 Codex/Claude 外部线程 ID；用于精确解析对应 Binding。省略时自动检测当前窗口。" },
        bindingId: { type: "string", description: "目标 Binding ID。用于明确重建某个已绑定窗口；必须属于解析出的记忆体。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_rebuild_preview",
    description: "生成只读线程重建预览，不排队、不改写线程。请使用统一结构：summary={mode,limit,minImportance}，context={mode,windowDays,toolPairs}，trim={excludedMessages,excludedTools}。这份完整请求会保留到确认阶段；随后调用 stmem_memory_rebuild，系统按 runtime 分流：Codex 立即 apply，Claude Code 写入 queue。trigger 由系统自动标记为 mcp，无需也不允许 Agent 填写。",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string", description: "目标记忆体 ID。只指定记忆体时使用其当前主 Binding。" },
        thread: { type: "string", description: "发起请求的当前 Codex/Claude 外部线程 ID；用于精确解析对应 Binding。省略时自动检测当前窗口。" },
        bindingId: { type: "string", description: "目标 Binding ID。用于明确重建某个已绑定窗口；必须属于解析出的记忆体。" },
        summary: {
          type: "object",
          description: "摘要注入方式。default 注入全部非 hidden 历史摘要；limited 按数量和 importance 筛选，锚点仍受保护。",
          properties: {
            mode: { type: "string", enum: ["default", "limited"] },
            limit: { type: "integer", minimum: 0, description: "limited 模式最多保留多少条；0 表示不限数量" },
            minImportance: { type: "integer", minimum: 0, maximum: 5 },
          },
          required: ["mode"], additionalProperties: false,
        },
        context: {
          type: "object",
          description: "近期上下文方式。active_days 按活跃对话日保留；watermark 从最后一条摘要对应原文开始保留。",
          properties: {
            mode: { type: "string", enum: ["active_days", "watermark"] },
            windowDays: { type: "integer", minimum: 1, description: "活跃对话日数量；水位线无法定位时也作为安全回退" },
            toolPairs: { type: "integer", minimum: 0, description: "保留最近 N 组完整工具调用" },
          },
          required: ["mode"], additionalProperties: false,
        },
        trim: {
          type: "object",
          description: "本次永久裁剪范围；通常保持空数组，只有用户明确确认裁剪时才能填写。",
          properties: {
            excludedMessages: { type: "array", items: { type: "string" } },
            excludedTools: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_mine",
    description: "手动触发单日记忆挖掘（feelings + features 双通道）",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "日期 YYYY-MM-DD，默认昨天" },
        thread: { type: "string", description: "线程 ID，默认自动检测" },
        force: { type: "boolean", description: "整日重挖；成功后直接替换当天结果，失败保留旧结果" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_status",
    description: "查看 stmem 记忆系统当前状态",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "stmem_memory_bind",
    description: "把指定的当前 Codex/Claude Code 窗口绑定到记忆体。必须随本次请求显式传入当前 thread 和 provider；Codex 调用方应先读取当前 active task 的线程 ID。环境变量仅作为旧客户端兼容兜底。只支持首次绑定，不提供改绑。",
    inputSchema: { type: "object", required: ["memory", "thread", "provider"], properties: {
      memory: { type: "string", description: "目标记忆体的显示名称或 memoryId" },
      thread: { type: "string", description: "必填。发起本次调用的当前 Codex/Claude Code 线程 ID；Codex 中使用当前 active task 的 ID" },
      provider: { type: "string", enum: ["codex", "claude"], description: "当前窗口所属客户端" },
    }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "stmem_memory_search",
    description: "关键词搜索记忆 feelings + 回溯原文 archive",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        thread: { type: "string", description: "发起请求的 Codex/Claude 线程 ID（通过 Binding 解析）；也兼容 memoryId。省略时使用当前窗口绑定。" },
        memoryId: { type: "string", description: "显式指定记忆体 ID，优先于 thread；未绑定窗口且存在多个记忆体时需要指定目标。" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_deep_search",
    description: "深度记忆检索（子 agent 多级搜索 + 原文回溯）",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索内容（自然语言）" },
        thread: { type: "string", description: "发起请求的 Codex/Claude 线程 ID（通过 Binding 解析）；也兼容 memoryId。省略时使用当前窗口绑定。" },
        memoryId: { type: "string", description: "显式指定记忆体 ID，优先于 thread；未绑定窗口且存在多个记忆体时需要指定目标。" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_audit_list",
    description: "List feelings from dates after the last audit cutoff. Shows feeling IDs and anchor type for marking.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID，默认自动检测" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_audit_mark",
    description: "Mark feelings by seq number as original-text or key-event anchors. Input: { cutoffDate, numbers, type }",
    inputSchema: {
      type: "object",
      required: ["cutoffDate"],
      properties: {
        cutoffDate: { type: "string", description: "Audit cutoff date (YYYY-MM-DD)." },
        numbers: { type: "array", items: { type: "integer" }, description: "Seq numbers to mark, e.g. [1, 3, 5]." },
        type: { type: "string", enum: ["retain", "event"], description: "'retain' 保留对应原文；'event' 标记长期关键事件，供生命周期保护和巡检使用。默认 retain。" },
        thread: { type: "string", description: "线程 ID，默认自动检测" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_audit_query",
    description: "Query feelings by date or keyword. Returns full content with anchor type. Input: { date?, keyword? }",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date YYYY-MM-DD, e.g. '2026-06-05'." },
        keyword: { type: "string", description: "Keyword to search in feeling content." },
        thread: { type: "string", description: "线程 ID，默认自动检测" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_triggers_check",
    description: "检查当前待办事项（重建、挖掘阻塞），返回自然语言列表。适合在会话启动或睡前巡检时调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const SEARCH_TOOLS = [
  {
    name: "memory_keyword_search",
    description: "Search feelings by keyword and return the narrative backbone with its event-window conversation. Use this first.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        query: { type: "string", description: "Space-separated Chinese keywords." },
        maxResults: { type: "integer", minimum: 1, maximum: 5 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_archive_context",
    description: "Search archive context across dates using keywords from the feeling result.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object", required: ["feelingDate", "keywords"],
      properties: {
        feelingDate: { type: "string", description: "Core feeling date in YYYY-MM-DD." },
        keywords: { type: "string", description: "Space-separated keywords." },
        maxDays: { type: "integer", minimum: 1, maximum: 30 },
        skipBefore: { type: "string", description: "Only search dates after YYYY-MM-DD." },
        mode: { type: "string", enum: ["event", "pattern"] },
      },
      additionalProperties: false,
    },
  },
];

const NOTEBOOK_STEWARD_TOOLS = [
  {
    name: "notebook_catalog",
    description: "List the current memory body's notebook topics, default topic, counts, archive/seal state, and safe latest-note summaries. Always call this before planning placement.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "notebook_search",
    description: "Search notebook title, tags, and body to locate an existing note. Use before read, update, move, restore, or trash; ambiguous matches require confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        topicId: { type: "string" },
        tags: { type: "array", items: { type: "string" }, maxItems: 20 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "notebook_read",
    description: "Read exactly one note by noteId to verify its title, topic, body, visibility, and current revision. This is read-only.",
    inputSchema: {
      type: "object",
      required: ["noteId"],
      properties: { noteId: { type: "string" } },
      additionalProperties: false,
    },
  },
];


module.exports = { TOOLS, SEARCH_TOOLS, NOTEBOOK_STEWARD_TOOLS };
