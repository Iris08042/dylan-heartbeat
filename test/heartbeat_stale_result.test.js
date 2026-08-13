const test = require("node:test");
const assert = require("node:assert/strict");
const { userMessageSnapshot } = require("../wake_up");

test("detects a user message that arrives while the heartbeat model is running", () => {
  const before = [
    { id: "user-1", role: "user", content: "我先去忙。", position: 1 },
    { id: "assistant-1", role: "assistant", content: "好。", position: 2 }
  ];
  const after = [
    ...before,
    { id: "user-2", role: "user", content: "我回来了。", position: 3 }
  ];

  assert.notEqual(userMessageSnapshot(before), userMessageSnapshot(after));
  assert.equal(userMessageSnapshot(before), userMessageSnapshot([...before]));
});

test("distinguishes repeated user text when the delivery id changes", () => {
  const before = [{ id: "user-1", role: "user", content: "在吗", position: 1 }];
  const after = [...before, { id: "user-2", role: "user", content: "在吗", position: 2 }];
  assert.notEqual(userMessageSnapshot(before), userMessageSnapshot(after));
});

test("does not discard a result when only older read context changes", () => {
  const before = [
    { id: "old-user", role: "user", content: "旧消息", position: 1 },
    { id: "latest-user", role: "user", content: "我先去忙。", position: 3 }
  ];
  const after = [
    { id: "acknowledged-heartbeat", role: "assistant", content: "收取的旧消息", position: 2 },
    before[1]
  ];
  assert.equal(userMessageSnapshot(before), userMessageSnapshot(after));
});
