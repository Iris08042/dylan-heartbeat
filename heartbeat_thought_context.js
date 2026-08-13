function thoughtBody(content) {
  return String(content || "")
    .trim()
    .replace(/^（那时没有打扰你。心里想：/, "")
    .replace(/）$/, "")
    .trim();
}

function pendingInboxThoughts(events) {
  return (Array.isArray(events) ? events : [])
    .filter(event => event?.kind === "thought")
    .map(event => ({ content: thoughtBody(event.content) }))
    .filter(thought => thought.content);
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

function buildPendingInboxContext(events, formatTime) {
  const pending = (Array.isArray(events) ? events : [])
    .filter(event => event?.content);
  if (pending.length === 0) {
    return `## 全部未读收件箱\n当前收件箱没有尚未被用户收取的内容。`;
  }
  const lines = pending.map((event, index) => {
    const time = event.createdAt && typeof formatTime === "function"
      ? formatTime(new Date(event.createdAt))
      : "时间未知";
    const isThought = event.kind === "thought";
    const kind = isThought ? "心理活动｜未发送手机推送" : "主动消息｜已发送手机推送";
    const content = isThought ? thoughtBody(event.content) : String(event.content).trim();
    return `${index + 1}. [${time}｜${kind}｜用户尚未收取] ${content}`;
  });
  return `## 全部未读收件箱\n${lines.join("\n")}\n\n以上内容都已经生成，但用户尚未打开聊天收取。它们不是用户发来的新消息。判断是否联系时必须考虑全部未读内容：不得重复发送或改写已有主动消息；不联系时只写相对于已有心理活动的新变化、新观察或新决定。若确实没有新变化，请如实说明仍决定保持安静，不要编造新的情节。`;
}

module.exports = {
  buildPendingInboxContext,
  findSimilarThought,
  pendingInboxThoughts,
  similarity,
  thoughtBody
};
