function thoughtBody(content) {
  return String(content || "")
    .trim()
    .replace(/^（那时没有打扰你。心里想：/, "")
    .replace(/）$/, "")
    .trim();
}

function isThoughtMessage(message) {
  return message?.heartbeatInboxKind === "thought"
    || message?.heartbeatThought === true
    || (message?.heartbeatInboxPending === true
      && String(message.content || "").includes("心理活动已存入收件箱"));
}

function recentHeartbeatThoughts(messages, limit = 4) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message?.role === "assistant" && isThoughtMessage(message))
    .map(message => ({
      content: thoughtBody(message.heartbeatInboxContent || message.content),
      createdAt: Number(message.heartbeatInboxCreatedAt || message.heartbeatThoughtCreatedAt) || null,
      acknowledgedAt: Number(message.heartbeatThoughtAcknowledgedAt) || null,
      pending: message.heartbeatInboxPending === true
    }))
    .filter(thought => thought.content)
    .slice(-limit);
}

function normalizeForComparison(content) {
  return thoughtBody(content)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(value) {
  if (value.length < 2) return value ? [value] : [];
  return Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
}

function similarity(left, right) {
  const a = bigrams(normalizeForComparison(left));
  const b = bigrams(normalizeForComparison(right));
  if (a.length === 0 || b.length === 0) return 0;
  const remaining = new Map();
  for (const item of b) remaining.set(item, (remaining.get(item) || 0) + 1);
  let overlap = 0;
  for (const item of a) {
    const count = remaining.get(item) || 0;
    if (count > 0) {
      overlap += 1;
      remaining.set(item, count - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length);
}

function findSimilarThought(content, thoughts, threshold = 0.58) {
  return (Array.isArray(thoughts) ? thoughts : [])
    .map(thought => ({ thought, score: similarity(content, thought.content) }))
    .filter(result => result.score >= threshold)
    .sort((left, right) => right.score - left.score)[0] || null;
}

function buildThoughtContinuityContext(thoughts, formatTime) {
  if (!Array.isArray(thoughts) || thoughts.length === 0) {
    return `## 心理活动连续性\n此前没有可承接的心理活动。`;
  }
  const lines = thoughts.map((thought, index) => {
    const time = thought.createdAt && typeof formatTime === "function"
      ? formatTime(new Date(thought.createdAt))
      : "时间未知";
    const status = thought.pending ? "尚未被用户看到" : "用户已经收取";
    return `${index + 1}. [${time}｜${status}] ${thought.content}`;
  });
  return `## 此前的心理活动\n${lines.join("\n")}\n\n这次不是重新回复用户最后一条消息，而是承接上一次思路。只写新的变化、新观察或新决定；不得复述、改写或换词重演上面的内容。若确实没有新变化，请如实说明仍决定保持安静，不要编造新的情节。`;
}

module.exports = {
  buildThoughtContinuityContext,
  findSimilarThought,
  recentHeartbeatThoughts,
  similarity,
  thoughtBody
};
