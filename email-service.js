const { Resend } = require('resend');

// Resend configuration
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';

let resend = null;

// Initialize Resend
if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log('✅ Resend email service configured');
} else {
  console.log('ℹ️  Email not configured (missing RESEND_API_KEY)');
}

// Send password reset email
async function sendPasswordReset(to, userName, resetLink) {
  if (!resend) {
    console.log('⚠️  Email service not available');
    return false;
  }

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: to,
      subject: 'Reset Your ScheduleSync Password',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
            .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white !important; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px; }
            .link { color: #667eea; word-break: break-all; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0;">🔒 Reset Your Password</h1>
            </div>
            <div class="content">
              <p>Hi ${userName},</p>
              <p>We received a request to reset your password for your ScheduleSync account.</p>
              <p>Click the button below to reset your password:</p>
              <div style="text-align: center;">
                <a href="${resetLink}" class="button">Reset Password</a>
              </div>
              <p>Or copy and paste this link into your browser:</p>
              <p class="link">${resetLink}</p>
              <p style="margin-top: 30px; color: #6b7280; font-size: 14px;">
                <strong>This link will expire in 1 hour.</strong>
              </p>
              <p style="color: #6b7280; font-size: 14px;">
                If you didn't request this, you can safely ignore this email. Your password will not be changed.
              </p>
            </div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} ScheduleSync. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    console.log('✅ Password reset email sent to:', to);
    return true;
  } catch (error) {
    console.error('❌ Failed to send password reset email:', error.message);
    return false;
  }
}
// Generic email sending function
// Generic email sending function
async function sendEmail({ to, subject, html }) {
  if (!resend) {
    console.log('⚠️  Email service not available');
    return false;
  }

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: to,
      subject: subject,
      html: html
    });
    
    console.log('✅ Email sent to:', to);
    return true;
  } catch (error) {
    console.error('❌ Failed to send email:', error);
    throw error;
  }
}

// Send password changed confirmation
async function sendPasswordChanged(to, userName) {
  if (!resend) {
    console.log('⚠️  Email service not available');
    return false;
  }

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: to,
      subject: 'Your ScheduleSync Password Was Changed',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
            .success-icon { font-size: 48px; text-align: center; margin-bottom: 20px; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0;">✅ Password Changed Successfully</h1>
            </div>
            <div class="content">
              <div class="success-icon">🔐</div>
              <p>Hi ${userName},</p>
              <p>Your password for your ScheduleSync account has been successfully changed.</p>
              <p><strong>When:</strong> ${new Date().toLocaleString()}</p>
              <p style="margin-top: 30px; padding: 15px; background: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                <strong>⚠️ Didn't make this change?</strong><br>
                If you didn't change your password, please contact support immediately and secure your account.
              </p>
              <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">
                For security, you can now sign in with your new password.
              </p>
            </div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} ScheduleSync. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    console.log('✅ Password changed confirmation sent to:', to);
    return true;
  } catch (error) {
    console.error('❌ Failed to send password changed email:', error.message);
    return false;
  }
}

// Send booking confirmation
async function sendBookingConfirmation(booking, team) {
  if (!resend) {
    console.log('⚠️  Email service not available');
    return false;
  }

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: booking.guest_email,
      subject: `Booking Confirmed: ${team.name}`,
      html: `
        <h2>Your booking is confirmed!</h2>
        <p>Hi ${booking.guest_name},</p>
        <p>Your booking with <strong>${team.name}</strong> has been confirmed.</p>
        <p><strong>Date:</strong> ${booking.booking_date}</p>
        <p><strong>Time:</strong> ${booking.booking_time}</p>
        ${booking.meet_link ? `<p><strong>Meeting Link:</strong> <a href="${booking.meet_link}">${booking.meet_link}</a></p>` : ''}
        ${booking.guest_notes ? `<p><strong>Notes:</strong> ${booking.guest_notes}</p>` : ''}
        <p>Thank you for using ScheduleSync!</p>
      `
    });

    return true;
  } catch (error) {
    console.error('Failed to send booking confirmation:', error);
    return false;
  }
}

// Send booking notification to team owner
async function sendBookingNotificationToOwner(booking, team, ownerEmail) {
  if (!resend) return false;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: ownerEmail,
      subject: `New Booking: ${team.name}`,
      html: `
        <h2>New booking received!</h2>
        <p>A new booking has been made for <strong>${team.name}</strong>.</p>
        <p><strong>Guest:</strong> ${booking.guest_name} (${booking.guest_email})</p>
        <p><strong>Date:</strong> ${booking.booking_date}</p>
        <p><strong>Time:</strong> ${booking.booking_time}</p>
        ${booking.guest_notes ? `<p><strong>Notes:</strong> ${booking.guest_notes}</p>` : ''}
      `
    });

    return true;
  } catch (error) {
    console.error('Failed to send owner notification:', error);
    return false;
  }
}

// Send team invitation
async function sendTeamInvitation(email, teamName, inviteLink) {
  if (!resend) return false;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: `You're invited to join ${teamName}`,
      html: `
        <h2>Team Invitation</h2>
        <p>You've been invited to join <strong>${teamName}</strong> on ScheduleSync.</p>
        <p><a href="${inviteLink}">Click here to accept the invitation</a></p>
      `
    });

    return true;
  } catch (error) {
    console.error('Failed to send team invitation:', error);
    return false;
  }
}

// Send team welcome
async function sendTeamWelcome(email, teamName) {
  if (!resend) return false;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: `Welcome to ${teamName}!`,
      html: `
        <h2>Welcome!</h2>
        <p>You've successfully joined <strong>${teamName}</strong> on ScheduleSync.</p>
      `
    });

    return true;
  } catch (error) {
    console.error('Failed to send welcome email:', error);
    return false;
  }
}

// ============================================================================
// NEW: 2-Way Availability Request Functions
// ============================================================================

// Send availability request to guest
async function sendAvailabilityRequest(guestEmail, guestName, teamName, requestUrl) {
  if (!resend) {
    console.log('⚠️  Email service not available');
    return false;
  }

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: guestEmail,
      subject: `Meeting Request from ${teamName}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
            .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white !important; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px; }
            .link { color: #667eea; word-break: break-all; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0;">📅 Meeting Request</h1>
            </div>
            <div class="content">
              <p>Hi ${guestName},</p>
              <p><strong>${teamName}</strong> would like to schedule a meeting with you.</p>
              <p>To find a time that works for both of you, please submit your availability using the link below:</p>
              <div style="text-align: center;">
                <a href="${requestUrl}" class="button">Submit Your Availability</a>
              </div>
              <p>Or copy and paste this link into your browser:</p>
              <p class="link">${requestUrl}</p>
              <p style="margin-top: 30px; color: #6b7280; font-size: 14px;">
                This will help us find time slots that work for everyone.
              </p>
            </div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} ScheduleSync. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    console.log('✅ Availability request email sent to:', guestEmail);
    return true;
  } catch (error) {
    console.error('❌ Failed to send availability request email:', error.message);
    return false;
  }
}

// Send availability submitted notification to owner
async function sendAvailabilitySubmitted(ownerEmail, ownerName, guestName, overlapCount) {
  if (!resend) {
    console.log('⚠️  Email service not available');
    return false;
  }

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: ownerEmail,
      subject: `${guestName} submitted their availability`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px; }
            .highlight { background: #e0e7ff; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; }
            .count { color: #667eea; font-size: 48px; font-weight: bold; margin: 0; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0;">✅ Availability Received</h1>
            </div>
            <div class="content">
              <p>Hi ${ownerName},</p>
              <p><strong>${guestName}</strong> has submitted their availability.</p>
              <div class="highlight">
                <p class="count">${overlapCount}</p>
                <p style="margin: 5px 0 0 0; color: #4b5563;">matching time slot${overlapCount !== 1 ? 's' : ''} found</p>
              </div>
              <p>Log in to your ScheduleSync dashboard to view the available times and book the final meeting.</p>
              <p style="margin-top: 30px; color: #6b7280; font-size: 14px;">
                The system has automatically found times when both you and ${guestName} are available.
              </p>
            </div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} ScheduleSync. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    console.log('✅ Availability submitted notification sent to:', ownerEmail);
    return true;
  } catch (error) {
    console.error('❌ Failed to send availability submitted notification:', error.message);
    return false;
  }
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
  sendAvailabilitySubmitted
};