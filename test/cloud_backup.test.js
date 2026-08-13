const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCloudBackupStore } = require("../cloud_backup");

test("keeps only the three newest complete backups and derives latest", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-cloud-backup-"));
  let now = new Date("2026-08-13T16:00:00.000Z");
  const store = createCloudBackupStore({ dataDir, now: () => now });
  const saved = [];

  for (let index = 1; index <= 4; index += 1) {
    now = new Date(`2026-08-${String(12 + index).padStart(2, "0")}T16:00:00.000Z`);
    saved.push(store.saveBackup(Buffer.from(`PK\u0003\u0004backup-${index}`)));
  }

  assert.deepEqual(store.listBackups().map(backup => backup.id), saved.slice(1).reverse().map(backup => backup.id));
  assert.equal(store.readBackup(saved[0].id), null);
  assert.deepEqual(store.readLatest().buffer, Buffer.from("PK\u0003\u0004backup-4"));
  assert.equal(fs.readdirSync(path.join(dataDir, "polaris-cloud-backup", "backups")).filter(name => name.endsWith(".zip")).length, 3);
});

test("rejects content that is not a zip package", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-cloud-backup-"));
  const store = createCloudBackupStore({ dataDir });
  assert.throws(() => store.saveBackup(Buffer.from("not a zip")), /not a zip package/);
});
