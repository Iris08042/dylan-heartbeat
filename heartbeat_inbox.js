const fs = require("fs");
const crypto = require("crypto");
const { runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");

const MAX_AUDIT_EVENTS = 200;

function inboxFile() {
  return runtimeFile("heartbeat_inbox.json");
}

function auditFile() {
  return runtimeFile("heartbeat_delivery_audit.json");
}

function readArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function listPendingInboxEvents() {
  return readArray(inboxFile())
    .filter(event => event && event.id && event.content)
    .sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
}

function enqueueInboxEvent(content, createdAt = Date.now(), kind = "") {
  const cleanContent = String(content || "").trim();
  if (!cleanContent) throw new Error("inbox content is required");

  const event = {
    id: crypto.randomUUID(),
    content: cleanContent,
    createdAt: Number(createdAt)
  };
  if (["contact", "thought"].includes(kind)) event.kind = kind;
  const pending = listPendingInboxEvents();
  pending.push(event);
  writeJsonAtomicSync(inboxFile(), pending);
  return event;
}

function acknowledgeInboxEvents(ids, acknowledgedAt = Date.now()) {
  const requested = new Set(
    (Array.isArray(ids) ? ids : [])
      .map(id => String(id || "").trim())
      .filter(Boolean)
  );
  if (requested.size === 0) return [];

  const pending = listPendingInboxEvents();
  const acknowledged = pending.filter(event => requested.has(event.id));
  if (acknowledged.length === 0) return [];

  const audit = readArray(auditFile());
  const auditedIds = new Set(audit.map(event => event?.id).filter(Boolean));
  for (const event of acknowledged) {
    if (!auditedIds.has(event.id)) {
      audit.push({ ...event, acknowledgedAt: Number(acknowledgedAt) });
    }
  }
  writeJsonAtomicSync(auditFile(), audit.slice(-MAX_AUDIT_EVENTS));
  writeJsonAtomicSync(
    inboxFile(),
    pending.filter(event => !requested.has(event.id))
  );
  return acknowledged;
}

module.exports = {
  acknowledgeInboxEvents,
  enqueueInboxEvent,
  listPendingInboxEvents
};
