const { resolveMcpThread } = require("./mcp-thread-resolution");
const { getMemoryRuntimeConfig } = require("../config");
const { findThreadSessionFile } = require("../lib/thread-session-file");
const { getConfiguredBinding, resolvePrimaryBinding } = require("./memory-binding-config");

function resolveMcpRebuildTarget(args = {}, cfg = {}, options = {}) {
  let callingBinding = null;
  const resolveThread = options.resolveMcpThread || resolveMcpThread;
  const requestedMemoryId = String(args.memoryId || "").trim();
  const resolutionArgs = args.thread ? { thread: args.thread } : args;
  const memoryId = resolveThread(resolutionArgs, cfg, options.configuredThreadIds || [], options.env || process.env, {
    ...(options.threadOptions || {}),
    onResolveBinding(binding) { callingBinding = binding; },
  });
  if (requestedMemoryId && requestedMemoryId !== memoryId) {
    throw new Error("memoryId 与 thread 指向不同记忆体，已拒绝重建");
  }
  const getBinding = options.getConfiguredBinding || getConfiguredBinding;
  const getPrimary = options.resolvePrimaryBinding || resolvePrimaryBinding;
  const findFile = options.findThreadSessionFile || findThreadSessionFile;
  const runtimeConfig = (options.getMemoryRuntimeConfig || getMemoryRuntimeConfig)(memoryId);

  let binding;
  const requestedBindingId = String(args.bindingId || "").trim();
  if (requestedBindingId) {
    binding = getBinding(memoryId, requestedBindingId);
    if (callingBinding?.bindingId && callingBinding.bindingId !== binding.id) {
      throw new Error("thread 与 bindingId 指向不同窗口，已拒绝重建");
    }
    const requestedThread = String(args.thread || "").trim();
    if (requestedThread && requestedThread !== memoryId && requestedThread !== binding.externalThreadId) {
      throw new Error("thread 与 bindingId 指向不同窗口，已拒绝重建");
    }
  } else if (callingBinding?.bindingId) {
    binding = getBinding(memoryId, callingBinding.bindingId);
  } else {
    binding = getPrimary(memoryId);
  }

  const resolvedThreadFile = binding.resolvedThreadFile
    || findFile(binding.sessionRoot, binding.externalThreadId);
  if (!resolvedThreadFile) throw new Error(`目标 Binding 的线程文件已失效：${binding.externalThreadId}`);
  return {
    threadId: memoryId,
    bindingId: binding.id,
    externalThreadId: binding.externalThreadId,
    resolvedThreadFile,
    runtime: binding.provider,
    windowDays: args.context?.windowDays || args.window || runtimeConfig.windowDays || 1,
    toolPairs: args.context?.toolPairs ?? args.toolPairs ?? runtimeConfig.keepToolPairs ?? 15,
  };
}

module.exports = { resolveMcpRebuildTarget };
