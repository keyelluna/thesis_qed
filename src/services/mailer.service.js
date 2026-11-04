const emailjs = require("@emailjs/nodejs");
const { readMockPasswordResetConfig, allowsMockPasswordReset } = require("./mockPasswordReset.config");

const DEV_EMAIL_OVERRIDE = process.env.NODE_ENV !== "production"
  ? (process.env.QED_TEST_EMAIL_RECIPIENT || "") : "";
// Temporary thesis credential delivery until a sending domain is available.
const CREDENTIAL_EMAIL_OVERRIDE = DEV_EMAIL_OVERRIDE ||
  (process.env.NODE_ENV === "development" ? "kimlourenluna.dev@gmail.com" : "");
const APP_BASE_URL = process.env.NODE_ENV === "production"
  ? "https://qed-mseuf-candelaria.vercel.app" : "http://localhost:5173";

const ROLE_LABELS = {
  ADMIN: "Administrator",
  PRINCIPAL: "Principal",
  TEACHER: "Teacher",
  PARENT: "Parent",
};

const BRAND = "#6E0F0F";
const FONT = "Montserrat, 'Segoe UI', Arial, sans-serif";

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g,
  char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

/**
 * Shared QED email layout (header, body, "Access QED" button).
 * Table-based with inline styles so it renders in Gmail/Outlook.
 */
function layout({ heading, bodyHtml, noteHtml = "", ctaUrl = `${APP_BASE_URL}/login`, ctaLabel = "Access QED", devNote = "" }) {
  return `
<style>
  @media only screen and (max-width:520px) {
    .qed-wrap { padding:12px 6px !important; }
    .qed-pad { padding-left:20px !important; padding-right:20px !important; }
    .qed-title { font-size:19px !important; }
    .qed-h2 { font-size:20px !important; }
    .qed-btn { display:block !important; text-align:center !important; }
  }
</style>
<div class="qed-wrap" style="background:#f3f4f6; padding:32px 12px; font-family:${FONT};">
  <!--[if mso]><table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
  <table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0"
    style="max-width:600px; margin:0 auto; background:#ffffff; border-top:4px solid ${BRAND}; border-right:4px solid ${BRAND};">
    <tr>
      <td class="qed-pad" style="padding:32px 40px 22px; border-bottom:1px solid #e5e7eb;">
        <div class="qed-title" style="font-family:${FONT}; font-size:22px; font-weight:bold; color:${BRAND};">Elementary Department</div>
        <div style="font-family:${FONT}; font-size:11px; color:#6b7280; margin-top:6px;">Manuel S. Enverga University Foundation - Candelaria, Inc.</div>
      </td>
    </tr>
    <tr>
      <td class="qed-pad" style="padding:32px 40px 8px; font-family:${FONT}; font-size:14px; color:#111827; line-height:1.5;">
        ${heading}
        ${bodyHtml}
        ${noteHtml ? `<p style="margin:20px 0 0; font-size:13px; color:${BRAND}; line-height:1.5;">${noteHtml}</p>` : ""}
      </td>
    </tr>
    <tr>
      <td class="qed-pad" align="right" style="padding:16px 40px 36px;">
        <a class="qed-btn" href="${ctaUrl}" target="_blank"
          style="display:inline-block; background:${BRAND}; color:#ffffff; text-decoration:none; font-family:${FONT}; font-weight:bold; font-size:14px; padding:12px 28px; border-radius:999px;">
          ${ctaLabel}
        </a>
      </td>
    </tr>
    ${devNote ? `<tr><td class="qed-pad" style="padding:0 40px 20px; font-size:11px; color:#6b7280; font-family:${FONT};">${devNote}</td></tr>` : ""}
  </table>
  <!--[if mso]></td></tr></table><![endif]-->
</div>`;
}

const h2 = text => `<h2 class="qed-h2" style="margin:0 0 20px; font-family:${FONT}; font-size:22px; font-weight:500; color:#111827;">${text}</h2>`;
const h2Brand = text => `<h2 class="qed-h2" style="margin:0 0 20px; font-family:${FONT}; font-size:22px; font-weight:500; color:${BRAND};">${text}</h2>`;
const devNoteHtml = to => `[DEV MODE] This was actually meant for: ${escapeHtml(to)}`;

// Single entry point for all emails (one generic EmailJS template: {{subject}}, {{to_email}}, {{{html}}}).
async function sendViaEmailJs({ to, subject, html }) {
  return emailjs.send(
    process.env.EMAILJS_SERVICE_ID,
    process.env.EMAILJS_TEMPLATE_ID,
    { to_email: to, subject, html },
    {
      publicKey: process.env.EMAILJS_PUBLIC_KEY,
      privateKey: process.env.EMAILJS_PRIVATE_KEY,
    },
  );
}

async function sendCredentialsEmail({ to, firstName, userName, password, role }) {
  if (!to) {
    console.warn("sendCredentialsEmail: no recipient email, skipping send.");
    return { skipped: true };
  }

  const roleLabel = ROLE_LABELS[role?.toUpperCase()] || role;
  const actualRecipient = CREDENTIAL_EMAIL_OVERRIDE || to;

  const row = (label, value) => `
    <tr>
      <td style="padding:8px 4px; width:90px; font-size:14px; color:#111827; border-bottom:1px solid #6b7280;">${label}:</td>
      <td style="padding:8px 4px; font-size:14px; color:#111827; border-bottom:1px solid #6b7280; word-break:break-all;">${escapeHtml(value)}</td>
    </tr>`;

  const html = layout({
    heading: h2(`Welcome to QED, ${escapeHtml(firstName)}!`),
    bodyHtml: `
      <p style="margin:0 0 20px;">An account has been created for you as a <strong>${escapeHtml(roleLabel)}.</strong></p>
      <p style="margin:0 0 12px;">Here are your login credentials:</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse; width:100%; max-width:360px;">
        ${row("Username", userName)}
        ${row("Password", password)}
      </table>`,
    noteHtml: "Please log in and change your password as soon as possible.",
    devNote: CREDENTIAL_EMAIL_OVERRIDE ? devNoteHtml(to) : "",
  });

  try {
    await sendViaEmailJs({ to: actualRecipient, subject: "Your QED Account Credentials", html });
    return { sent: true, redirected: Boolean(CREDENTIAL_EMAIL_OVERRIDE) };
  } catch (err) {
    console.error("Credential email delivery failed:", err?.status, err?.text);
    return { sent: false, error: err };
  }
}

async function sendPasswordResetOtpEmail({ to, otp, accountId }) {
  if (!to) {
    console.warn("sendPasswordResetOtpEmail: no recipient email, skipping send.");
    return { skipped: true };
  }

  const mock = readMockPasswordResetConfig();
  if (mock.mode === "invalid" || (mock.mode === "on" && !allowsMockPasswordReset(mock, accountId))) {
    return { sent: false };
  }

  const actualRecipient = mock.mode === "on" ? mock.recipient : (DEV_EMAIL_OVERRIDE || to);
  const showDevNote = mock.mode === "off" && DEV_EMAIL_OVERRIDE;

  const html = layout({
    heading: h2Brand("Password reset request"),
    bodyHtml: `
      <p style="margin:0 0 24px;">We received a request to reset your QED account password. Use the code below to continue:</p>
      <div style="margin:24px 0; text-align:center; font-family:${FONT}; font-size:26px; font-weight:bold; letter-spacing:10px; color:#111827;">
        ${escapeHtml(otp)}
      </div>`,
    noteHtml: "This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.",
    devNote: showDevNote ? devNoteHtml(to) : "",
  });

  try {
    const data = await sendViaEmailJs({ to: actualRecipient, subject: "Your QED Password Reset Code", html });
    return { sent: true, data };
  } catch (err) {
    console.error("Recovery email delivery failed:", err?.status, err?.text);
    return { sent: false, error: err };
  }
}

async function sendGradeVisibilityEmail({ to, studentId, studentFirstName, termLabel }) {
  if (!to) {
    console.warn("sendGradeVisibilityEmail: no recipient email, skipping send.");
    return { skipped: true };
  }

  const actualRecipient = DEV_EMAIL_OVERRIDE || to;
  const progressReportPath = `/parent/students/${encodeURIComponent(studentId)}?tab=progressReport`;
  const ctaUrl = `${APP_BASE_URL}/login?redirect=${encodeURIComponent(progressReportPath)}`;

  const html = layout({
    heading: h2Brand("Grades Released!"),
    bodyHtml: `
      <p style="margin:0;">${escapeHtml(studentFirstName)}'s grades for ${escapeHtml(termLabel)} are now available to view in the QED parent portal.</p>`,
    ctaUrl,
    devNote: DEV_EMAIL_OVERRIDE ? devNoteHtml(to) : "",
  });

  try {
    const data = await sendViaEmailJs({ to: actualRecipient, subject: "Grades Now Available to View", html });
    return { sent: true, data };
  } catch (err) {
    console.error("Grade visibility email delivery failed:", err?.status, err?.text);
    return { sent: false, error: err };
  }
}

module.exports = {
  sendCredentialsEmail,
  sendPasswordResetOtpEmail,
  sendGradeVisibilityEmail,
};