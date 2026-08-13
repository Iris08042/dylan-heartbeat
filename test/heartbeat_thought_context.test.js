const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPendingInboxContext,
  findSimilarThought,
  pendingInboxThoughts,
  similarity
} = require("../heartbeat_thought_context");

test("lists every unread inbox event with its time and delivery type", () => {
  const events = [
    {
      id: "thought-1",
      kind: "thought",
      createdAt: 1000,
      content: "（那时没有打扰你。心里想：先让她安心忙。）"
    },
    {
      id: "contact-1",
      kind: "contact",
      createdAt: 2000,
      content: "记得起来喝口水。"
    }
  ];
  const context = buildPendingInboxContext(events, date => `T${date.getTime()}`);
  assert.match(context, /全部未读收件箱/);
  assert.match(context, /T1000｜心理活动｜未发送手机推送｜用户尚未收取/);
  assert.match(context, /T2000｜主动消息｜已发送手机推送｜用户尚未收取/);
  assert.match(context, /记得起来喝口水/);
  assert.match(context, /不得重复发送或改写已有主动消息/);
});

test("keeps every unread thought available for continuity and duplicate checks", () => {
  const events = [];
  for (let index = 1; index <= 6; index += 1) {
    events.push({
      id: `thought-${index}`,
      kind: "thought",
      createdAt: index,
      content: `未读心理活动 ${index}`
    });
    events.push({
      id: `contact-${index}`,
      kind: "contact",
      createdAt: 100 + index,
      content: `未读主动消息 ${index}`
    });
  }

  const thoughts = pendingInboxThoughts(events);
  assert.deepEqual(
    thoughts.map(thought => thought.content),
    [
      "未读心理活动 1",
      "未读心理活动 2",
      "未读心理活动 3",
      "未读心理活动 4",
      "未读心理活动 5",
      "未读心理活动 6"
    ]
  );
  assert.ok(findSimilarThought("未读心理活动 1", thoughts));
  const context = buildPendingInboxContext(events, date => `T${date.getTime()}`);
  assert.equal((context.match(/未读主动消息/g) || []).length, 6);
});

test("detects exact and highly similar repeated thoughts", () => {
  const previous = [{ content: "她可能还在忙，我先安静陪她一会儿。" }];
  assert.equal(similarity(previous[0].content, previous[0].content), 1);
  assert.ok(findSimilarThought("她可能正在忙，我先不打扰，安静陪一会儿。", previous));
  assert.equal(findSimilarThought("窗外开始下雨了，我去把衣服收进来。", previous), null);
});
