const test = require("node:test");
const assert = require("node:assert/strict");
const { buildUnreadInboxContext } = require("../heartbeat_inbox_context");

test("lists every unread inbox event in creation order with its time and type", () => {
  const events = [
    {
      id: "contact-1",
      kind: "contact",
      createdAt: 2000,
      content: "记得起来喝口水。"
    },
    {
      id: "thought-1",
      kind: "thought",
      createdAt: 1000,
      content: "（那时没有打扰你。心里想：先让她安心忙。）"
    }
  ];

  const context = buildUnreadInboxContext(events, date => `T${date.getTime()}`);
  assert.match(context, /1\. \[T1000｜心理活动｜用户尚未收取\] 先让她安心忙。/);
  assert.match(context, /2\. \[T2000｜主动联系｜用户尚未收取\] 记得起来喝口水。/);
  assert.match(context, /不得重复发送、改写或换词重演已有内容/);
  assert.doesNotMatch(context, /已发送手机推送/);
});

test("keeps all unread events instead of limiting thoughts or contacts", () => {
  const events = Array.from({ length: 12 }, (_, index) => ({
    id: `event-${index}`,
    kind: index % 2 === 0 ? "thought" : "contact",
    createdAt: index + 1,
    content: `事件正文 ${index + 1}`
  }));

  const context = buildUnreadInboxContext(events, date => `T${date.getTime()}`);
  assert.equal((context.match(/事件正文/g) || []).length, 12);
});
