const fs = require("fs");
const path = require("path");
const { getThreadDir } = require("../config");

function ruleDir(threadId) { return path.join(getThreadDir(threadId), "rules"); }
function stateFile(threadId) { return path.join(ruleDir(threadId), ".injection-state.json"); }
function safeName(name) {
  const value = path.basename(String(name || "").trim());
  if (!value || !value.toLowerCase().endsWith(".md")) throw new Error("规则文件必须是 .md 文档");
  return value;
}
function loadState(threadId) { try { return JSON.parse(fs.readFileSync(stateFile(threadId), "utf8")); } catch { return {}; } }
function saveState(threadId, state) {
  fs.mkdirSync(ruleDir(threadId), { recursive: true });
  const file = stateFile(threadId), temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2)); fs.renameSync(temp, file);
}
function listRules(threadId) {
  const dir = ruleDir(threadId), state = loadState(threadId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith(".md")).sort().map(name => ({
    name, content: fs.readFileSync(path.join(dir, name), "utf8"), injected: state[name] !== false,
  }));
}
function writeRule(threadId, name, content) {
  name = safeName(name); fs.mkdirSync(ruleDir(threadId), { recursive: true });
  fs.writeFileSync(path.join(ruleDir(threadId), name), String(content || ""), "utf8"); return name;
}
function deleteRule(threadId, name) { name = safeName(name); fs.rmSync(path.join(ruleDir(threadId), name), { force: true }); const state = loadState(threadId); delete state[name]; saveState(threadId, state); }
function setRuleInjected(threadId, name, injected) { name = safeName(name); if (!fs.existsSync(path.join(ruleDir(threadId), name))) throw new Error("规则文件不存在"); const state = loadState(threadId); state[name] = !!injected; saveState(threadId, state); }

module.exports = { listRules, writeRule, deleteRule, setRuleInjected };
