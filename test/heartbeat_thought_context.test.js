const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildThoughtContinuityContext,
  findSimilarThought,
  pendingHeartbeatThoughts,
  similarity
} = require("../heartbeat_thought_context");

test("labels pending thoughts and leaves acknowledged thoughts in normal chat context", () => {
  const thoughts = pendingHeartbeatThoughts([
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
    { content: "先让她安心忙。", createdAt: 1000, acknowledgedAt: null, pending: true }
  ]);
  const context = buildThoughtContinuityContext(thoughts, date => `T${date.getTime()}`);
  assert.match(context, /全部尚未收取的心理活动/);
  assert.match(context, /T1000｜尚未被用户看到/);
  assert.doesNotMatch(context, /T2000/);
  assert.match(context, /不得复述、改写或换词重演/);
});

test("keeps every pending thought and leaves acknowledged thoughts in normal chat context", () => {
  const messages = [];
  for (let index = 1; index <= 6; index += 1) {
    messages.push({
      role: "assistant",
      heartbeatInboxPending: true,
      heartbeatInboxKind: "thought",
      heartbeatInboxCreatedAt: index,
      heartbeatInboxContent: `未读心理活动 ${index}`
    });
    messages.push({
      role: "assistant",
      heartbeatThought: true,
      heartbeatThoughtCreatedAt: 100 + index,
      heartbeatThoughtAcknowledgedAt: 200 + index,
      content: `已读心理活动 ${index}`
    });
  }

  const thoughts = pendingHeartbeatThoughts(messages);
  assert.deepEqual(
    thoughts.filter(thought => thought.pending).map(thought => thought.content),
    [
      "未读心理活动 1",
      "未读心理活动 2",
      "未读心理活动 3",
      "未读心理活动 4",
      "未读心理活动 5",
      "未读心理活动 6"
    ]
  );
  assert.equal(thoughts.some(thought => !thought.pending), false);
  assert.ok(findSimilarThought("未读心理活动 1", thoughts));
});

test("detects exact and highly similar repeated thoughts", () => {
  const previous = [{ content: "她可能还在忙，我先安静陪她一会儿。" }];
  assert.equal(similarity(previous[0].content, previous[0].content), 1);
  assert.ok(findSimilarThought("她可能正在忙，我先不打扰，安静陪一会儿。", previous));
  assert.equal(findSimilarThought("窗外开始下雨了，我去把衣服收进来。", previous), null);
});
