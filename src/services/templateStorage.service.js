const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_BYTES = 10 * 1024 * 1024;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function storageError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode, safeTemplateError: true });
}
function unavailable() {
  return storageError("TEMPLATE_UNAVAILABLE", "The official template for this grading period is unavailable. Please contact the administrator.");
}
function verifyChecksum(bytes, checksum) {
  if (!/^[a-f0-9]{64}$/i.test(String(checksum || "")) || sha256(bytes) !== checksum.toLowerCase()) {
    throw storageError("TEMPLATE_INTEGRITY", "The official template failed integrity verification. Please contact the administrator.");
  }
  return bytes;
}
const isMissing = (error) => ["NoSuchKey", "NotFound"].includes(error.name) || error.$metadata?.httpStatusCode === 404;

// Adapter contains only S3 operations. No public URLs, ACLs, or delete operation.
function createS3Adapter({ client, bucket }) {
  return {
    async get(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        let size = 0;
        for await (const chunk of response.Body) {
          size += chunk.length;
          if (size > MAX_BYTES) { response.Body.destroy?.(); throw storageError("TEMPLATE_SIZE", "The official template exceeds the supported size."); }
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      } catch (error) { if (isMissing(error)) return null; throw error; }
    },
    async exists(key) {
      try { await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
      catch (error) { if (isMissing(error)) return false; throw error; }
    },
    async putNew(key, bytes) {
      // Caller is the storage service, which generates a fresh UUID for every creation attempt.
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: XLSX_TYPE }));
    },
  };
}

function adapterFromEnv(env = process.env, createClient = (config) => new S3Client(config)) {
  const required = ["TEMPLATE_STORAGE_ACCESS_KEY_ID", "TEMPLATE_STORAGE_SECRET_ACCESS_KEY", "TEMPLATE_STORAGE_BUCKET", "TEMPLATE_STORAGE_ENDPOINT"];
  if (required.some((name) => !env[name]?.trim())) {
    throw storageError("TEMPLATE_STORAGE_CONFIG", "Official template storage is not configured. Please contact the administrator.", 503);
  }
  const endpoint = env.TEMPLATE_STORAGE_ENDPOINT.trim();
  let url;
  try { url = new URL(endpoint); }
  catch { throw storageError("TEMPLATE_STORAGE_CONFIG", "Official template storage configuration is invalid.", 503); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw storageError("TEMPLATE_STORAGE_CONFIG", "Official template storage requires a secure service endpoint without a bucket path.", 503);
  }
  const b2Region = url.hostname.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/)?.[1];
  const region = env.TEMPLATE_STORAGE_REGION?.trim() || b2Region;
  if (!region || (b2Region && region !== b2Region)) {
    throw storageError("TEMPLATE_STORAGE_CONFIG", "Official template storage region must match its service endpoint.", 503);
  }
  return createS3Adapter({
    bucket: env.TEMPLATE_STORAGE_BUCKET.trim(),
    client: createClient({
      endpoint, region, forcePathStyle: true,
      credentials: { accessKeyId: env.TEMPLATE_STORAGE_ACCESS_KEY_ID, secretAccessKey: env.TEMPLATE_STORAGE_SECRET_ACCESS_KEY },
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
      // Never automatically retry a potentially successful PutObject at the same key.
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30000, throwOnRequestTimeout: true },
    }),
  });
}

function createTemplateStorage({ adapter, getAdapter = adapterFromEnv } = {}) {
  let resolvedAdapter = adapter;
  const durable = () => (resolvedAdapter ||= getAdapter());
  async function objectOperation(operation) {
    try { return await operation(durable()); }
    catch (error) {
      if (error.safeTemplateError) throw error;
      // Do not propagate SDK errors containing endpoint/configuration details.
      throw storageError("TEMPLATE_STORAGE_FAILURE", "Official template storage is temporarily unavailable. Please try again later.", 503);
    }
  }
  return {
    async storeTemplate({ bytes, checksum }) {
      verifyChecksum(bytes, checksum);
      if (bytes.length > MAX_BYTES) throw storageError("TEMPLATE_STORAGE_INPUT", "Invalid official template storage input.");
      // Keys are generated here, never accepted from callers or derived from a reusable template ID.
      const storageKey = `grade-templates/${crypto.randomUUID()}/${checksum.toLowerCase()}.xlsx`;
      await objectOperation((store) => store.putNew(storageKey, bytes));
      const saved = await objectOperation((store) => store.get(storageKey));
      if (!saved) throw unavailable();
      verifyChecksum(saved, checksum);
      return storageKey;
    },
    async getTemplate(template) {
      let bytes;
      if (template.storageKey) {
        bytes = await objectOperation((store) => store.get(template.storageKey));
        if (!bytes) throw unavailable(); // Never fall back from a durable key to local/newest template.
      } else {
        if (!template.filePath) throw unavailable();
        try { bytes = await fs.readFile(template.filePath); }
        catch (error) {
          if (["ENOENT", "ENOTDIR"].includes(error.code)) throw unavailable();
          throw storageError("TEMPLATE_READ", "The official template could not be read. Please contact the administrator.");
        }
      }
      if (bytes.length > MAX_BYTES) throw storageError("TEMPLATE_SIZE", "The official template exceeds the supported size.");
      return verifyChecksum(bytes, template.checksum);
    },
    async templateExists(template) {
      if (template.storageKey) return objectOperation((store) => store.exists(template.storageKey));
      if (!template.filePath) return false;
      try { return (await fs.stat(template.filePath)).isFile(); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
    },
  };
}

module.exports = { ...createTemplateStorage(), createTemplateStorage, createS3Adapter, adapterFromEnv, sha256, verifyChecksum, XLSX_TYPE };
