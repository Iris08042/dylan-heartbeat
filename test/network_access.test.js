const test = require("node:test");
const assert = require("node:assert/strict");
const { decideRequestAccess } = require("../network_access");

function decide(overrides = {}) {
  return decideRequestAccess({
    path: "/v1/chat/completions",
    ip: "10.0.0.8",
    isRailway: true,
    allowPublicApi: false,
    configuredKey: "gateway-test-key",
    authorization: "",
    headerKey: "",
    ...overrides
  });
}

test("does not trust a Railway private proxy address as the end user", () => {
  assert.equal(decide().allow, false);
  assert.equal(decide({ path: "/internal/wake-event" }).allow, false);
});

test("allows only localhost to call internal write routes", () => {
  assert.equal(decide({ path: "/internal/wake-event", ip: "127.0.0.1" }).allow, true);
  assert.equal(decide({ path: "/internal/heartbeat", ip: "::ffff:127.0.0.1" }).allow, true);
});

test("requires the gateway key when Railway public API is enabled", () => {
  assert.equal(decide({ allowPublicApi: true, authorization: "Bearer wrong" }).allow, false);
  assert.equal(decide({ allowPublicApi: true, authorization: "Bearer gateway-test-key" }).allow, true);
});

test("preserves trusted LAN access for non-Railway deployments", () => {
  assert.equal(decide({ isRailway: false, ip: "192.168.1.20" }).allow, true);
});
