const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildThoughtContinuityContext,
  findSimilarThought,
  recentHeartbeatThoughts,
  similarity
} = require("../heartbeat_thought_context");

test("labels pending and acknowledged thoughts with their actual state", () => {
  const thoughts = recentHeartbeatThoughts([
    {
      role: "assistant",
      heartbeatInboxPending: true,
      heartbeatInboxKind: "thought",
      heartbeatInboxCreatedAt: 1000,
      heartbeatInboxContent: "（那时没有打扰你。心里想：先让她安心忙。）"
    },
    {
      role: "assistant",
      heartbeatThought: true,
      heartbeatThoughtCreatedAt: 2000,
      heartbeatThoughtAcknowledgedAt: 3000,
      content: "（那时没有打扰你。心里想：晚一点再看看。）"
    }
  ]);
  assert.deepEqual(thoughts, [
    { content: "先让她安心忙。", createdAt: 1000, acknowledgedAt: null, pending: true },
    { content: "晚一点再看看。", createdAt: 2000, acknowledgedAt: 3000, pending: false }
  ]);
  const context = buildThoughtContinuityContext(thoughts, date => `T${date.getTime()}`);
  assert.match(context, /T1000｜尚未被用户看到/);
  assert.match(context, /T2000｜用户已经收取/);
  assert.match(context, /不得复述、改写或换词重演/);
});

test("detects exact and highly similar repeated thoughts", () => {
  const previous = [{ content: "她可能还在忙，我先安静陪她一会儿。" }];
  assert.equal(similarity(previous[0].content, previous[0].content), 1);
  assert.ok(findSimilarThought("她可能正在忙，我先不打扰，安静陪一会儿。", previous));
  assert.equal(findSimilarThought("窗外开始下雨了，我去把衣服收进来。", previous), null);
});
