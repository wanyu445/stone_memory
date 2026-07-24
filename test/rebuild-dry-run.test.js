const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRebuildDryRun } = require("../src/services/rebuild-dry-run");

test("parses the full Claude rebuild dry-run report", () => {
  const report=parseRebuildDryRun(`[rebuild] Loading injectable feelings (daily/coarse; hidden excluded)...
[rebuild]   638 feelings
[rebuild]   27772 messages from full
[rebuild] Window: 5 days (cutoff: 2026-07-08), tool chains: 30 pairs, 10 tool IDs
[rebuild]   638 pre-window, 0 in-window
[rebuild]   36 retainOriginal (from retain-config.json) → 36 fragments, 17 dates
[rebuild]   injected 2 rules from rules/
[rebuild] ====== DRY RUN ======
  Window:            5 days (since 2026-07-08)
  Original messages: 27772
  Output lines:      2948
  Reduction:         89.4%
  Memory blocks:     17
  Window messages:   2928
  Retained messages: 74
  System dropped:    71
  Memory feelings:   602
  Full archive size: 1932810 bytes
  Estimated output:  205144 bytes`);
  const {raw,...parsed}=report;
  assert.match(raw,/DRY RUN/);
  assert.deepEqual(parsed,{
    runtime:"claude",windowDays:5,cutoff:"2026-07-08",retentionMode:"active-days",
    watermarkFeelingId:null,watermarkCutoff:null,watermarkFallback:false,
    fullMessages:27772,injectableFeelings:638,
    preWindowFeelings:638,inWindowFeelings:0,retainAnchors:36,retainFragments:36,retainDates:17,
    injectedRules:2,toolPairs:30,toolIds:10,originalMessages:27772,outputLines:2948,
    reductionPercent:89.4,memoryBlocks:17,windowMessages:2928,retainedMessages:74,functionCalls:null,
    systemDropped:71,memoryFeelings:602,fullArchiveBytes:1932810,estimatedOutputBytes:205144,
  });
});

test("reports an active watermark cutoff separately from the fallback day window", () => {
  const parsed=parseRebuildDryRun(`[rebuild] Retention mode: watermark (feeling feeling-9, since 2026-07-21T01:57:00.000Z)
[rebuild] Window: 5 days (cutoff: 2026-07-21), tool chains: 2 pairs, 2 tool IDs`);
  assert.equal(parsed.retentionMode,"watermark");
  assert.equal(parsed.watermarkFeelingId,"feeling-9");
  assert.equal(parsed.watermarkCutoff,"2026-07-21T01:57:00.000Z");
  assert.equal(parsed.watermarkFallback,false);
});

test("derives Codex injectable totals and retained original lines", () => {
  const parsed=parseRebuildDryRun(`[codex-rebuild] Window: 3 days (cutoff: 2026-07-22)
[codex-rebuild] 12 pre-window, 3 in-window
[codex-rebuild] 2 fragments → 1 archive dates, 10 → memory
[codex-rebuild] ====== DRY RUN ======
  Original: 100 lines → Output: 20 lines
  Reduction: 80.0%
  Full archive size: 1000 bytes
  Estimated output: 200 bytes
  Memory blocks: 1 | Messages: 14 | Function calls: 2
  Retained messages: 4
  System dropped: 3
  Tool pairs preserved: 1`);
  assert.equal(parsed.runtime,"codex");
  assert.equal(parsed.injectableFeelings,15);
  assert.equal(parsed.retainAnchors,2);
  assert.equal(parsed.retainedMessages,4);
});
