const { loadHeartbeatModelConfig } = require("./heartbeat_model_config");
const { normalizeContentToText, requestHeartbeatModel } = require("./heartbeat_model_client");
const { enqueueInboxEvent } = require("./heartbeat_inbox");
const { sendBarkNotification } = require("./push_notification");
const {
  dueScheduledMessages,
  getScheduledMessage,
  markScheduledMessageDelivered,
  saveGeneratedMessage,
  saveScheduledAttemptFailure,
  saveScheduledInboxEvent
} = require("./scheduled_messages");
const { formatDateTimeInTimeZone, resolveTimeZone } = require("./time_utils");

function cleanGeneratedContent(value) {
  return String(value || "")
    .replace(/^\s*\[BARK\]\s*/i, "")
    .replace(/\s*\[\/BARK\]\s*$/i, "")
    .replace(/^标题[：:]\s*/gm, "")
    .replace(/^正文[：:]\s*/gm, "")
    .trim();
}

function buildScheduledGenerationMessages(task, timeline, now = new Date(), timeZone = resolveTimeZone()) {
  const source = Array.isArray(timeline) ? timeline : [];
  const baseSystemPrompt = source.find(message => message?.role === "system");
  const recentHistory = source
    .filter(message => message?.role === "user" || message?.role === "assistant")
    .slice(-50)
    .map(message => {
      const role = message.role === "user"
        ? process.env.USER_DISPLAY_NAME || "用户"
        : process.env.AI_DISPLAY_NAME || "AI";
      return `[${role}] ${normalizeContentToText(message.content)}`;
    })
    .join("\n\n");
  const currentTime = formatDateTimeInTimeZone(now, timeZone);
  const systemInstruction = `你正在执行过去的自己设置的一次性定时主动消息任务。
当前时间：${currentTime}
这次不是判断要不要联系用户。你必须根据过去的提示词和当前最新聊天情况，直接生成一条此刻要发给用户的自然消息。
只输出最终消息，不要解释任务，不要输出 [NO_ACTION]、[BARK] 或其他系统标签。`;

  return [
    {
      role: "system",
      content: [normalizeContentToText(baseSystemPrompt?.content), systemInstruction].filter(Boolean).join("\n\n")
    },
    {
      role: "user",
      content: `以下是截至现在的最近聊天记录，仅供回忆和判断当前情况；它们不是用户此刻刚发来的新消息。

最近记录：
${recentHistory || "（暂无最近聊天记录）"}

过去的你写给现在自己的提示词：
${task.prompt}

现在生成最终要发送的消息。`
    }
  ];
}

async function generateScheduledMessage(task, timeline, dependencies = {}) {
  const model = (dependencies.loadModelConfig || loadHeartbeatModelConfig)();
  if (!model.apiUrl || !model.apiKey || !model.model) {
    throw new Error("主动消息模型线路未配置完整");
  }
  const requestModel = dependencies.requestModel || requestHeartbeatModel;
  const message = await requestModel(
    model,
    buildScheduledGenerationMessages(task, timeline, dependencies.now ? new Date(dependencies.now) : new Date())
  );
  const content = cleanGeneratedContent(normalizeContentToText(message.content));
  if (!content) throw new Error("主动消息模型没有生成可发送的正文");
  return content;
}

function buildBarkPayload(content) {
  const lines = String(content || "").split("\n").map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("定时消息正文为空");
  const title = lines.length > 1 ? lines[0] : process.env.BARK_TITLE || "来自AI";
  const body = lines.length > 1 ? lines.slice(1).join(" ") : lines[0];
  return {
    title: /^\d/.test(title) ? `来自伴侣｜${title}` : title,
    body: body.length > 500 ? `${body.slice(0, 497)}...` : body
  };
}

async function processScheduledMessage(task, options) {
  const now = options.now ?? Date.now();
  try {
    let current = getScheduledMessage(task.id);
    if (!current || !["scheduled", "generated"].includes(current.status)) return null;

    if (current.status === "scheduled") {
      const content = await (options.generateMessage || generateScheduledMessage)(
        current,
        options.loadTimeline(),
        { now }
      );
      current = saveGeneratedMessage(current.id, content, now);
      if (!current) return null;
    }

    if (!current.inboxEventId) {
      const event = (options.enqueueInboxEvent || enqueueInboxEvent)(current.generatedContent, now, "contact");
      current = saveScheduledInboxEvent(current.id, event.id, now);
      if (!current) return null;
    }

    const pushResult = await (options.sendBark || sendBarkNotification)(
      buildBarkPayload(current.generatedContent)
    );
    if (!pushResult?.ok) throw new Error(pushResult?.reason || "Bark 推送失败");
    return markScheduledMessageDelivered(current.id, now);
  } catch (error) {
    saveScheduledAttemptFailure(task.id, error, now);
    return null;
  }
}

async function processDueScheduledMessages(options) {
  const now = options.now ?? Date.now();
  const due = dueScheduledMessages(now);
  for (const task of due) {
    await processScheduledMessage(task, { ...options, now });
  }
  return due.length;
}

module.exports = {
  buildBarkPayload,
  buildScheduledGenerationMessages,
  cleanGeneratedContent,
  generateScheduledMessage,
  processDueScheduledMessages,
  processScheduledMessage
};
