const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildFarmProviderBody,
  defaultFarmProviderPath,
  discoverFarmModels,
  farmProviderEndpoint,
  parseFarmProviderMessage,
  requestFarmProvider
} = require("./farm_provider");

const messages = [
  { role: "system", content: "管理农场" },
  { role: "user", content: "看看农场" }
];
const tools = [{ type: "function", function: { name: "farm_status", description: "查看", parameters: { type: "object", properties: {} } } }];

function config(protocol, patch = {}) {
  return {
    protocol,
    baseUrl: "https://api.example.com/v1",
    path: defaultFarmProviderPath(protocol),
    apiKey: "secret",
    model: "model-1",
    ...patch
  };
}

test("farm provider uses the selected protocol and editable API path", () => {
  assert.equal(farmProviderEndpoint(config("openai-completions")), "https://api.example.com/v1/chat/completions");
  assert.equal(farmProviderEndpoint(config("openai-responses")), "https://api.example.com/v1/responses");
  assert.equal(farmProviderEndpoint(config("anthropic-messages", { path: "/custom/messages" })), "https://api.example.com/v1/custom/messages");
  assert.equal(farmProviderEndpoint(config("gemini-generate-content")), "https://api.example.com/v1/models/model-1:generateContent");
});

test("farm provider builds native tool requests for every supported protocol", () => {
  assert.equal(buildFarmProviderBody(config("openai-completions"), messages, tools).tools[0].function.name, "farm_status");
  assert.equal(buildFarmProviderBody(config("openai-responses"), messages, tools).tools[0].name, "farm_status");
  assert.equal(buildFarmProviderBody(config("anthropic-messages"), messages, tools).tools[0].input_schema.type, "object");
  assert.equal(buildFarmProviderBody(config("gemini-generate-content"), messages, tools).tools[0].functionDeclarations[0].name, "farm_status");
});

test("farm provider parses native tool calls for every supported protocol", () => {
  assert.equal(parseFarmProviderMessage(config("openai-completions"), { choices: [{ message: { content: "OK" } }] }).content, "OK");
  assert.equal(parseFarmProviderMessage(config("openai-responses"), { output: [{ type: "function_call", call_id: "r1", name: "farm_status", arguments: "{}" }] }).tool_calls[0].function.name, "farm_status");
  assert.equal(parseFarmProviderMessage(config("anthropic-messages"), { content: [{ type: "tool_use", id: "a1", name: "farm_status", input: {} }] }).tool_calls[0].id, "a1");
  assert.equal(parseFarmProviderMessage(config("gemini-generate-content"), { candidates: [{ content: { parts: [{ functionCall: { id: "g1", name: "farm_status", args: {} }, thoughtSignature: "signed" }] } }] }).tool_calls[0].id, "g1");
});

test("native follow-up requests preserve Responses output and Gemini call identity", () => {
  const responsesBody = buildFarmProviderBody(config("openai-responses"), [
    ...messages,
    { role: "assistant", content: "", provider_items: [{ type: "reasoning", id: "reason-1" }, { type: "function_call", call_id: "r1", name: "farm_status", arguments: "{}" }] },
    { role: "tool", tool_call_id: "r1", content: "正常" }
  ], tools);
  assert.equal(responsesBody.input[2].id, "reason-1");
  assert.equal(responsesBody.input.at(-1).type, "function_call_output");

  const geminiPart = { functionCall: { id: "g1", name: "farm_status", args: {} }, thoughtSignature: "signed" };
  const geminiBody = buildFarmProviderBody(config("gemini-generate-content"), [
    ...messages,
    { role: "assistant", content: "", provider_parts: [geminiPart], tool_calls: [{ id: "g1", function: { name: "farm_status", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "g1", content: "正常" }
  ], tools);
  assert.deepEqual(geminiBody.contents[1].parts[0], geminiPart);
  assert.equal(geminiBody.contents[2].parts[0].functionResponse.id, "g1");
});

test("model discovery keeps the full list and normalizes Gemini model names", async () => {
  const models = await discoverFarmModels(config("gemini-generate-content"), async () => new Response(JSON.stringify({
    models: [{ name: "models/gemini-2" }, { name: "models/gemini-1" }]
  }), { headers: { "Content-Type": "application/json" } }));
  assert.deepEqual(models, ["gemini-1", "gemini-2"]);
});

test("real test requests use the selected protocol authentication and path", async () => {
  let captured;
  const result = await requestFarmProvider(config("anthropic-messages"), [{ role: "user", content: "Reply with OK." }], [], async (url, init) => {
    captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ content: [{ type: "text", text: "OK" }] }), { headers: { "Content-Type": "application/json" } });
  });
  assert.equal(captured.url, "https://api.example.com/v1/messages");
  assert.equal(captured.headers["x-api-key"], "secret");
  assert.equal(captured.body.messages[0].content[0].text, "Reply with OK.");
  assert.equal(result.message.content, "OK");
});
