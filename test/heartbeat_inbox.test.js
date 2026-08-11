const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("heartbeat inbox drains acknowledged events and keeps an audit", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-inbox-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;

  try {
    const {
      acknowledgeInboxEvents,
      enqueueInboxEvent,
      listPendingInboxEvents
    } = require("../heartbeat_inbox");

    const first = enqueueInboxEvent("first", 1000);
    const second = enqueueInboxEvent("second", 2000);
    assert.deepEqual(listPendingInboxEvents().map(event => event.id), [first.id, second.id]);

    const acknowledged = acknowledgeInboxEvents([first.id], 3000);
    assert.deepEqual(acknowledged.map(event => event.id), [first.id]);
    assert.deepEqual(listPendingInboxEvents().map(event => event.id), [second.id]);

    assert.deepEqual(acknowledgeInboxEvents([first.id], 4000), []);
    const audit = JSON.parse(fs.readFileSync(path.join(dataDir, "heartbeat_delivery_audit.json"), "utf8"));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].acknowledgedAt, 3000);
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
