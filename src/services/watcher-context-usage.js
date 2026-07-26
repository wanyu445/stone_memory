const { updateContextUsage } = require("./rebuild-log");
const { observeThreadUsage } = require("./automatic-rebuild-coordinator");

function recordWatcherContextUsage(threadId, usage, threadConfig, {
  update = updateContextUsage,
  observe = observeThreadUsage,
} = {}) {
  const contextUsage = update(threadId, usage);
  const automaticRebuild = observe(threadId, usage, threadConfig);
  return { contextUsage, automaticRebuild };
}

async function runWatcherFlushPass(threadId, threadConfig, {
  archiveEnabled,
  sync,
  scanLatestArchiveDate,
  previousArchiveDate = null,
  mine,
  readUsage,
  recordUsage = recordWatcherContextUsage,
}) {
  if (archiveEnabled) await sync(threadId);
  const latestArchiveDate = scanLatestArchiveDate(threadId);
  if (previousArchiveDate && latestArchiveDate
    && previousArchiveDate !== latestArchiveDate) {
    await mine(threadId, latestArchiveDate);
  }
  const usage = readUsage(threadId, threadConfig);
  if (usage) recordUsage(threadId, usage, threadConfig);
  return { latestArchiveDate, usage };
}

module.exports = {
  recordWatcherContextUsage,
  runWatcherFlushPass,
};
