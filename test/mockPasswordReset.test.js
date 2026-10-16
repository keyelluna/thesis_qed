const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { readMockPasswordResetConfig, TEST_SENDER } = require("../src/services/mockPasswordReset.config");

const envKeys = ["NODE_ENV", "JWT_SECRET", "QED_CREDENTIAL_EMAIL_FROM", "QED_TEST_EMAIL_RECIPIENT",
  "QED_MOCK_PASSWORD_RESET_ENABLED", "QED_MOCK_PASSWORD_RESET_RECIPIENT", "QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS"];
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalRandomInt = crypto.randomInt;
const originalError = console.error;
let account, profile, operations, messages, generated, providerFailure;
function inject(file, exports) {
  const id = require.resolve(file);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
inject("resend", { Resend: class {
  constructor() { this.emails = { send: async message => {
    messages.push(message);
    if (providerFailure) return { error: { message: "synthetic provider rejection" } };
    return { data: { id: "synthetic-message" } };
  } }; }
} });
inject("../config/db", { execute: async (sql, args) => {
  operations.push({ sql, args });
  if (sql.startsWith("SELECT") && sql.includes("FROM qed_authentication")) {
    const found = account && (sql.includes("WHERE id = ?") ? String(account.id) === String(args[0]) : account.user_name === args[0]);
    return [[...(found && !account.is_deleted ? [{ ...account }] : [])]];
  }
  if (sql.startsWith("SELECT") && sql.includes("_table")) {
    return [[...(profile && profile.user_id === args[0] && !profile.is_deleted && profile.status === "Active" &&
      (args.length === 1 || profile.email_address === args[1]) ? [profile] : [])]];
  }
  if (sql.startsWith("UPDATE qed_authentication SET password_reset_otp = ?")) {
    account.password_reset_otp = args[0]; account.otp_expires_at = args[1]; return [{ affectedRows: 1 }];
  }
  if (sql.startsWith("UPDATE qed_authentication SET password_reset_otp = NULL")) {
    const matches = String(account.id) === String(args[0]) && account.password_reset_otp === args[1] &&
      (args.length < 4 || (+account.otp_expires_at > +args[2] && account.password === args[3]));
    if (matches) { account.password_reset_otp = null; account.otp_expires_at = null; }
    return [{ affectedRows: matches ? 1 : 0 }];
  }
  if (sql.startsWith("UPDATE qed_authentication SET password = ?")) {
    if (account.password !== args[2]) return [{ affectedRows: 0 }];
    account.password = args[0]; account.must_change_password = 0;
    account.password_reset_otp = null; account.otp_expires_at = null;
    return [{ affectedRows: 1 }];
  }
  throw Error("Unexpected synthetic database operation");
} });
const mailer = require("../src/services/mailer.service");
const controller = require("../src/modules/authentication/accountRecovery.controller");
const { recoveryLimits } = require("../src/modules/authentication/recoveryRateLimit");

test.beforeEach(() => {
  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = "synthetic-mock-reset-test-signing-key";
  process.env.QED_MOCK_PASSWORD_RESET_ENABLED = "true";
  process.env.QED_MOCK_PASSWORD_RESET_RECIPIENT = "teammate@example.invalid";
  process.env.QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS = "101, 102";
  delete process.env.QED_CREDENTIAL_EMAIL_FROM;
  delete process.env.QED_TEST_EMAIL_RECIPIENT;
  account = { id: 101, user_name: "synthetic.demo", role: "TEACHER", password: bcrypt.hashSync("Original123!", 4),
    is_deleted: 0, must_change_password: 1, password_reset_otp: "123456", otp_expires_at: new Date(Date.now() + 600000) };
  profile = { user_id: 101, email_address: "demo@example.invalid", status: "Active", is_deleted: 0 };
  operations = []; messages = []; generated = 0; providerFailure = false;
  crypto.randomInt = () => { generated++; return 654321; };
  console.error = () => {};
  recoveryLimits.clear();
});
test.after(() => {
  crypto.randomInt = originalRandomInt; console.error = originalError;
  for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
});
async function call(name, body) {
  let status = 200, output;
  const res = { status(value) { status = value; return this; }, json(value) { output = value; return this; } };
  await controller[name]({ body, ip: "127.0.0.1" }, res);
  return { status, body: output };
}
const request = extra => call("forgotPassword", { userName: account?.user_name || "unknown.demo", email: profile.email_address, ...extra });
const generic = { status: 200, body: { message: "If the account information matches, a recovery code will be emailed." } };
function assertNoRecoveryWrite() {
  assert.equal(generated, 0); assert.equal(messages.length, 0);
  assert(!operations.some(op => op.sql.startsWith("UPDATE")));
}

test("allowlisted hosted mock request keeps the original test sender and expiry", async () => {
  const before = Date.now();
  assert.deepEqual(await request(), generic);
  assert.equal(process.env.NODE_ENV, "production");
  assert.equal(messages.length, 1); assert.equal(messages[0].from, TEST_SENDER);
  assert.deepEqual(messages[0].to, ["teammate@example.invalid"]);
  assert(messages[0].html.includes("654321")); assert.equal(generated, 1);
  assert(+account.otp_expires_at >= before + 600000 && +account.otp_expires_at <= Date.now() + 600000);
});
test("mock recovery retains single-use codes, bound tokens and password safeguards", async () => {
  await request();
  const verified = await call("verifyOtp", { userName: account.user_name, otp: "654321" });
  assert.equal(verified.status, 200); assert.equal(account.password_reset_otp, null);
  const claims = jwt.verify(verified.body.resetToken, process.env.JWT_SECRET);
  assert.equal(claims.exp - claims.iat, 900);
  assert.equal((await call("verifyOtp", { userName: account.user_name, otp: "654321" })).status, 400);
  assert.equal((await call("resetPassword", { resetToken: verified.body.resetToken, newPassword: "short1" })).status, 400);
  assert.equal((await call("resetPassword", { resetToken: verified.body.resetToken, newPassword: "Recovered123!" })).status, 200);
  assert(await bcrypt.compare("Recovered123!", account.password));
  assert.equal((await call("resetPassword", { resetToken: verified.body.resetToken, newPassword: "Another123!" })).status, 401);
});
test("another explicitly allowlisted demo account uses the same teammate and test sender", async () => {
  account.id = 102; profile.user_id = 102;
  process.env.QED_CREDENTIAL_EMAIL_FROM = "QED Fixture <normal-sender@example.invalid>";
  assert.deepEqual(await request(), generic);
  assert.deepEqual(messages[0].to, ["teammate@example.invalid"]);
  assert.equal(messages[0].from, TEST_SENDER);
  messages = [];
  assert.equal((await mailer.sendPasswordResetOtpEmail({ to: profile.email_address, otp: "654321", accountId: "102" })).sent, true);
  assert.deepEqual(messages[0].to, ["teammate@example.invalid"]);
});
test("non-allowlisted account cannot spoof eligibility and retains its recovery record", async () => {
  account.id = 202; profile.user_id = 202;
  const expiry = account.otp_expires_at, password = account.password;
  assert.deepEqual(await request({ accountId: 101, mockDelivery: true }), generic);
  assertNoRecoveryWrite(); assert.equal(account.password_reset_otp, "123456");
  assert.equal(account.otp_expires_at, expiry); assert.equal(account.password, password);
});
test("unknown mock account has the same response and no recovery side effects", async () => {
  account = undefined; assert.deepEqual(await request(), generic); assertNoRecoveryWrite();
});
for (const condition of ["wrong-email", "inactive", "deleted-profile", "deleted-account"]) {
  test("allowlisted account still requires existing profile checks: " + condition, async () => {
    if (condition === "inactive") profile.status = "Inactive";
    if (condition === "deleted-profile") profile.is_deleted = 1;
    if (condition === "deleted-account") account.is_deleted = 1;
    assert.deepEqual(await request(condition === "wrong-email" ? { email: "wrong@example.invalid" } : {}), generic);
    assertNoRecoveryWrite();
  });
}
for (const [key, value] of [
  ["QED_MOCK_PASSWORD_RESET_ENABLED", "TRUE"], ["QED_MOCK_PASSWORD_RESET_ENABLED", "yes"],
  ["QED_MOCK_PASSWORD_RESET_RECIPIENT", undefined], ["QED_MOCK_PASSWORD_RESET_RECIPIENT", ""],
  ["QED_MOCK_PASSWORD_RESET_RECIPIENT", "bad-address"], ["QED_MOCK_PASSWORD_RESET_RECIPIENT", "one@example.invalid,two@example.invalid"],
  ["QED_MOCK_PASSWORD_RESET_RECIPIENT", "teammate@example.invalid\r\nBcc: other@example.invalid"],
  ["QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS", undefined], ["QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS", ""],
  ["QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS", "*"], ["QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS", "101,invalid"],
  ["QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS", "101,,102"], ["QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS", "0"],
  ["QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS", "-1"], ["QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS", "01"],
  ["QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS", "1e2"], ["QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS", "18446744073709551616"],
]) {
  test("invalid mock configuration blocks all reset delivery: " + key + " " + JSON.stringify(value), async () => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    assert.deepEqual(await request(), generic); assertNoRecoveryWrite();
    assert.equal((await mailer.sendPasswordResetOtpEmail({ to: profile.email_address, otp: "654321", accountId: 101 })).sent, false);
    assert.equal(messages.length, 0);
  });
}
for (const flag of [undefined, "false", ""]) {
  test("off/default mode preserves intended production delivery: " + String(flag), async () => {
    if (flag === undefined) delete process.env.QED_MOCK_PASSWORD_RESET_ENABLED; else process.env.QED_MOCK_PASSWORD_RESET_ENABLED = flag;
    process.env.QED_CREDENTIAL_EMAIL_FROM = "QED Fixture <sender@example.invalid>";
    assert.deepEqual(await request(), generic);
    assert.deepEqual(messages[0].to, [profile.email_address]);
    assert.equal(messages[0].from, process.env.QED_CREDENTIAL_EMAIL_FROM);
    assert.equal(readMockPasswordResetConfig().mode, "off");
  });
}
test("disabled mode does not enable the test sender in production", async () => {
  process.env.QED_MOCK_PASSWORD_RESET_ENABLED = "false";
  assert.deepEqual(await request(), generic); assert.equal(messages.length, 0);
  assert.equal(account.password_reset_otp, null);
});
for (const id of [undefined, 202, "0101", {}, 9007199254740992]) {
  test("mailer independently rejects missing/noncanonical/non-allowlisted ID " + JSON.stringify(id), async () => {
    assert.equal((await mailer.sendPasswordResetOtpEmail({ to: profile.email_address, otp: "654321", accountId: id })).sent, false);
    assert.equal(messages.length, 0);
  });
}
test("provider failure retains existing failed-delivery cleanup", async () => {
  providerFailure = true; assert.deepEqual(await request(), generic);
  assert.equal(account.password_reset_otp, null); assert.equal(account.otp_expires_at, null);
});
test("mock resend requests retain the existing request rate limit", async () => {
  for (let i = 0; i < 6; i++) assert.deepEqual(await request(), generic);
  assert.equal(messages.length, 5); assert.equal(generated, 5);
});
for (const flag of ["true", "invalid"]) {
  test("mock reset settings do not redirect credentials or grade notifications: " + flag, async () => {
    process.env.QED_MOCK_PASSWORD_RESET_ENABLED = flag;
    process.env.QED_CREDENTIAL_EMAIL_FROM = "QED Fixture <sender@example.invalid>";
    await mailer.sendCredentialsEmail({ to: "intended@example.invalid", firstName: "Fixture", userName: "synthetic.only", password: "Synthetic123!", role: "TEACHER" });
    await mailer.sendGradeVisibilityEmail({ to: "intended@example.invalid", studentId: 101, studentFirstName: "Fixture", termLabel: "First" });
    assert.equal(messages.length, 2);
    for (const message of messages) { assert.deepEqual(message.to, ["intended@example.invalid"]); assert.equal(message.from, process.env.QED_CREDENTIAL_EMAIL_FROM); }
  });
}
