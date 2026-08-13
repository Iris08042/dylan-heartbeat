const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("acknowledgement moves inbox events into the 50-message read timeline exactly once", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-delivery-"));
  const previousDataDir = process.env.DATA_DIR;
  const previousToken = process.env.HEARTBEAT_INBOX_TOKEN;
  process.env.DATA_DIR = dataDir;
  process.env.HEARTBEAT_INBOX_TOKEN = "test-token";

  const server = require("../server");
  const { listPendingInboxEvents } = require("../heartbeat_inbox");

  try {
    server.saveTimeline([
      { role: "system", content: "persona" },
      { role: "assistant", content: "（2026-08-10 20:10 刚刚给用户发了 Bark：测试）" },
      ...Array.from({ length: 55 }, (_, index) => ({
        id: `ordinary-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `ordinary ${index}`
      }))
    ]);
    assert.equal(server.loadTimeline().length, 51);
    assert.equal(server.loadTimeline().some(message => String(message.content).includes("Bark：测试")), false);

    const firstResponse = await server.app.inject({
      method: "POST",
      url: "/internal/wake-event",
      payload: { inboxContent: "完全相同的正文", inboxKind: "contact" }
    });
    const secondResponse = await server.app.inject({
      method: "POST",
      url: "/internal/wake-event",
      payload: { inboxContent: "完全相同的正文", inboxKind: "contact" }
    });
    assert.equal(firstResponse.statusCode, 200);
    assert.equal(secondResponse.statusCode, 200);
    const [first, second] = listPendingInboxEvents();
    assert.equal(server.loadTimeline().filter(message => server.heartbeatInboxEventId(message)).length, 0);

    const response = await server.app.inject({
      method: "POST",
      url: "/api/polaris/heartbeat/ack",
      headers: { authorization: "Bearer test-token" },
      payload: { ids: [first.id, second.id] }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().acknowledged, [first.id, second.id]);
    assert.equal(listPendingInboxEvents().length, 0);

    const delivered = server.loadTimeline().filter(message => server.heartbeatInboxEventId(message));
    assert.deepEqual(delivered.map(message => message.heartbeatInboxId), [first.id, second.id]);
    assert.deepEqual(delivered.map(message => message.content), ["完全相同的正文", "完全相同的正文"]);
    assert.deepEqual(delivered.map(message => message.timestamp), [first.createdAt, second.createdAt]);

    const rebuilt = server.buildTimeline([
      { role: "system", content: "persona" },
      { role: "assistant", content: "完全相同的正文" },
      { role: "assistant", content: "完全相同的正文" }
    ], {});
    assert.equal(rebuilt.filter(message => message.content === "完全相同的正文").length, 2);
    assert.equal(rebuilt.filter(message => server.heartbeatInboxEventId(message)).length, 0);

    server.appendAcknowledgedInboxMessages([first, second], 4000);
    assert.equal(
      server.loadTimeline().filter(message => server.heartbeatInboxEventId(message)).length,
      2
    );

    const audit = JSON.parse(fs.readFileSync(path.join(dataDir, "heartbeat_delivery_audit.json"), "utf8"));
    assert.deepEqual(audit.map(event => event.id), [first.id, second.id]);
    assert.deepEqual(audit.map(event => event.content), ["完全相同的正文", "完全相同的正文"]);

    const currentPolicyResponse = await server.app.inject({
      method: "GET",
      url: "/api/polaris/heartbeat/policy",
      headers: { authorization: "Bearer test-token" }
    });
    const currentPolicy = currentPolicyResponse.json().policy;
    const disableResponse = await server.app.inject({
      method: "PUT",
      url: "/api/polaris/heartbeat/policy",
      headers: { authorization: "Bearer test-token" },
      payload: { policy: { ...currentPolicy, enabled: false } }
    });
    assert.equal(disableResponse.json().policy.enabled, false);

    const { enabled, ...legacyPolicy } = disableResponse.json().policy;
    assert.equal(enabled, false);
    const legacySaveResponse = await server.app.inject({
      method: "PUT",
      url: "/api/polaris/heartbeat/policy",
      headers: { authorization: "Bearer test-token" },
      payload: { policy: legacyPolicy }
    });
    assert.equal(legacySaveResponse.json().policy.enabled, false);

    const emptyContextResponse = await server.app.inject({
      method: "PUT",
      url: "/api/polaris/heartbeat/context",
      headers: { authorization: "Bearer test-token" },
      payload: { systemPrompt: "persona", messages: [] }
    });
    assert.equal(emptyContextResponse.statusCode, 400);

    const contextMessages = Array.from({ length: 55 }, (_, index) => ({
      id: `context-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `context ${index}`,
      timestamp: 1000 + index
    }));
    const contextResponse = await server.app.inject({
      method: "PUT",
      url: "/api/polaris/heartbeat/context",
      headers: { authorization: "Bearer test-token" },
      payload: { systemPrompt: "current persona", messages: contextMessages }
    });
    assert.equal(contextResponse.statusCode, 200);
    assert.equal(contextResponse.json().messageCount, 50);
    const syncedTimeline = server.loadTimeline();
    assert.equal(syncedTimeline.length, 51);
    assert.equal(syncedTimeline[0].content, "current persona");
    assert.equal(syncedTimeline[1].id, "context-5");
    assert.equal(syncedTimeline.at(-1).id, "context-54");
  } finally {
    await server.app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousToken === undefined) delete process.env.HEARTBEAT_INBOX_TOKEN;
    else process.env.HEARTBEAT_INBOX_TOKEN = previousToken;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
