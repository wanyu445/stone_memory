const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const bin = path.join(__dirname, '../bin/stmem');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-import-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, STMEM_SKIP_PENDING_REBUILDS: '1' };
  const run = args => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
  const created = run(['memory', 'create', '--name', 'Synthetic import']);
  assert.equal(created.status, 0, created.stderr);
  const id = JSON.parse(created.stdout).memory.memoryId;
  const root = path.join(home, '.stone_memory', 'memories', id);
  const oldFile = path.join(home, 'old.json');
  const freshFile = path.join(home, 'corrected.jsonl');
  const content = 'A synthetic historical conversation with sufficiently unique full text.';
  fs.writeFileSync(oldFile, JSON.stringify([{role:'user',content,timestamp:'2026-01-03T10:00:00+08:00'}]));
  fs.writeFileSync(freshFile, JSON.stringify({role:'user',content,timestamp:'2026-01-02T10:00:00+08:00'})+'\n');
  const initial = run(['import', '--memory', id, '--source', oldFile, '--apply']);
  assert.equal(initial.status, 0, initial.stderr);
  const done = path.join(root, 'memory', 'import', 'done');
  const savedOld = path.join(done, fs.readdirSync(done)[0]);
  return { run, id, freshFile, oldFile, savedOld };
}

test('formal CLI previews and applies timestamp replacement, then refuses stale confirmation', t => {
  const {run,id,freshFile} = fixture(t);
  const args = ['import','--memory',id,'--source',freshFile,'--replace-matching'];
  const preview = run([...args,'--dry-run']);assert.equal(preview.status,0,preview.stderr);
  const plan = JSON.parse(preview.stdout);assert.equal(plan.replace,1);assert.equal(plan.add,1);
  const applied = run([...args,'--expect-hash',plan.expectedHash,'--apply']);
  assert.equal(applied.status,0,applied.stderr);
  const result = JSON.parse(applied.stdout);assert.equal(result.replaced,1);
  assert.equal(JSON.parse(fs.readFileSync(result.backupFile)).rows.length,1);
  const stale = run([...args,'--expect-hash',plan.expectedHash,'--apply']);
  assert.notEqual(stale.status,0);assert.match(stale.stderr,/预览已经变化/);
});

test('original-file CLI rejects an external old file and accepts the saved current-memory file', t => {
  const {run,id,freshFile,oldFile,savedOld} = fixture(t);
  const args = ['import','--memory',id,'--source',freshFile,'--replace-import-file'];
  const invalid = run([...args,oldFile,'--dry-run']);
  assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/当前记忆体已导入文件目录/);
  const preview = run([...args,savedOld,'--dry-run']);
  assert.equal(preview.status,0,preview.stderr);
  const plan=JSON.parse(preview.stdout);assert.equal(plan.mode,'original-file');assert.equal(plan.replace,1);
  const applied=run([...args,savedOld,'--expect-hash',plan.expectedHash,'--apply']);
  assert.equal(applied.status,0,applied.stderr);assert.equal(JSON.parse(applied.stdout).replaced,1);
});

test('confirmation hash without a replacement mode must not fall through to append', t => {
  const {run,id,freshFile} = fixture(t);
  const result=run(['import','--memory',id,'--source',freshFile,'--expect-hash','invalid','--apply']);
  assert.notEqual(result.status,0);assert.match(result.stderr,/必须配合/);
});
