const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { getHealthNow, ingestHealthPayload } = require("../health_store");

test("stores selected HAE metrics and keeps the newest exact HRV sample", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "health-store-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  try {
    ingestHealthPayload({ data: { metrics: [
      { name: "step_count", units: "count", data: [{ date: "2026-08-18", qty: 6421 }] },
      { name: "heart_rate_variability", units: "ms", data: [{ date: "2026-08-18", qty: 38 }] },
      { name: "sleep_analysis", units: "hr", data: [{
        date: "2026-08-18",
        totalSleep: 7.2,
        core: 4.1,
        deep: 1.2,
        rem: 1.9,
        sleepEnd: "2026-08-18 07:20:00 +0800"
      }] },
      { name: "weight_&_body_mass", units: "kg", data: [{ date: "2026-08-18", qty: 50 }] }
    ] } }, Date.parse("2026-08-18T08:00:00+08:00"));
    ingestHealthPayload({ data: { metrics: [
      { name: "heart_rate_variability", units: "ms", data: [{
        date: "2026-08-18 15:18:00 +0800",
        qty: 47,
        source: "StressWatch"
      }] }
    ] } }, Date.parse("2026-08-18T15:20:00+08:00"));

    const current = getHealthNow(Date.parse("2026-08-18T15:35:00+08:00"));
    assert.equal(current.freshness, "current");
    assert.equal(current.uploadAgeMinutes, 15);
    assert.match(current.text, /同步状态：当前数据/);

    const result = getHealthNow(Date.parse("2026-08-18T16:00:00+08:00"));
    assert.equal(result.metrics.step_count.value.qty, 6421);
    assert.equal(result.metrics.heart_rate_variability.value.qty, 47);
    assert.equal(result.metrics.heart_rate_variability.value.source, "StressWatch");
    assert.equal(result.metrics.sleep_analysis.value.totalSleep, 7.2);
    assert.equal(result.metrics.resting_heart_rate.available, false);
    assert.equal(result.metrics.sleep_score, undefined);
    assert.equal(result.freshness, "old");
    assert.equal(result.uploadAgeMinutes, 40);
    assert.equal(result.metrics["weight_&_body_mass"], undefined);
    assert.match(result.text, /StressWatch/);
    assert.match(result.text, /同步状态：旧数据/);
    assert.match(result.text, /2026-08-18T07:20:00.000Z/);
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
