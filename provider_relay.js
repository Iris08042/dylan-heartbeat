const { lookup } = require("node:dns/promises");

const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "origin",
  "referer",
  "transfer-encoding"
]);
const AUTH_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key"]);
const NON_TEXT_PATH_HINTS = [
  "embedding", "embeddings", "image", "images", "audio", "speech",
  "transcription", "transcriptions", "moderation", "moderations",
  "upload", "uploads", "file", "files", "batch", "batches",
  "finetuning", "fine-tuning", "rerank", "reranking"
];

class ProviderRelayError extends Error {
  constructor(message, status = 400, type = "invalid_upstream") {
    super(message);
    this.name = "ProviderRelayError";
    this.status = status;
    this.type = type;
  }
}

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

function isPrivateAddress(value) {
  const address = normalizeAddress(value);
  if (!address || address === "localhost" || address.endsWith(".local")) return true;
  const mappedIpv4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) return isPrivateAddress(mappedIpv4[1]);
  if (address === "::" || address === "::1") return true;
  if (address.includes(":") && (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:"))) {
    return true;
  }
  const ipv4 = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1).map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a === 198 && (b === 18 || b === 19);
}

function sanitizeRelayHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers || {}).filter(([rawName, value]) => {
      const name = rawName.trim().toLowerCase();
      return (
        name
        && typeof value === "string"
        && value.trim()
        && !FORBIDDEN_HEADERS.has(name)
        && !name.startsWith("x-forwarded-")
      );
    })
  );
}

function hasRelayAuthHeader(headers) {
  return Object.keys(headers).some(name => AUTH_HEADERS.has(name.trim().toLowerCase()));
}

function parseRelayTarget(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ProviderRelayError("relay 目标地址无效。");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "").toLowerCase();
  if (
    parsed.protocol !== "https:"
    || isPrivateAddress(parsed.hostname)
    || !pathname
    || NON_TEXT_PATH_HINTS.some(hint => pathname.includes(hint))
  ) {
    throw new ProviderRelayError("当前 relay 只接受公开 HTTPS 的文本生成接口。");
  }
  return parsed;
}

async function validateRelayTarget(endpoint, lookupAddress = lookup) {
  const parsed = parseRelayTarget(endpoint);
  let addresses;
  try {
    addresses = await lookupAddress(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw new ProviderRelayError("relay 目标域名无法解析。");
  }
  const records = Array.isArray(addresses) ? addresses : [addresses];
  if (!records.length || records.some(record => isPrivateAddress(record?.address || record))) {
    throw new ProviderRelayError("relay 目标解析到了本地或内网地址。");
  }
  return parsed.toString();
}

async function forwardProviderRequest(payload, options = {}) {
  const endpoint = String(payload?.endpoint || "").trim();
  const validatedEndpoint = await validateRelayTarget(endpoint, options.lookupAddress);
  const headers = sanitizeRelayHeaders(payload?.headers);
  if (!hasRelayAuthHeader(headers)) {
    throw new ProviderRelayError("relay 请求缺少上游认证头。", 400, "missing_upstream_auth");
  }
  const method = payload?.method === "GET" ? "GET" : "POST";
  const fetchImpl = options.fetchImpl || fetch;
  return fetchImpl(validatedEndpoint, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(payload?.body ?? {}) } : {})
  });
}

module.exports = {
  ProviderRelayError,
  forwardProviderRequest,
  hasRelayAuthHeader,
  isPrivateAddress,
  sanitizeRelayHeaders,
  validateRelayTarget
};
