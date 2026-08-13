const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isNoPushWakeEventContent,
  isSpecialEventContent,
  messagesForWakeContext
} = require("../special_events");

test("accepts real timestamped wake events", () => {
  assert.equal(isSpecialEventContent("（2026-08-10 20:10 自动唤醒：本次未发送推送｜原因：不打扰）"), true);
  assert.equal(isSpecialEventContent("（2026/8/10 20:10:03 刚刚给用户发了Bark推送：标题｜正文）"), true);
  assert.equal(isSpecialEventContent("（2026-08-10 20:10 刚刚给宝宝发了 Bark：测试）"), true);
});

test("does not turn ordinary replies mentioning event words into events", () => {
  assert.equal(isSpecialEventContent("我刚刚给用户发了推送，不过这只是回答里的说明。"), false);
  assert.equal(isSpecialEventContent("2026-08-10 20:10 我觉得‘自动唤醒：本次未发送推送’这句话很奇怪。"), false);
});

test("removes wake audit rows and pending thoughts from ordinary wake history", () => {
  const messages = [
    { role: "user", content: "今天有点困。" },
    { role: "assistant", content: "（2026-08-12 20:10 自动唤醒：本次未发送推送｜原因：不打扰）" },
    {
      role: "assistant",
      content: "（2026-08-12 20:30 自动唤醒：本次未发送推送｜心理活动已存入收件箱）\n不打扰她，安静陪一会儿。",
      heartbeatInboxPending: true,
      heartbeatInboxKind: "thought",
      heartbeatInboxContent: "（那时没有打扰你。心里想：不打扰她，安静陪一会儿。）"
    }
  ];

  assert.deepEqual(messagesForWakeContext(messages), [messages[0]]);
  assert.equal(isNoPushWakeEventContent(messages[1].content), true);
  assert.equal(isNoPushWakeEventContent("普通聊天里提到本次未发送推送"), false);
});

test("keeps every pending contact and acknowledged thoughts in normal chat context", () => {
  const acknowledgedThought = {
    role: "assistant",
    content: "（那时没有打扰你。心里想：等她忙完再说。）",
    heartbeatThought: true,
    heartbeatThoughtCreatedAt: 1000,
    heartbeatThoughtAcknowledgedAt: 2000
  };
  const messages = [
    { role: "user", content: "我先去忙一会儿。" },
    {
      role: "assistant",
      heartbeatInboxPending: true,
      heartbeatInboxKind: "contact",
      heartbeatInboxContent: "记得起来喝口水。"
    },
    acknowledgedThought,
    {
      role: "assistant",
      heartbeatInboxPending: true,
      heartbeatInboxKind: "contact",
      heartbeatInboxContent: "窗外开始下雨了。"
    }
  ];

  assert.deepEqual(messagesForWakeContext(messages), [
    messages[0],
    { role: "assistant", content: "[此前已生成、用户尚未收取的主动消息]\n记得起来喝口水。" },
    acknowledgedThought,
    { role: "assistant", content: "[此前已生成、用户尚未收取的主动消息]\n窗外开始下雨了。" }
  ]);
});
