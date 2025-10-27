// email-service.js — clean Resend service; force Railway base for all links
// -----------------------------------------------------------------------------

const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';

// Force this host for every link in outgoing emails
const FORCE_HOST =
  (process.env.APP_URL && process.env.APP_URL.replace(/^https?:\/\//,'').replace(/\/+$/,'')) ||
  'schedulesync-production.up.railway.app';

let resend = null;
if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log('✅ Resend email service configured');
} else {
  console.log('ℹ️  Email not configured (missing RESEND_API_KEY)');
}

// Normalize any URL/string to the forced host
function forcePublicBase(url) {
  const input = String(url || '');
  try {
    const u = new URL(input);
    u.protocol = 'https:';
    u.host = FORCE_HOST;
    return u.toString();
  } catch {
    if (input.startsWith('/')) return `https://${FORCE_HOST}${input}`;
    return input.replace(/^https?:\/\/[^/]+/i, `https://${FORCE_HOST}`);
  }
}

// Aggressively rewrite legacy domains & normalize href + visible URLs
function rewriteLinksToPublicBase(html) {
  let out = String(html || '');

  // Replace any legacy domain
  out = out.replace(/https?:\/\/(?:www\.)?trucal\.xyz/gi, `https://${FORCE_HOST}`);
  out = out.replace(/(?:www\.)?trucal\.xyz/gi, FORCE_HOST);

  // Normalize every href
  out = out.replace(/href="([^"]+)"/gi, (_, href) => `href="${forcePublicBase(href)}"`);

  // Normalize visible URLs in text
  out = out.replace(/>(https?:\/\/[^<]+)</gi, (_, url) => `>${forcePublicBase(url)}<`);

  return out;
}

// Core sender -----------------------------------------------------------------
async function sendEmail({ to, subject, html }) {
  if (!resend) { console.log('⚠️  Email service not available'); return false; }
  try {
    const safeHtml = rewriteLinksToPublicBase(html);
    await resend.emails.send({ from: EMAIL_FROM, to, subject, html: safeHtml });
    return true;
  } catch (error) {
    console.error('❌ Failed to send email:', error);
    throw error;
  }
}

// Base template wrapper -------------------------------------------------------
function wrapBaseHtml({ title, body }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title || 'ScheduleSync'}</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #111827; background:#ffffff; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg,#667eea 0%,#764ba2 100%); color: #fff; padding: 28px; text-align: center; border-radius: 12px 12px 0 0; }
    .content { background:#f9fafb; padding: 28px; border-radius: 0 0 12px 12px; }
    .button { display:inline-block; background: linear-gradient(135deg,#667eea 0%,#764ba2 100%); color:#fff !important; padding:12px 22px; text-decoration:none; border-radius:8px; font-weight:600; }
    .muted { color:#6b7280; font-size:13px; }
    .link { color:#4f46e5; word-break: break-all; }
    h1,h2,h3 { margin: 0 0 8px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>${title || 'ScheduleSync'}</h1></div>
    <div class="content">${body}</div>
    <div class="muted" style="text-align:center;margin-top:16px;">© ${new Date().getFullYear()} ScheduleSync</div>
  </div>
</body>
</html>`;
}

// Templates -------------------------------------------------------------------

// Password reset
async function sendPasswordReset(to, userName, resetLink) {
  if (!resend) return false;
  try {
    const finalLink = forcePublicBase(resetLink);
    const html = wrapBaseHtml({
      title: '🔒 Reset Your Password',
      body: `
        <p>Hi ${userName || ''},</p>
        <p>We received a request to reset your password for your ScheduleSync account.</p>
        <p style="text-align:center;margin:20px 0;">
          <a href="${finalLink}" class="button">Reset Password</a>
        </p>
        <p class="muted">Or copy this link:</p>
        <p class="link">${finalLink}</p>
        <p class="muted"><strong>This link will expire in 1 hour.</strong></p>
      `
    });
    await sendEmail({ to, subject: 'Reset Your ScheduleSync Password', html });
    return true;
  } catch { return false; }
}

// Password changed
async function sendPasswordChanged(to, userName) {
  if (!resend) return false;
  try {
    const html = wrapBaseHtml({
      title: '✅ Password Changed Successfully',
      body: `
        <p>Hi ${userName || ''},</p>
        <p>Your password has been changed.</p>
        <p class="muted"><strong>When:</strong> ${new Date().toLocaleString()}</p>
        <p class="muted">If you didn’t make this change, contact support immediately.</p>
      `
    });
    await sendEmail({ to, subject: 'Your ScheduleSync Password Was Changed', html });
    return true;
  } catch { return false; }
}

// Booking confirmation (guest)
async function sendBookingConfirmation(booking, team) {
  if (!resend) return false;
  try {
    const html = wrapBaseHtml({
      title: '📅 Booking Confirmed',
      body: `
        <p>Hi ${booking.guest_name || ''},</p>
        <p>Your booking with <strong>${team?.name || 'our team'}</strong> has been confirmed.</p>
        <p><strong>Date:</strong> ${booking.booking_date}</p>
        <p><strong>Time:</strong> ${booking.booking_time}</p>
        ${booking.meet_link ? `<p><strong>Meeting Link:</strong> <a href="${forcePublicBase(booking.meet_link)}">${forcePublicBase(booking.meet_link)}</a></p>` : ''}
        ${booking.guest_notes ? `<p><strong>Notes:</strong> ${booking.guest_notes}</p>` : ''}
      `
    });
    await sendEmail({ to: booking.guest_email, subject: `Booking Confirmed: ${team?.name || ''}`, html });
    return true;
  } catch { return false; }
}

// Booking notification (owner)
async function sendBookingNotificationToOwner(booking, team, ownerEmail) {
  if (!resend) return false;
  try {
    const html = wrapBaseHtml({
      title: '🆕 New Booking',
      body: `
        <p>A new booking has been made for <strong>${team?.name || ''}</strong>.</p>
        <p><strong>Guest:</strong> ${booking.guest_name} (${booking.guest_email})</p>
        <p><strong>Date:</strong> ${booking.booking_date}</p>
        <p><strong>Time:</strong> ${booking.booking_time}</p>
        ${booking.guest_notes ? `<p><strong>Notes:</strong> ${booking.guest_notes}</p>` : ''}
      `
    });
    await sendEmail({ to: ownerEmail, subject: `New Booking: ${team?.name || ''}`, html });
    return true;
  } catch { return false; }
}

// Team invitation
async function sendTeamInvitation(email, teamName, inviteLink) {
  if (!resend) return false;
  try {
    const link = forcePublicBase(inviteLink);
    const html = wrapBaseHtml({
      title: '👋 Team Invitation',
      body: `
        <p>You've been invited to join <strong>${teamName}</strong> on ScheduleSync.</p>
        <p style="text-align:center;margin:20px 0;">
          <a href="${link}" class="button">Accept Invitation</a>
        </p>
        <p class="muted">Or copy this link:</p>
        <p class="link">${link}</p>
      `
    });
    await sendEmail({ to: email, subject: `You're invited to join ${teamName}`, html });
    return true;
  } catch { return false; }
}

// Team welcome
async function sendTeamWelcome(email, teamName) {
  if (!resend) return false;
  try {
    const html = wrapBaseHtml({
      title: `🎉 Welcome to ${teamName}!`,
      body: `<p>You've successfully joined <strong>${teamName}</strong> on ScheduleSync.</p>`
    });
    await sendEmail({ to: email, subject: `Welcome to ${teamName}!`, html });
    return true;
  } catch { return false; }
}

// Availability request (guest)
async function sendAvailabilityRequest(guestEmail, guestName, teamName, requestUrl) {
  if (!resend) return false;
  try {
    const url = forcePublicBase(requestUrl);
    const html = wrapBaseHtml({
      title: '📅 Meeting Request',
      body: `
        <p>Hi ${guestName || ''},</p>
        <p><strong>${teamName}</strong> would like to schedule a meeting with you.</p>
        <p>Please submit your availability:</p>
        <p style="text-align:center;margin:20px 0;">
          <a href="${url}" class="button">Submit Your Availability</a>
        </p>
        <p class="muted">Or copy this link:</p>
        <p class="link">${url}</p>
      `
    });
    await sendEmail({ to: guestEmail, subject: `Meeting Request from ${teamName}`, html });
    return true;
  } catch { return false; }
}

// Availability submitted (owner)
async function sendAvailabilitySubmitted(ownerEmail, ownerName, guestName, overlapCount) {
  if (!resend) return false;
  try {
    const html = wrapBaseHtml({
      title: '✅ Availability Received',
      body: `
        <p>Hi ${ownerName || ''},</p>
        <p><strong>${guestName}</strong> has submitted their availability.</p>
        <p style="background:#eef2ff;padding:14px;border-radius:8px;text-align:center;">
          <span style="font-size:32px;font-weight:700;color:#4f46e5;">${overlapCount}</span>
          <span style="display:block;color:#6b7280;">matching time slot${overlapCount===1?'':'s'} found</span>
        </p>
        <p>Open your ScheduleSync dashboard to review and book the final time.</p>
      `
    });
    await sendEmail({ to: ownerEmail, subject: `${guestName} submitted their availability`, html });
    return true;
  } catch { return false; }
}

module.exports = {
  sendEmail,
  sendPasswordReset,
  sendPasswordChanged,
  sendBookingConfirmation,
  sendBookingNotificationToOwner,
  sendTeamInvitation,
  sendTeamWelcome,
  sendAvailabilityRequest,
  sendAvailabilitySubmitted,
};
