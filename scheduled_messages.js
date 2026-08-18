const crypto = require("crypto");
const fs = require("fs");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");
const { getDatePartsInTimeZone, resolveTimeZone } = require("./time_utils");

const STORE_VERSION = 1;
const ACTIVE_STATUSES = new Set(["scheduled", "generated"]);

function storeFile() {
  return runtimeFile("scheduled_messages.json");
}

function loadStore() {
  const filePath = storeFile();
  if (!fs.existsSync(filePath)) return { version: STORE_VERSION, tasks: [] };
  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (saved?.version !== STORE_VERSION || !Array.isArray(saved.tasks)) {
    throw new Error("定时消息任务文件格式无效");
  }
  return saved;
}

function saveStore(store) {
  writeJsonAtomicSync(storeFile(), store);
  return store;
}

function parseFutureRunAt(value, now = Date.now()) {
  const input = String(value || "").trim();
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(input)) {
    throw new Error("执行时间必须包含明确时区，例如 +08:00");
  }
  const runAt = Date.parse(input);
  if (!Number.isFinite(runAt)) throw new Error("执行时间必须是包含时区的有效日期时间");
  if (runAt <= now) throw new Error("执行时间必须晚于当前时间");
  return runAt;
}

function cleanPrompt(value) {
  const prompt = String(value || "").trim();
  if (!prompt) throw new Error("写给未来自己的提示词不能为空");
  return prompt;
}

function publicTask(task) {
  const timeZone = resolveTimeZone();
  return {
    id: task.id,
    runAt: new Date(task.runAt).toISOString(),
    displayTime: receiptTime(task.runAt, timeZone),
    timeZone,
    prompt: task.prompt,
    status: task.status,
    createdAt: new Date(task.createdAt).toISOString(),
    ...(task.generatedAt ? { generatedAt: new Date(task.generatedAt).toISOString() } : {}),
    ...(task.deliveredAt ? { deliveredAt: new Date(task.deliveredAt).toISOString() } : {}),
    ...(task.lastError ? { lastError: task.lastError } : {})
  };
}

function receiptTime(runAt, timeZone = resolveTimeZone()) {
  const parts = getDatePartsInTimeZone(new Date(runAt), timeZone);
  return `${Number(parts.year)}年${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}`;
}

function createScheduledMessage(raw, now = Date.now()) {
  const task = {
    id: crypto.randomUUID(),
    runAt: parseFutureRunAt(raw?.runAt, now),
    prompt: cleanPrompt(raw?.prompt),
    status: "scheduled",
    createdAt: now,
    updatedAt: now
  };
  const store = loadStore();
  saveStore({ ...store, tasks: [...store.tasks, task] });
  return task;
}

function listScheduledMessages() {
  return loadStore().tasks
    .filter(task => ACTIVE_STATUSES.has(task.status))
    .sort((left, right) => left.runAt - right.runAt);
}

function getScheduledMessage(taskId) {
  const id = String(taskId || "").trim();
  return loadStore().tasks.find(task => task.id === id) || null;
}

function mutateTask(taskId, mutate) {
  const id = String(taskId || "").trim();
  if (!id) throw new Error("缺少定时消息任务 ID");
  const store = loadStore();
  const index = store.tasks.findIndex(task => task.id === id);
  if (index < 0) throw new Error("没有找到这条定时消息");
  const current = store.tasks[index];
  const next = mutate(current);
  if (!next) return null;
  const tasks = [...store.tasks];
  tasks[index] = next;
  saveStore({ ...store, tasks });
  return next;
}

function updateScheduledMessage(raw, now = Date.now()) {
  return mutateTask(raw?.taskId, current => {
    if (current.status !== "scheduled") throw new Error("只有尚未生成的定时消息可以修改");
    const hasRunAt = Object.hasOwn(raw || {}, "runAt");
    const hasPrompt = Object.hasOwn(raw || {}, "prompt");
    if (!hasRunAt && !hasPrompt) throw new Error("请提供要修改的时间或提示词");
    return {
      ...current,
      ...(hasRunAt ? { runAt: parseFutureRunAt(raw.runAt, now) } : {}),
      ...(hasPrompt ? { prompt: cleanPrompt(raw.prompt) } : {}),
      updatedAt: now,
      nextAttemptAt: undefined,
      lastError: undefined
    };
  });
}

function cancelScheduledMessage(taskId, now = Date.now()) {
  return mutateTask(taskId, current => {
    if (!ACTIVE_STATUSES.has(current.status)) throw new Error("这条定时消息已经结束");
    return { ...current, status: "cancelled", cancelledAt: now, updatedAt: now };
  });
}

function dueScheduledMessages(now = Date.now()) {
  return loadStore().tasks
    .filter(task => ACTIVE_STATUSES.has(task.status))
    .filter(task => task.runAt <= now && (!task.nextAttemptAt || task.nextAttemptAt <= now))
    .sort((left, right) => left.runAt - right.runAt);
}

function saveGeneratedMessage(taskId, content, now = Date.now()) {
  const cleanContent = String(content || "").trim();
  if (!cleanContent) throw new Error("到点生成的消息为空");
  return mutateTask(taskId, current => {
    if (current.status !== "scheduled") return null;
    return {
      ...current,
      status: "generated",
      generatedContent: cleanContent,
      generatedAt: now,
      updatedAt: now,
      nextAttemptAt: undefined,
      lastError: undefined
    };
  });
}

function saveScheduledInboxEvent(taskId, inboxEventId, now = Date.now()) {
  return mutateTask(taskId, current => {
    if (current.status !== "generated") return null;
    return { ...current, inboxEventId: String(inboxEventId), updatedAt: now };
  });
}

function saveScheduledAttemptFailure(taskId, error, now = Date.now(), retryDelayMs = 60_000) {
  return mutateTask(taskId, current => {
    if (!ACTIVE_STATUSES.has(current.status)) return null;
    return {
      ...current,
      lastAttemptAt: now,
      nextAttemptAt: now + retryDelayMs,
      lastError: error instanceof Error ? error.message : String(error || "未知错误"),
      updatedAt: now
    };
  });
}

function markScheduledMessageDelivered(taskId, now = Date.now()) {
  return mutateTask(taskId, current => {
    if (current.status !== "generated") return null;
    return {
      ...current,
      status: "delivered",
      deliveredAt: now,
      lastAttemptAt: now,
      updatedAt: now,
      nextAttemptAt: undefined,
      lastError: undefined
    };
  });
}

function executeScheduledMessageTool(raw, now = Date.now()) {
  const action = String(raw?.action || "").trim().toLowerCase();
  if (action === "create") {
    const task = createScheduledMessage(raw, now);
    return {
      action,
      receipt: `主动消息已设置在 ${receiptTime(task.runAt)}`,
      task: publicTask(task)
    };
  }
  if (action === "list") {
    return { action, tasks: listScheduledMessages().map(publicTask) };
  }
  if (action === "update") {
    const task = updateScheduledMessage(raw, now);
    return {
      action,
      receipt: `主动消息已改到 ${receiptTime(task.runAt)}`,
      task: publicTask(task)
    };
  }
  if (action === "cancel") {
    const task = cancelScheduledMessage(raw?.taskId, now);
    return { action, receipt: "主动消息已取消", task: publicTask(task) };
  }
  throw new Error("action 必须是 create、list、update 或 cancel");
}

module.exports = {
  cancelScheduledMessage,
  createScheduledMessage,
  dueScheduledMessages,
  executeScheduledMessageTool,
  getScheduledMessage,
  listScheduledMessages,
  loadStore,
  markScheduledMessageDelivered,
  publicTask,
  receiptTime,
  saveGeneratedMessage,
  saveScheduledAttemptFailure,
  saveScheduledInboxEvent,
  updateScheduledMessage
};
