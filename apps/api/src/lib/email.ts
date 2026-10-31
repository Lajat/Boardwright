/**
 * Minimal transactional-email sending via Resend's HTTP API, called with
 * the platform's native fetch rather than Resend's SDK — Node 22 (see the
 * Dockerfile) has fetch built in, so this needs no new dependency and
 * nothing to add to pnpm-lock.yaml.
 *
 * Resend's free tier (resend.com) covers this comfortably for a project at
 * this stage — a few thousand emails/month, no credit card required.
 * Swapping to a different provider later only means rewriting this one
 * function; nothing else in the app talks to it directly.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Resend requires the From address's domain to be verified in your Resend
// account before it'll actually deliver — onboarding@resend.dev is their
// own shared sandbox sender, which works immediately with no domain setup,
// fine for getting started but worth switching to your own verified
// domain before relying on this for real users.
const EMAIL_FROM = process.env.EMAIL_FROM || "Boardwright <onboarding@resend.dev>";

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

/**
 * Sends one email. If RESEND_API_KEY isn't set (e.g. local dev with no
 * account configured yet), logs the email to the server console instead of
 * failing outright — so the password-reset flow is still testable without
 * needing a real provider account, and nobody's left staring at a 500 just
 * because they haven't set up email yet.
 */
export async function sendEmail({ to, subject, html }: SendEmailInput): Promise<void> {
  if (!RESEND_API_KEY) {
    console.log(`[email:not configured] Would send to ${to}: "${subject}"\n${html}`);
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
  });

  if (!response.ok) {
    // Logged, not thrown: a failed reset email shouldn't surface as a
    // 500 to whoever requested the reset (that would leak, via timing or
    // error content, more than the generic response already intends to) —
    // see forgotPassword's own comment on why its response never changes
    // shape based on what happened internally.
    const body = await response.text().catch(() => "");
    console.error(`[email:send failed] ${response.status} sending to ${to}: ${body}`);
  }
}

export function passwordResetEmailHtml(resetLink: string): string {
  return `
    <p>Someone requested a password reset for your Boardwright account.</p>
    <p><a href="${resetLink}">Click here to set a new password</a>. This link expires in an hour.</p>
    <p>If you didn't request this, you can ignore this email — your password hasn't been changed.</p>
  `;
}
