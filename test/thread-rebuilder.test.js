const test = require("node:test");
const assert = require("node:assert/strict");
const { automaticRetainWindow, buildFragmentWindows, buildMemoryBlocks } = require("../src/services/thread-rebuilder");

test("automatic retain windows begin five minutes before the feeling event", () => {
  const feeling={id:"f1",utcTime:"2026-07-04T10:00:00.000Z"};
  const messages=[
    {timestamp:"2026-07-04T09:54:59.000Z"},
    {timestamp:"2026-07-04T09:55:00.000Z"},
    {timestamp:"2026-07-04T10:01:00.000Z"},
  ];
  const result=buildFragmentWindows([feeling],[feeling],messages,{f1:{anchor:true}});

  assert.equal(result.fragmentWindows[0].startUtc,"2026-07-04T09:55:00.000Z");
  assert.deepEqual([...result.msgInFragment],[1,2]);
});

test("automatic retain windows stop at the first dialogue gap over five minutes", () => {
  const messages=[
    {timestamp:"2026-07-04T09:59:00.000Z"},
    {timestamp:"2026-07-04T10:02:00.000Z"},
    {timestamp:"2026-07-04T10:04:00.000Z"},
    {timestamp:"2026-07-04T10:11:00.000Z"},
  ];
  assert.deepEqual(automaticRetainWindow("2026-07-04T10:00:00.000Z","2026-07-04T10:30:00.000Z",messages),{
    startUtc:"2026-07-04T09:55:00.000Z",
    endUtc:"2026-07-04T10:11:00.000Z",
  });
});

test("the next feeling closes a continuous retain window", () => {
  const messages=[
    {timestamp:"2026-07-04T10:02:00.000Z"},
    {timestamp:"2026-07-04T10:06:00.000Z"},
    {timestamp:"2026-07-04T10:10:00.000Z"},
  ];
  assert.equal(automaticRetainWindow("2026-07-04T10:00:00.000Z","2026-07-04T10:08:00.000Z",messages).endUtc,"2026-07-04T10:08:00.000Z");
});

test("memory blocks use the configured user name", () => {
  const blocks=buildMemoryBlocks([{
    content:"7月4日，上午九点。一起散步。",
    date:"2026-07-04",
    hour:9,
    minute:0,
    utcTime:"2026-07-04T01:00:00.000Z",
  }],{userName:"里里"});
  assert.match(blocks[0].text,/你和里里在过去对话中的重要记忆/);
  assert.doesNotMatch(blocks[0].text,/小鱼/);
});
