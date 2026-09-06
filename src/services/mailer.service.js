// services/mailer.service.js
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const DEV_EMAIL_OVERRIDE = "kimlourenluna.dev@gmail.com";

const ROLE_LABELS = {
  ADMIN: "Administrator",
  PRINCIPAL: "Principal",
  TEACHER: "Teacher",
  PARENT: "Parent",
};

/**
 * Sends login credentials to a newly created user.
 * @param {Object} params
 * @param {string} params.to - recipient email
 * @param {string} params.firstName
 * @param {string} params.userName
 * @param {string} params.password - plain text, only ever available at creation time
 * @param {string} params.role
 */
async function sendCredentialsEmail({ to, firstName, userName, password, role }) {
  if (!to) {
    console.warn("sendCredentialsEmail: no recipient email, skipping send.");
    return { skipped: true };
  }

  const roleLabel = ROLE_LABELS[role?.toUpperCase()] || role;

  const actualRecipient = DEV_EMAIL_OVERRIDE || to;
  if (DEV_EMAIL_OVERRIDE) {
    console.log(
      `[DEV MODE] Credentials email intended for ${to} is being redirected to ${DEV_EMAIL_OVERRIDE} (no verified domain yet).`,
    );
  }

  try {
    const { data, error } = await resend.emails.send({
      from: "QED School <onboarding@resend.dev>", // palitan kapag verified na yung sarili niyong domain
      to: [actualRecipient],
      subject: "Your QED Account Credentials",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color:#8B0D0D;">Welcome to QED, ${firstName || ""}!</h2>
          <p>An account has been created for you as <strong>${roleLabel}</strong>.</p>
          <p>Here are your login credentials:</p>
          <table style="border-collapse: collapse; margin: 12px 0;">
            <tr>
              <td style="padding:6px 12px; font-weight:bold;">Username</td>
              <td style="padding:6px 12px;">${userName}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px; font-weight:bold;">Password</td>
              <td style="padding:6px 12px;">${password}</td>
            </tr>
          </table>
          <p style="color:#B91C1C; font-size:13px;">
            Please log in and change your password as soon as possible.
          </p>
          ${
            DEV_EMAIL_OVERRIDE
              ? `<p style="color:#6B7280; font-size:11px; margin-top:16px; border-top:1px solid #E5E7EB; padding-top:8px;">
                  [DEV MODE] This was actually meant for: ${to}
                </p>`
              : ""
          }
        </div>
      `,
    });

    if (error) {
      console.error("Resend send error:", error);
      return { sent: false, error };
    }

    return { sent: true, data };
  } catch (err) {
    console.error("sendCredentialsEmail failed:", err);
    return { sent: false, error: err };
  }
}

/**
 * Sends a password reset OTP code to the user.
 * @param {Object} params
 * @param {string} params.to - recipient email
 * @param {string} params.otp - 6-digit OTP code
 */
async function sendPasswordResetOtpEmail({ to, otp }) {
  if (!to) {
    console.warn("sendPasswordResetOtpEmail: no recipient email, skipping send.");
    return { skipped: true };
  }

  const actualRecipient = DEV_EMAIL_OVERRIDE || to;
  if (DEV_EMAIL_OVERRIDE) {
    console.log(
      `[DEV MODE] OTP email intended for ${to} is being redirected to ${DEV_EMAIL_OVERRIDE} (no verified domain yet).`,
    );
  }

  try {
    const { data, error } = await resend.emails.send({
      from: "QED School <onboarding@resend.dev>", // palitan kapag verified na yung sarili niyong domain
      to: [actualRecipient],
      subject: "Your QED Password Reset Code",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color:#8B0D0D;">Password Reset Request</h2>
          <p>We received a request to reset your QED account password. Use the code below to continue:</p>
          <div style="margin: 20px 0; text-align: center;">
            <span style="display:inline-block; font-size:28px; font-weight:bold; letter-spacing:6px; padding:12px 24px; background:#f7f7f8; border-radius:8px; color:#1a1a1a;">
              ${otp}
            </span>
          </div>
          <p style="color:#6B7280; font-size:13px;">
            This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.
          </p>
          ${
            DEV_EMAIL_OVERRIDE
              ? `<p style="color:#6B7280; font-size:11px; margin-top:16px; border-top:1px solid #E5E7EB; padding-top:8px;">
                  [DEV MODE] This was actually meant for: ${to}
                </p>`
              : ""
          }
        </div>
      `,
    });

    if (error) {
      console.error("Resend send error:", error);
      return { sent: false, error };
    }

    return { sent: true, data };
  } catch (err) {
    console.error("sendPasswordResetOtpEmail failed:", err);
    return { sent: false, error: err };
  }
}

module.exports = { sendCredentialsEmail, sendPasswordResetOtpEmail };