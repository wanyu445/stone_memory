const path = require("path");
const os = require("os");

function resolveDatabasePath(memoryDir) {
  if (process.env.STMEM_DB_PATH) return path.resolve(process.env.STMEM_DB_PATH);
  const stoneRoot = path.join(os.homedir(), ".stone_memory");
  const runtimesRoot = path.join(stoneRoot, "runtimes") + path.sep;
  const resolvedMemory = path.resolve(memoryDir);
  if (resolvedMemory.startsWith(runtimesRoot)) return path.join(stoneRoot, "stone-memory.db");
  return path.join(resolvedMemory, "stone-memory.db");
}

module.exports = { resolveDatabasePath };
