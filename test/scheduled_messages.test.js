const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  executeScheduledMessageTool,
  getScheduledMessage,
  listScheduledMessages
} = require("../scheduled_messages");
const { processDueScheduledMessages } = require("../scheduled_message_runtime");

function withDataDir(run) {
  return async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-messages-"));
    const previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    try {
      await run();
    } finally {
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

test("scheduled message tool creates, updates, lists, and cancels one-shot tasks", withDataDir(async () => {
  const now = Date.parse("2026-08-18T08:00:00+08:00");
  assert.throws(() => executeScheduledMessageTool({
    action: "create",
    runAt: "2026-08-18T09:00:00",
    prompt: "没有时区的时间不能接受"
  }, now), /明确时区/);
  const created = executeScheduledMessageTool({
    action: "create",
    runAt: "2026-08-18T09:00:00+08:00",
    prompt: "到点后结合最近聊天叫她起床"
  }, now);
  assert.match(created.receipt, /主动消息已设置在 2026年8月18日 09:00/);
  assert.equal(listScheduledMessages().length, 1);

  const updated = executeScheduledMessageTool({
    action: "update",
    taskId: created.task.id,
    runAt: "2026-08-18T09:30:00+08:00"
  }, now);
  assert.match(updated.receipt, /09:30/);

  const listed = executeScheduledMessageTool({ action: "list" }, now);
  assert.equal(listed.tasks[0].runAt, "2026-08-18T01:30:00.000Z");

  const cancelled = executeScheduledMessageTool({ action: "cancel", taskId: created.task.id }, now);
  assert.equal(cancelled.task.status, "cancelled");
  assert.equal(listScheduledMessages().length, 0);
}));

test("a generated message is persisted once and Bark retries reuse the same content", withDataDir(async () => {
  const createdAt = Date.parse("2026-08-18T08:00:00+08:00");
  const created = executeScheduledMessageTool({
    action: "create",
    runAt: "2026-08-18T09:00:00+08:00",
    prompt: "根据她现在的情况叫她起床"
  }, createdAt);
  const dueAt = Date.parse("2026-08-18T09:00:01+08:00");
  let generatedCount = 0;
  let inboxCount = 0;
  const sentBodies = [];

  await processDueScheduledMessages({
    now: dueAt,
    loadTimeline: () => [{ role: "user", content: "昨晚睡得很晚" }],
    generateMessage: async () => {
      generatedCount += 1;
      return "早上好\n该起床了，我知道你昨晚睡得晚。";
    },
    enqueueInboxEvent: content => {
      inboxCount += 1;
      assert.match(content, /昨晚睡得晚/);
      return { id: "inbox-1" };
    },
    sendBark: async payload => {
      sentBodies.push(payload.body);
      return { ok: false, reason: "temporary failure" };
    }
  });

  const waiting = getScheduledMessage(created.task.id);
  assert.equal(waiting.status, "generated");
  assert.equal(waiting.inboxEventId, "inbox-1");
  assert.equal(waiting.generatedContent, "早上好\n该起床了，我知道你昨晚睡得晚。");

  await processDueScheduledMessages({
    now: dueAt + 60_000,
    loadTimeline: () => { throw new Error("must not load timeline again"); },
    generateMessage: async () => { throw new Error("must not regenerate"); },
    enqueueInboxEvent: () => { throw new Error("must not enqueue twice"); },
    sendBark: async payload => {
      sentBodies.push(payload.body);
      return { ok: true };
    }
  });

  const delivered = getScheduledMessage(created.task.id);
  assert.equal(delivered.status, "delivered");
  assert.equal(generatedCount, 1);
  assert.equal(inboxCount, 1);
  assert.deepEqual(sentBodies, [
    "该起床了，我知道你昨晚睡得晚。",
    "该起床了，我知道你昨晚睡得晚。"
  ]);
}));
