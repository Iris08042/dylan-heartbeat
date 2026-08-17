const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ProviderRelayError,
  forwardProviderRequest,
  sanitizeRelayHeaders,
  validateRelayTarget
} = require("./provider_relay");

const publicLookup = async () => [{ address: "8.8.8.8" }];

test("provider relay accepts changing OpenAI, Anthropic, and Gemini text endpoints", async () => {
  for (const endpoint of [
    "https://api.example.com/v1/chat/completions",
    "https://api.example.com/v1/messages",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent"
  ]) {
    assert.equal(await validateRelayTarget(endpoint, publicLookup), endpoint);
  }
});

test("provider relay rejects private and non-text targets", async () => {
  await assert.rejects(
    validateRelayTarget("https://127.0.0.1/v1/chat/completions", publicLookup),
    ProviderRelayError
  );
  await assert.rejects(
    validateRelayTarget("https://api.example.com/v1/files", publicLookup),
    ProviderRelayError
  );
  await assert.rejects(
    validateRelayTarget("https://api.example.com/v1/chat/completions", async () => [{ address: "10.0.0.2" }]),
    /内网地址/
  );
});

test("provider relay sanitizes transport headers and forwards the selected provider request", async () => {
  const calls = [];
  const response = new Response("ok", { status: 200 });
  const result = await forwardProviderRequest({
    endpoint: "https://api.example.com/v1/chat/completions",
    headers: {
      Authorization: "Bearer upstream-key",
      Host: "private.example",
      Origin: "https://polaris.yichen888.top",
      "X-Custom": "kept"
    },
    body: { model: "new-model" }
  }, {
    lookupAddress: publicLookup,
    fetchImpl: async (...args) => {
      calls.push(args);
      return response;
    }
  });

  assert.equal(result, response);
  assert.equal(calls[0][0], "https://api.example.com/v1/chat/completions");
  assert.deepEqual(calls[0][1].headers, {
    Authorization: "Bearer upstream-key",
    "X-Custom": "kept"
  });
  assert.equal(calls[0][1].body, JSON.stringify({ model: "new-model" }));
  assert.deepEqual(sanitizeRelayHeaders({ Host: "drop", "X-Api-Key": "keep" }), { "X-Api-Key": "keep" });
});

test("provider relay requires the selected provider authentication header", async () => {
  await assert.rejects(
    forwardProviderRequest({
      endpoint: "https://api.example.com/v1/chat/completions",
      headers: { "Content-Type": "application/json" },
      body: {}
    }, { lookupAddress: publicLookup }),
    /认证头/
  );
});
