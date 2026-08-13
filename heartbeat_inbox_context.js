function inboxContent(event) {
  const content = String(event?.content || "").trim();
  if (event?.kind !== "thought") return content;
  return content
    .replace(/^（那时没有打扰你。心里想：/, "")
    .replace(/）$/, "")
    .trim();
}

function buildUnreadInboxContext(events, formatTime) {
  const unread = (Array.isArray(events) ? events : [])
    .filter(event => event?.id && event?.content)
    .sort((left, right) => Number(left.createdAt) - Number(right.createdAt));

  if (unread.length === 0) {
    return "## 全部未读收件箱\n当前收件箱没有尚未被用户收取的内容。";
  }

  const lines = unread.map((event, index) => {
    const time = event.createdAt && typeof formatTime === "function"
      ? formatTime(new Date(event.createdAt))
      : "时间未知";
    const kind = event.kind === "thought" ? "心理活动" : "主动联系";
    return `${index + 1}. [${time}｜${kind}｜用户尚未收取] ${inboxContent(event)}`;
  });

  return `## 全部未读收件箱\n${lines.join("\n")}\n\n以上内容都已经生成，但用户尚未打开聊天收取。它们不是用户发来的新消息。判断是否联系时必须考虑全部未读内容：不得重复发送、改写或换词重演已有内容；只写新的变化、新观察或新决定。若确实没有新变化，请如实保持安静，不要编造新的情节。`;
}

module.exports = { buildUnreadInboxContext };
