const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("context management keeps legacy unscoped usage visible for the primary binding", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "web", "public", "app.js"), "utf8");
  assert.match(app, /const primaryLegacyUsage=primary&&\(!legacyUsage\?\.bindingId\|\|legacyUsage\.bindingId===binding\?\.id\)\?legacyUsage:null/);
  assert.match(app, /contextOverview\.contextUsageByBinding\?\.\[binding\.id\]\|\|primaryLegacyUsage/);
});
