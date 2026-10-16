# Reset-only mock email for the QED thesis demonstration

Mock mode defaults OFF. It changes only Forgot Password code delivery, not account-credential emails, grade notifications, sign-in or password-change policy. It works with NODE_ENV=production; never change the official backend to development to enable redirection.

Private backend configuration (never commit actual values):

- `QED_MOCK_PASSWORD_RESET_ENABLED`: exactly `true` to activate; absent, empty or `false` leaves normal recovery unchanged. Other values fail closed.
- `QED_MOCK_PASSWORD_RESET_RECIPIENT`: the exact original designated teammate address, one plain valid email. This must be an address permitted by the existing Resend account's test-sender restrictions.
- `QED_MOCK_PASSWORD_RESET_ACCOUNT_IDS`: comma-separated canonical positive authentication IDs of OWNER-CONFIRMED SYNTHETIC demo accounts only (maximum 100). No usernames, wildcards, ranges or guessed IDs. Missing/invalid entries invalidate the complete configuration.

Before Render activation, obtain explicit owner confirmation of both the exact recipient and every eligible synthetic account. Software cannot infer whether an account is synthetic merely from its ID. Do not include real users or accounts linked to real school records. No account creation, production configuration change or activation is automatic.

For eligible requests, the existing user-name/email/profile checks still apply. The backend generates and stores the existing ten-minute OTP, then uses `QED School <onboarding@resend.dev>` and the configured teammate inbox. No custom domain or new provider is required for this test delivery. Resend's `resend.dev` sender can send only to its account's own permitted testing address; verify this privately before activation. See https://resend.com/docs/knowledge-base/403-error-resend-dev-domain . No email test is automatically sent.

While mock mode is enabled, a non-allowlisted account gets the same generic response without OTP generation, recovery-record updates or email delivery. The allowlist is based on the database-resolved ID, never a request-body account ID. Invalid enabled configuration also blocks code issuance and mail attempts. The OTP mailer independently checks configuration and eligibility. Real-account recovery is unavailable in this mode; it is never redirected to the teammate.

OTP verification, single-use consumption, expiry, reset-token binding, password rules and existing recovery rate limits remain unchanged. Mock mode does not revoke previously issued codes/tokens. Confirm no outstanding real-account recovery requests before a controlled demonstration; no automatic token rotation or record cleanup is performed. Turning mock mode off restores the existing normal recovery behavior, which still needs an authorized production sender for intended-user delivery.

The designated recipient is kept in ignored local private configuration with mock mode OFF and no eligible accounts configured. It must not appear in this guide, tests, example files, Git commits, logs or reports. Production Render activation requires a separate approval and may initiate a restart/deployment; do not save hosting changes during local preparation.

Focused tests use synthetic accounts, a fake database and a fake Resend transport. They cover hosted mock delivery, real-account exclusion without writes, malformed/missing config, default/disabled behavior, unchanged verification/reset safeguards, request limits, provider failure cleanup and isolation from other email functions. No production database, mail service or AI service is invoked.
