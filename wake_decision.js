function parseWakeDecision(text) {
  const content = String(text || "").trim();
  const noAction = content.match(/^\[NO_ACTION\]\s*([\s\S]*)$/i);
  if (!noAction) return { type: "contact", content };

  return {
    type: "thought",
    content: String(noAction[1] || "")
      .replace(/^原因[：:]\s*/, "")
      .trim()
  };
}

function thoughtInboxContent(thought) {
  const content = String(thought || "").trim()
    || "这次没有写下具体想法，只是决定暂时不打扰你。";
  return `（那时没有打扰你。心里想：${content}）`;
}

function silentDecisionDelivery(thought, timestamp) {
  return {
    eventContent: `（${timestamp} 自动唤醒：本次未发送推送｜心理活动已存入收件箱）`,
    inboxContent: thoughtInboxContent(thought)
  };
}

module.exports = { parseWakeDecision, silentDecisionDelivery, thoughtInboxContent };
