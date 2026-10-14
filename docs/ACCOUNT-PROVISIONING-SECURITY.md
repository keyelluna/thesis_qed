# Administrative account provisioning security

The administrative provisioning APIs now require the existing verified JWT and an
Admin caller role. There is no public first-Admin/bootstrap exception. Existing
login, /me, password-change and owned-profile routes retain their contracts.

## Endpoint policy

Admin-only: POST /api/auth/register; POST /api/user/addUser;
PUT /api/user/editUser/:id (including status); PATCH /api/user/deleteUser/:id;
GET /api/user/getUser/:role/:id; GET /api/user/usersList;
GET /api/user/totalUser; GET /api/user/teacherCount; GET /api/user/parentCount.
Repository consumers of these user-record routes are administrative. Self-service
uses the separate verified identity/profile routes, which were not restricted to Admin.
Missing cookie: 401. Invalid/expired JWT: existing 403. Valid non-Admin,
unknown/malformed/missing role: 403 before controller/database operations.

## Single provisioning request

Both POST aliases accept complete profile information:
role (ADMIN, PRINCIPAL, TEACHER, PARENT), firstName, lastName, optional middleName,
email, contactNumber, status (Active/Inactive), gender (Male/Female for non-Admin).
Co-Admin uses the existing ADMIN role; no new role or bootstrap privilege exists.
Do not submit userId, password or generatedPassword: old split requests are rejected.
The server generates the institutional username using the previous name convention
and a cryptographically random 16-character password satisfying the current policy.
Only bcrypt hashes are stored; must_change_password is explicitly 1.

The server obtains a dedicated pool connection, takes a bounded MySQL named lock,
checks schema readiness without DDL, begins a transaction, checks username and
cross-role email conflicts, inserts authentication, uses that insert ID to insert
exactly one profile, then commits. All SQL participating in provisioning uses the
same connection. Both aliases share the lock, including across app workers.
Duplicate username/email yields 409; validation yields 400. Failures roll back the
transaction and never delete a client-specified auth row. No retry of the write.
Active Principal creation also checks the existing single-active-Principal rule.
Existing edit/delete models and their request/response contracts remain intact.

No schema migration is run automatically. Required account tables must be InnoDB;
required authentication/profile columns must exist. Missing readiness returns 503
before account writes. Runtime profile-model ALTER helpers are not called in this
new transaction path. If deployment metadata does not satisfy these requirements,
stop deployment and review a separate schema correction rather than bypassing the
check. Existing data and any historical orphan/duplicate accounts are not modified.
The named lock coordinates these provisioning entry points, not external SQL tools.

## Response and email

201: { success:true, message, data:<profile>, credentialDelivery }.
No password, hash or newly issued JWT is returned; caller session is not replaced.
credentialDelivery is accepted (provider acceptance, not proof of inbox delivery),
test-recipient, or failed. Email runs AFTER commit and connection release. Delivery
failure keeps the complete account, and the UI explicitly reports the failure.
Do not resubmit account creation to recover a mail failure.

QED_CREDENTIAL_EMAIL_FROM must be a provider-verified sender for production.
Without it, credential delivery returns failed without contacting the provider.
For non-production only, QED_TEST_EMAIL_RECIPIENT explicitly redirects test mail.
Production ignores that override. Never set it to a real school recipient for tests.
The previous shared unconditional recipient override is removed; the optional
non-production override is also respected by existing OTP/visibility mail helpers.
Credentials, provider error payloads and account recipient details are not logged
by the new provisioning/credential-delivery path. Credential HTML is escaped.

Emailing temporary passwords retains the established contract and still carries
mailbox exposure risk. A single-use activation/password-setup flow is preferable
future work, requiring a separately reviewed token persistence/expiry contract.
No activation table or change to login was introduced here. First-login change is
retained through the existing mustChangePassword response and UI.
Password reset and actual inbox delivery require separate safe end-to-end verification.

## Mandatory release actions

1. Rotate JWT_SECRET through the authorized secret-management process and restart
   every backend instance, invalidating tokens obtainable through the old public
   registration flaw. No secret was inspected or changed by this task.
2. Audit historical account provisioning in a separately authorized investigation;
   this correction does not identify or remove previously unauthorized accounts.
3. Verify table engines/required columns and privileges in an isolated MySQL fixture
   or authorized deployment metadata review; do not disable readiness checks.
4. Configure a verified credential sender, production NODE_ENV and safe mail tests.
5. Deploy frontend/backend together: old two-request clients are incompatible with
   the intentionally removed unsafe registration/auth-linking contract.

A lost connection during COMMIT can leave outcome uncertain, as with any remote
transaction. Both records remain atomic on InnoDB, but the client should look up
existing accounts before retrying. Provider acceptance is not a delivery receipt.
No automatic resend, account cleanup, database alteration or bootstrap creation
is performed by this correction.

## Account recovery checkpoint — 2026-10-12

Recovery now normalizes server-stored role strings through the allowlisted
ROLE_TABLES map. Uppercase ADMIN/PRINCIPAL/TEACHER/PARENT records recover correctly;
unknown, missing, non-string and whitespace-padded roles fail closed. The public
forgot-password response is identical for matching and nonmatching account/email,
inactive/deleted accounts, rate limits and provider failure. The login modal uses
conditional delivery wording. This protects status/body disclosure, not a claim
of constant response timing or email inbox delivery.

OTPs retain the ten-minute expiry and are consumed by a conditional atomic UPDATE
before a fifteen-minute HS256 reset token is issued. Reset tokens carry a purpose
and HMAC of the server-owned account ID/current password hash, using JWT_SECRET.
The reset checks current active profile ownership and uses a conditional password
UPDATE: concurrent/reused tokens cannot change the password twice. Any password
hash change invalidates outstanding reset tokens. Reset tokens cannot authenticate
ordinary session routes. Previously issued reset tokens without the binding must
be replaced by a new recovery request. No database schema change is required.

Request/OTP guessing has a bounded process-local ten-minute backstop per IP and
account. Multiple backend instances require a shared gateway/distributed limiter
and correct trusted-proxy configuration before Internet deployment. This local
limiter is not a substitute for deployment abuse protection. Recovery intentionally
gives no delivery success guarantee; failed email clears only that request's code,
preserving any newer code. Production OTP mail requires the same verified
QED_CREDENTIAL_EMAIL_FROM sender as provisioning. OTPs/provider payloads are not
logged. Password rules retain lowercase/digit/minimum length with a 72-byte cap to
avoid bcrypt truncation. Login, provisioning transactions and Admin policies are
otherwise unchanged.

Verification uses actual local Express routers/JWT/bcrypt/controllers with isolated
database/email doubles, and browser API fixtures. Actual MySQL persistence, database
collation/date behavior, production cookie/CORS and inbox delivery still require
isolated representative integration testing. No live database or mail was accessed.
See frontend QED-ACCOUNT-RECOVERY-VERIFICATION.md for exact runs and limitations.
