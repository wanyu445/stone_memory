"use strict";

const list = require("./commands/list");
const stats = require("./commands/stats");
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = maxLength => ({ type: "string", maxLength });
const id = { type: "string", minLength: 1, maxLength: 80 };
const tags = { type: "array", items: text(16), maxItems: 12 };
const options = { type: "array", items: object({ key: { type: "string", minLength: 1, maxLength: 12 }, value: text(24) }, ["key", "value"]), maxItems: 12, description: '配置键值列表，例如 [{"key":"糖度","value":"微糖"}]；省略沿用上次，空数组明确清空。' };
const category = { type: "string", enum: ["drink", "dessert", "takeout", "other"] };
const sentiment = { type: "string", enum: ["positive", "neutral", "negative"] };
const product = object({ brand: text(40), name: text(60), category, tags }, ["brand", "name"]);
const entryProperties = { date: text(10), ratingId: id, options, note: text(140), price: { type: "number", minimum: 0 } };
const entry = object(entryProperties);
const patch = object({ ...entryProperties, brand: text(40), name: text(60), category, tags,
  verdictOverride: object({ level: { type: "string", enum: ["rebuy", "maybe", "avoid"] }, note: text(40) }, ["level"]),
  clearVerdict: { type: "boolean", description: "清除手动回购判定，恢复自动计算。" },
  showSpend: { type: "boolean" }, tiers: { type: "array", items: object({ count: { type: "integer", minimum: 1 }, label: text(8) }, ["count", "label"]), minItems: 1, maxItems: 20 },
  addRatingLabel: object({ label: text(12), sentiment, emoji: text(4) }, ["label", "sentiment"]), removeRatingLabel: id,
});
function tool(name, description, inputSchema, readOnly, destructive = false, idempotent = readOnly) {
  return { name, description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false } };
}
const definitions = [
  tool("list", "读取当前绑定记忆体的味觉档案、评分设置、报告与待整理草稿。可按月份、品牌、标签或产品 ID 筛选；不写入数据。", object({ query: object({ productId: id, month: text(7), brand: text(40), tag: text(16) }) }), true),
  tool("stats", "读取当前绑定记忆体的口味画像、本命榜、避雷榜、复购和花销统计；不写入数据。", object({}), true),
  tool("add", "记录一笔吃喝体验，自动按品牌和品名归并。先 list 读取实际评分 ID；不猜价格或体验。同一体验只调用一次；不能确定内容时传 raw 保存待整理草稿。", object({ product, entry, raw: text(500) }), false),
  tool("update", "修改记录、档案卡或设置，合并档案，补全/移除草稿。ID 从 list 获取。merge/deleteEntry/deleteProduct/deleteDraft/clearAll 或移除评分档需要用户明确确认并传 confirm:true；删除不可在页面撤销。", object({
    op: { type: "string", enum: ["entry", "product", "merge", "settings", "resolveDraft", "deleteDraft", "deleteEntry", "deleteProduct", "clearAll"] },
    entryId: id, productId: id, draftId: id, fromProductId: id, intoProductId: id, patch, product, entry,
    confirm: { type: "boolean" }, force: { type: "boolean", description: "用户确认后，允许移除仍被记录使用的评分档；原记录改为尝鲜一次。" },
  }, ["op"]), false, true),
  tool("digest", "为当前记忆体写入或更新月度/整体味觉报告；先 list/stats 核对真实记录，同一范围的报告会被替换。删除报告需用户明确确认并传 confirm:true。提案只供页面审阅，不自动改评分或标签。", object({
    op: { type: "string", enum: ["save", "delete"] }, digestId: id, confirm: { type: "boolean" },
    scope: { type: "string", enum: ["month", "all"] }, month: text(7), title: text(60), author: text(40),
    sections: { type: "array", items: object({ heading: text(40), body: { type: "string", minLength: 1, maxLength: 1200 } }, ["body"]), minItems: 1, maxItems: 8 },
    proposals: { type: "array", items: object({ kind: { type: "string", enum: ["ratingLabel", "productTag"] }, label: text(16), sentiment, productId: id }, ["kind", "label"]), maxItems: 8 },
  }), false, true, true),
];
const destructiveOps = new Set(["deleteEntry", "deleteProduct", "deleteDraft", "clearAll", "merge"]);
function response(value, isError = false) { return { content: [{ type: "text", text: JSON.stringify(value) }], isError }; }
function normalize(value) {
  const result = structuredClone(value);
  for (const part of [result.entry, result.patch]) {
    if (part?.options) part.options = Object.fromEntries(part.options.map(({ key, value }) => [key, value]));
  }
  if (result.patch?.clearVerdict) result.patch.verdictOverride = null;
  if (result.patch) delete result.patch.clearVerdict;
  return result;
}
module.exports = {
  tools() { return structuredClone(definitions); },
  async call(context, name, args) {
    if (!context.memoryId) return response({ code: "TASTE_MEMORY_REQUIRED" }, true);
    if (context.signal?.aborted) throw new Error("MCP_CANCELLED");
    if (name === "list") return response(await list.run(context, { payload: args }));
    if (name === "stats") return response(await stats.run(context, { payload: args }));
    if (!["add", "update", "digest"].includes(name)) return response({ code: "TASTE_UNKNOWN_TOOL" }, true);
    if ((name === "update" && (destructiveOps.has(args.op) || args.patch?.removeRatingLabel)) || (name === "digest" && args.op === "delete")) {
      if (args.confirm !== true) return response({ code: "TASTE_CONFIRM_REQUIRED", message: "请先取得用户明确确认，再传 confirm:true。" }, true);
    }
    if (name === "add" && !args.product && !args.raw) return response({ code: "TASTE_ADD_REQUIRED", message: "请传 product，或用 raw 保存待整理原话。" }, true);
    if (name === "update") {
      const required = { entry: ["entryId", "patch"], product: ["productId", "patch"], merge: ["fromProductId", "intoProductId"], settings: ["patch"], resolveDraft: ["draftId", "product", "entry"], deleteDraft: ["draftId"], deleteEntry: ["entryId"], deleteProduct: ["productId"], clearAll: [] }[args.op];
      if (!required || required.some(key => !args[key])) return response({ code: "TASTE_UPDATE_REQUIRED", message: "请提供此操作对应的 ID 和修改内容。" }, true);
    }
    if (name === "digest" && args.op === "delete" && !args.digestId) return response({ code: "TASTE_DIGEST_REQUIRED", message: "删除报告需要 digestId。" }, true);
    if (name === "digest" && args.op !== "delete" && (!args.scope || !args.sections?.length)) return response({ code: "TASTE_DIGEST_REQUIRED", message: "写报告需要 scope 和 sections。" }, true);
    return response(await context.runCommand(name, normalize(args)));
  },
};
