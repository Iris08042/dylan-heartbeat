const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createOmbreDashboardClient,
  normalizeOmbreBucket
} = require("../ombre_dashboard");

test("normalizes current and legacy bucket fields", () => {
  const bucket = normalizeOmbreBucket({
    bucket_id: "memory-1",
    title: "北京之行",
    body: "准备去北京。",
    metadata: {
      type: "permanent",
      tags: "旅行, 北京",
      importance: "8",
      pinned: "true"
    },
    archived_at: "2026-08-14T00:00:00Z"
  });
  assert.deepEqual({
    id: bucket.id,
    name: bucket.name,
    content: bucket.content,
    type: bucket.type,
    tags: bucket.tags,
    importance: bucket.importance,
    pinned: bucket.pinned,
    archived: bucket.archived
  }, {
    id: "memory-1",
    name: "北京之行",
    content: "准备去北京。",
    type: "permanent",
    tags: ["旅行", "北京"],
    importance: 8,
    pinned: true,
    archived: true
  });
});

test("marks Ombre's timezone-naive timestamps as UTC", () => {
  const bucket = normalizeOmbreBucket({
    created_at: "2026-08-14T17:06:02",
    last_active_at: "2026-08-14T17:06:57"
  });

  assert.equal(bucket.createdAt, "2026-08-14T17:06:02Z");
  assert.equal(bucket.lastActiveAt, "2026-08-14T17:06:57Z");
});

test("logs in once and retries once after an expired session", async () => {
  const calls = [];
  let loginCount = 0;
  const client = createOmbreDashboardClient({
    baseUrl: "http://ombre.test",
    password: "secret",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, cookie: options.headers?.cookie || "" });
      if (url.endsWith("/auth/login")) {
        loginCount += 1;
        return new Response("{}", {
          status: 200,
          headers: { "set-cookie": `ombre_session=session-${loginCount}; HttpOnly; Path=/` }
        });
      }
      if (loginCount === 1) return new Response("{}", { status: 401 });
      return Response.json({ ok: true });
    }
  });

  assert.deepEqual(await client.request("/api/status"), { ok: true });
  assert.equal(loginCount, 2);
  assert.deepEqual(calls.map(call => call.cookie), ["", "ombre_session=session-1", "", "ombre_session=session-2"]);
});
