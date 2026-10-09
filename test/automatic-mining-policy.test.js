"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  resolveAutomaticActions,
  shouldAutoMineDate,
} = require("../src/services/automatic-mining-policy");

test("conversation sync and memory mining are independent switches", () => {
  assert.deepEqual(resolveAutomaticActions({}), {
    sync: true, mine: true, compact: false,
  });
  assert.deepEqual(resolveAutomaticActions({
    automaticFullMining: false,
    automaticMemoryMaintenance: false,
  }), { sync: false, mine: false, compact: false });
  assert.deepEqual(resolveAutomaticActions({
    automaticFullMining: true,
    automaticMemoryMaintenance: false,
  }), { sync: true, mine: false, compact: false });
  assert.deepEqual(resolveAutomaticActions({
    automaticFullMining: false,
    automaticMemoryMaintenance: true,
  }), { sync: false, mine: true, compact: false });
  assert.deepEqual(resolveAutomaticActions({
    automaticFullMining: true,
    automaticMemoryMaintenance: true,
  }), { sync: true, mine: true, compact: false });
});


test("automatic compression requires its own explicit switch", () => {
  assert.equal(resolveAutomaticActions({
    autoCompact: { enabled: true },
  }).compact, false);
  assert.equal(resolveAutomaticActions({
    automaticCompression: true,
  }).compact, true);
});

test("watcherModules overrides legacy automatic fields without cross-thread fallback", () => {
  assert.deepEqual(resolveAutomaticActions({
    automaticFullMining: true,
    automaticMemoryMaintenance: true,
    watcherModules: { archive: false, miner: true, compression: false },
  }), { sync: false, mine: true, compact: false });
});

test("automatic mining only considers completed dates", () => {
  assert.equal(shouldAutoMineDate("2026-07-27", {
    today: "2026-07-30",
    automaticMemoryMaintenance: true,
  }), true);
  assert.equal(shouldAutoMineDate("2026-07-30", {
    today: "2026-07-30",
    automaticMemoryMaintenance: true,
  }), false);
  assert.equal(shouldAutoMineDate("2026-07-27", {
    today: "2026-07-30",
    automaticMemoryMaintenance: false,
  }), false);
});

test("watcher restart does not immediately catch up historical mining gaps", () => {
  const watcher = fs.readFileSync(path.join(__dirname, "..", "scripts", "watcher.js"), "utf8");
  assert.equal((watcher.match(/await checkAndMine\(tid\)/gu) || []).length, 1);
  assert.match(watcher, /if \(dateChanged && actions\.mine\)[\s\S]*?await checkAndMine\(tid\)/);
  const pollingLoop = watcher.slice(watcher.indexOf("while (true)"));
  assert.match(pollingLoop, /const minedAny = false/);
});
