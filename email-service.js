// email-service.js — clean Resend service with forced Railway base
// -----------------------------------------------------------------------------

const { Resend } = require('resend');

// Config ----------------------------------------------------------------------
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';
const PUBLIC_BASE_URL =
  process.env.APP_URL || 'https://schedulesync-production.up.railway.app';

// State -----------------------------------------------------------------------
let resend = null;
if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log('✅ Resend email service configured');
} else {
  console.log('ℹ️  Email not configured (missing RESEND_API_KEY)');
}

// URL helpers -----------------------------------------------------------------
function forcePublicBase(url) {
  try {
    const u = new URL(String(url || ''));
    const base = new URL(PUBLIC_BASE_URL);
    u.protocol = base.protocol;
    u.host = base.host;
    return u.toString();
  } catch {
    // Fallback: replace origin in a plain string
    return String(url || '').replace(/^https?:\/\/[^/]+/i, PUBLIC_BASE_URL);
  }
}

function rewriteLinksToPublicBase(html) {
  const safeBase = PUBLIC_BASE_URL.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const legacy = /https?:\/\/(?:www\.)?trucal\.xyz/gi;
  const genericOrigin = /^https?:\/\/[^/]+/i;

  let out = String(html || '');

  // 1) Replace any hardcoded legacy domain
  out = out.replace(legacy, PUBLIC_BASE_URL);
  // 2) (Optional) If templates forgot to pass normalized URLs, normalize common link attributes
  out = out.replace(/href="([^"]+)"/gi, (_, href) => `href="${forcePublicBase(href)}"`);
  out = out.replace(/>https?:\/\/[^<]+</gi, (txt) => `>${txt.slice(1, -1).replace(genericOrigin, PUBLIC_BASE_URL)}<`);

  return out;
}

// Core sender -----------------------------------------------------------------
async function sendEmail({ to, subject, html }) {
  if (!resend) {
    console.log('⚠️  Email service not available');
    return false;
  }
  try {
    const safeHtml = rewriteLinksToPublicBase(html);
    await resend.emails.send({ from: EMAIL_FROM, to, subject, html: safeHtml });
    console.log('✅ Email sent to:', to);
    return true;
  } catch (error) {
    console.error('❌ Failed to send email:', error);
    throw error;
  }
}

// Templates -------------------------------------------------------------------
function wrapBaseHtml({ title, body }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title || 'ScheduleSync'}</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #111827; background:#ffffff; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 28px; text-align: center; border-radius: 12px 12px 0 0; }
    .content { background: #f9fafb; padding: 28px; border-radius: 0 0 12px 12px; }
    .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white !important; padding: 12px 22px; text-decoration: none; border-radius: 8px; font-weight: 600; }
    .muted { color: #6b7280; font-size: 13px; }
    .footer { text-align: center; margin-top: 18px; color: #6b7280; font-size: 13px; }
    code, .link { color: #4f46e5; word-break: break-all; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin:0;">${title || 'ScheduleSync'}</h1>
    </div>
    <div class="content">
      ${body}
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} ScheduleSync. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;
}

// Public API ------------------------------------------------------------------

// Password reset
async function sendPasswordReset(to, userName, resetLink) {
  if (!resend) { console.log('⚠️  Email service not available'); return false; }
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
        <p class="muted">If you didn't request this, you can safely ignore this email.</p>
      `
    });
    await sendEmail({ to, subject: 'Reset Your ScheduleSync Password', html });
    console.log('✅ Password reset email →', finalLink);
    return true;
  } catch (error) {
    console.error('❌ Failed to send password reset email:', error.message);
    return false;
  }
}

// Password changed
async function sendPasswordChanged(to, userName) {
  if (!resend) { console.log('⚠️  Email service not available'); return false; }
  try {
    const html = wrapBaseHtml({
      title: '✅ Password Changed Successfully',
      body: `
        <p>Hi ${userName || ''},</p>
        <p>Your password has been changed.</p>
        <p class="muted"><strong>When:</strong> ${new Date().toLocaleString()}</p>
        <p class="muted" style="margin-top: 16px;">
          If you didn’t make this change, please contact support and secure your account immediately.
        </p>
      `
    });
    await sendEmail({ to, subject: 'Your ScheduleSync Password Was Changed', html });
    return true;
  } catch (error) {
    console.error('❌ Failed to send password changed email:', error.message);
    return false;
  }
}

// Booking confirmation (to guest)
async function sendBookingConfirmation(booking, team) {
  if (!resend) { console.log('⚠️  Email service not available'); return false; }
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
        <p>Thanks for using ScheduleSync!</p>
      `
    });
    await sendEmail({ to: booking.guest_email, subject: `Booking Confirmed: ${team?.name || ''}`, html });
    return true;
  } catch (error) {
    console.error('❌ Failed to send booking confirmation:', error);
    return false;
  }
}

// Booking notification (to owner)
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
  } catch (error) {
    console.error('❌ Failed to send owner notification:', error);
    return false;
  }
}

// Team invitation
async function sendTeamInvitation(email, teamName, inviteLink) {
  if (!resend) return false;
  try {
    const finalLink = forcePublicBase(inviteLink);
    const html = wrapBaseHtml({
      title: '👋 Team Invitation',
      body: `
        <p>You've been invited to join <strong>${teamName}</strong> on ScheduleSync.</p>
        <p style="text-align:center;margin:20px 0;">
          <a href="${finalLink}" class="button">Accept Invitation</a>
        </p>
        <p class="muted">Or copy this link:</p>
        <p class="link">${finalLink}</p>
      `
    });
    await sendEmail({ to: email, subject: `You're invited to join ${teamName}`, html });
    console.log('✅ Team invitation →', finalLink);
    return true;
  } catch (error) {
    console.error('❌ Failed to send team invitation:', error);
    return false;
  }
}

// Team welcome
async function sendTeamWelcome(email, teamName) {
  if (!resend) return false;
  try {
    const html = wrapBaseHtml({
      title: `🎉 Welcome to ${teamName}!`,
      body: `
        <p>You've successfully joined <strong>${teamName}</strong> on ScheduleSync.</p>
        <p>We’re happy to have you on board!</p>
      `
    });
    await sendEmail({ to: email, subject: `Welcome to ${teamName}!`, html });
    return true;
  } catch (error) {
    console.error('❌ Failed to send welcome email:', error);
    return false;
  }
}

// Availability request (to guest)
async function sendAvailabilityRequest(guestEmail, guestName, teamName, requestUrl) {
  if (!resend) { console.log('⚠️  Email service not available'); return false; }
  try {
    const finalUrl = forcePublicBase(requestUrl);
    const html = wrapBaseHtml({
      title: '📅 Meeting Request',
      body: `
        <p>Hi ${guestName || ''},</p>
        <p><strong>${teamName}</strong> would like to schedule a meeting with you.</p>
        <p>Please submit your availability:</p>
        <p style="text-align:center;margin:20px 0;">
          <a href="${finalUrl}" class="button">Submit Your Availability</a>
        </p>
        <p class="muted">Or copy this link:</p>
        <p class="link">${finalUrl}</p>
      `
    });
    await sendEmail({ to: guestEmail, subject: `Meeting Request from ${teamName}`, html });
    console.log('✅ Availability request →', finalUrl);
    return true;
  } catch (error) {
    console.error('❌ Failed to send availability request email:', error.message);
    return false;
  }
}

// Availability submitted (to owner)
async function sendAvailabilitySubmitted(ownerEmail, ownerName, guestName, overlapCount) {
  if (!resend) { console.log('⚠️  Email service not available'); return false; }
  try {
    const html = wrapBaseHtml({
      title: '✅ Availability Received',
      body: `
        <p>Hi ${ownerName || ''},</p>
        <p><strong>${guestName}</strong> has submitted their availability.</p>
        <p style="background:#eef2ff;padding:14px;border-radius:8px;text-align:center;">
          <span style="font-size:32px;font-weight:700;color:#4f46e5;">${overlapCount}</span>
          <span style="display:block;color:#6b7280;">matching time slot${overlapCount === 1 ? '' : 's'} found</span>
        </p>
        <p>Open your ScheduleSync dashboard to review and book the final time.</p>
      `
    });
    await sendEmail({ to: ownerEmail, subject: `${guestName} submitted their availability`, html });
    return true;
  } catch (error) {
    console.error('❌ Failed to send availability submitted notification:', error.message);
    return false;
  }
}

// Exports ---------------------------------------------------------------------
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
