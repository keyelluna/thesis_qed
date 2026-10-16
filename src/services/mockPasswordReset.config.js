const TEST_SENDER = "QED School <onboarding@resend.dev>";

function accountId(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "";
  if (typeof value !== "number" && typeof value !== "string") return "";
  const id = String(value);
  return /^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= 18446744073709551615n ? id : "";
}

function validRecipient(value) {
  if (typeof value !== "string" || value.length > 254) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) ||
      local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  return labels.length > 1 && /^[A-Za-z]{2,63}$/.test(labels.at(-1)) &&
    labels.every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function readMockPasswordResetConfig(env = process.env) {
  const flag = env.QED_MOCK_PASSWORD_RESET_ENABLED;
  if (flag === undefined || flag === "" || flag === "false") return { mode: "off" };
  // A malformed activation flag must not fall back to normal recovery delivery.
  if (flag !== "true") return { mode: "invalid" };
  const recipient = env.QED_MOCK_PASSWORD_RESET_RECIPIENT;
  const list = env.QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS;
  if (!validRecipient(recipient) || typeof list !== "string" || !list.trim()) return { mode: "invalid" };
  const ids = list.split(",").map(id => id.trim());
  if (ids.length > 100 || ids.some(id => !accountId(id))) return { mode: "invalid" };
  return { mode: "on", recipient, accountIds: new Set(ids) };
}

function allowsMockPasswordReset(config, id) {
  return config.mode === "on" && config.accountIds.has(accountId(id));
}

module.exports = { readMockPasswordResetConfig, allowsMockPasswordReset, TEST_SENDER };
