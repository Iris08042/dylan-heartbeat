const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseWakeDecision,
  silentDecisionDelivery,
  thoughtInboxContent
} = require("../wake_decision");

test("parses a silent decision into an inbox-only thought", () => {
  assert.deepEqual(parseWakeDecision("[NO_ACTION]\n她可能还在忙，我先安静陪一会儿。"), {
    type: "thought",
    content: "她可能还在忙，我先安静陪一会儿。"
  });
  assert.equal(
    thoughtInboxContent("她可能还在忙，我先安静陪一会儿。"),
    "（那时没有打扰你。心里想：她可能还在忙，我先安静陪一会儿。）"
  );
});

test("routes a silent decision to the inbox without a push payload", () => {
  assert.deepEqual(
    silentDecisionDelivery("她可能还在忙，我先安静陪一会儿。", "2026-08-12 22:30"),
    {
      eventContent: "（2026-08-12 22:30 自动唤醒：本次未发送推送｜心理活动已存入收件箱）",
      inboxContent: "（那时没有打扰你。心里想：她可能还在忙，我先安静陪一会儿。）"
    }
  );
});

test("keeps ordinary wake output as a contact message", () => {
  assert.deepEqual(parseWakeDecision("想起你了，来看看你。"), {
    type: "contact",
    content: "想起你了，来看看你。"
  });
});

test("uses an honest message when a legacy no-action response has no thought", () => {
  assert.equal(
    thoughtInboxContent(parseWakeDecision("[NO_ACTION]").content),
    "（那时没有打扰你。心里想：这次没有写下具体想法，只是决定暂时不打扰你。）"
  );
});
