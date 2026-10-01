"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("notebook developer module is detachable and bound to the selected memory thread", () => {
  const publicDir = path.join(__dirname, "..", "src", "web", "public");
  const moduleDir = path.join(publicDir, "notebook-lab");
  const main = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  const bootstrap = fs.readFileSync(path.join(moduleDir, "bootstrap.js"), "utf8");
  const app = fs.readFileSync(path.join(moduleDir, "app.js"), "utf8");
  const html = fs.readFileSync(path.join(moduleDir, "index.html"), "utf8");
  const readme = fs.readFileSync(path.join(moduleDir, "README.md"), "utf8");
  for (const file of ["bootstrap.js", "index.html", "app.js", "styles.css", "README.md"]) {
    assert.ok(fs.existsSync(path.join(moduleDir, file)), file);
  }
  assert.match(main, /loadOptionalScript\("\/developer-kit\/bootstrap\.js(?:\?v=\d+)?"\)/);
  assert.doesNotMatch(main, /loadOptionalScript\("\/notebook-lab\/bootstrap\.js/);
  assert.match(bootstrap, /host\.dataset\.memoryId/);
  assert.match(bootstrap, /workspace["']\)\?\.dataset\.threadId/);
  assert.match(app, /encodeURIComponent\(memoryId\)/);
  assert.match(app, /此篇由小机封存中/);
  assert.match(html, /id="edit-note"/);
  assert.match(html, /id="paper-style"/);
  assert.match(html, /value="blank"/);
  assert.match(html, /value="lined"/);
  assert.match(html, /value="grid"/);
  assert.match(app, /stone:notebook:paper-style:v1/);
  assert.doesNotMatch(app, /animatePageTurn|data\.turning/);
  assert.match(app, /expectedRevision/);
  assert.match(app, /method: noteId \? "PATCH" : "POST"/);
  assert.match(app, /data-manage-topic/);
  assert.match(app, /data-unseal-note/);
  assert.match(app, /\/visibility/);
  assert.match(html, /name="coverPath"/);
  assert.match(html, /name="archived"/);
  assert.match(html, /name="isDefault"/);
  assert.match(html, /id="search-topic"/);
  assert.match(html, /id="search-tags"/);
  assert.match(html, /id="note-image"/);
  assert.match(html, /id="note-image-alt"/);
  assert.match(html, /id="upload-note-image"/);
  assert.match(app, /20 \* 1024 \* 1024/);
  assert.match(app, /insertAtCursor/);
  assert.match(app, /application\/octet-stream/);
  assert.match(app, /latestEntry/);
  assert.match(app, /URLSearchParams/);
  assert.equal((html.match(/type="button" data-close-dialog/g) || []).length, 2);
  assert.match(app, /button\.closest\("dialog"\)/);
  assert.match(app, /dialog\.close\(\)/);
  assert.match(readme, /正式写入只调用 `stmem notebook` CLI/);
  assert.doesNotMatch(app, /CyberBoss|cyberboss/i);
});
