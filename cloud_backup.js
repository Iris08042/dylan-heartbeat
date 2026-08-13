const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function writeFileAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, value);
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function assertBackupZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.subarray(0, 2).toString("ascii") !== "PK") {
    throw new Error("Backup body is not a zip package");
  }
}

function createCloudBackupStore({ dataDir, now = () => new Date() }) {
  const root = path.join(dataDir, "polaris-cloud-backup");
  const backupsDir = path.join(root, "backups");

  function backupFile(id) {
    return path.join(backupsDir, `${id}.zip`);
  }

  function metadataFile(id) {
    return path.join(backupsDir, `${id}.json`);
  }

  function listBackups() {
    if (!fs.existsSync(backupsDir)) return [];
    return fs.readdirSync(backupsDir)
      .filter(name => /^\d{17}-[a-f0-9]{8}\.json$/.test(name))
      .map(name => readJson(path.join(backupsDir, name)))
      .filter(metadata => metadata && fs.existsSync(backupFile(metadata.id)))
      .sort((left, right) => String(right.uploadedAt).localeCompare(String(left.uploadedAt)));
  }

  function saveBackup(buffer, clientCreatedAt) {
    assertBackupZip(buffer);
    const uploadedAt = now().toISOString();
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const id = `${uploadedAt.replace(/\D/g, "").slice(0, 17)}-${sha256.slice(0, 8)}`;
    const metadata = {
      id,
      createdAt: typeof clientCreatedAt === "string" && clientCreatedAt.trim()
        ? clientCreatedAt.trim()
        : uploadedAt,
      uploadedAt,
      bytes: buffer.length,
      sha256
    };
    writeFileAtomic(backupFile(id), buffer);
    try {
      writeFileAtomic(metadataFile(id), `${JSON.stringify(metadata, null, 2)}\n`);
    } catch (error) {
      try { fs.unlinkSync(backupFile(id)); } catch {}
      throw error;
    }
    for (const expired of listBackups().slice(3)) {
      try { fs.unlinkSync(backupFile(expired.id)); } catch {}
      try { fs.unlinkSync(metadataFile(expired.id)); } catch {}
    }
    return metadata;
  }

  function readBackup(id) {
    if (!/^\d{17}-[a-f0-9]{8}$/.test(String(id))) return null;
    const metadata = readJson(metadataFile(id));
    if (!metadata || !fs.existsSync(backupFile(id))) return null;
    return { metadata, buffer: fs.readFileSync(backupFile(id)) };
  }

  return {
    saveBackup,
    listBackups,
    readBackup,
    readLatest() {
      const latest = listBackups()[0];
      return latest ? readBackup(latest.id) : null;
    }
  };
}

module.exports = {
  createCloudBackupStore
};
