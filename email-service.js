// email-service-enhanced.js - Complete email service with team invitations

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const APP_URL = process.env.APP_URL || 'https://schedulesync-production.up.railway.app';

// Check if Resend is configured
function isConfigured() {
  if (!RESEND_API_KEY) {
    console.warn('⚠️  Resend not configured. Set RESEND_API_KEY in environment variables.');
    return false;
  }
  return true;
}

// Send email using Resend API
async function sendEmail(to, subject, html) {
  if (!isConfigured()) {
    return { success: false, error: 'Resend not configured' };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject: subject,
        html: html
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Resend API error:', data);
      return { success: false, error: data.message || 'Failed to send email' };
    }

    console.log(`✅ Email sent to ${to} via Resend`);
    return { success: true, id: data.id };
  } catch (error) {
    console.error('❌ Error sending email:', error);
    return { success: false, error: error.message };
  }
}

// Email template wrapper
function emailTemplate(title, emoji, content) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px 20px; text-align: center; }
        .header h1 { margin: 0; font-size: 32px; }
        .emoji { font-size: 48px; margin-bottom: 10px; }
        .content { background: #f9f9f9; padding: 30px 20px; }
        .card { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .button { display: inline-block; background: #667eea; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; margin: 20px 0; font-weight: bold; }
        .button-secondary { background: #6b7280; }
        .button-danger { background: #ef4444; }
        .footer { text-align: center; color: #999; font-size: 13px; padding: 20px; }
        .alert { background: #fff3cd; border-left: 4px solid #ffc107; padding: 16px; margin: 20px 0; border-radius: 6px; }
        .success { background: #d1fae5; border-left: 4px solid #10b981; }
        .info { background: #dbeafe; border-left: 4px solid #3b82f6; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="emoji">${emoji}</div>
          <h1>${title}</h1>
        </div>
        <div class="content">
          ${content}
          <div class="footer">
            <p>This is an automated message from <strong>ScheduleSync</strong></p>
            <p>© ${new Date().getFullYear()} ScheduleSync. All rights reserved.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
}

// ============================================================================
// TEAM INVITATION EMAILS
// ============================================================================

// Send team invitation
async function sendTeamInvitation(inviteeEmail, inviteeName, teamName, inviterName, teamId) {
  const content = `
    <p style="font-size: 16px;">Hi ${inviteeName || 'there'},</p>
    <p><strong>${inviterName}</strong> has invited you to join the team <strong>${teamName}</strong> on ScheduleSync!</p>
    
    <div class="card info">
      <h3 style="margin-top: 0; color: #3b82f6;">What is ScheduleSync?</h3>
      <p style="margin-bottom: 0;">ScheduleSync is a powerful scheduling platform that helps teams manage their availability and bookings efficiently.</p>
    </div>

    <div class="card">
      <h3 style="margin-top: 0; color: #667eea;">Team Details</h3>
      <p><strong>Team Name:</strong> ${teamName}</p>
      <p><strong>Invited By:</strong> ${inviterName}</p>
      <p style="margin-bottom: 0;"><strong>Your Role:</strong> Team Member</p>
    </div>

    <div style="text-align: center;">
      <a href="${APP_URL}/login?join_team=${teamId}" class="button">Accept Invitation</a>
      <br>
      <a href="${APP_URL}/signup?join_team=${teamId}" class="button button-secondary">Sign Up & Join</a>
    </div>

    <p style="font-size: 14px; color: #666; margin-top: 30px;">
      <strong>What happens next?</strong><br>
      1. Click the button above to accept<br>
      2. Log in or create an account<br>
      3. Start collaborating with your team!
    </p>
  `;

  return await sendEmail(
    inviteeEmail,
    `You're invited to join ${teamName} on ScheduleSync!`,
    emailTemplate(`Team Invitation`, '👥', content)
  );
}

// Send team member welcome email (after they join)
async function sendTeamWelcome(memberEmail, memberName, teamName, teamOwner) {
  const content = `
    <p style="font-size: 16px;">Welcome, <strong>${memberName}</strong>! 🎉</p>
    <p>You've successfully joined <strong>${teamName}</strong>.</p>
    
    <div class="card success">
      <h3 style="margin-top: 0; color: #10b981;">You're all set!</h3>
      <p style="margin-bottom: 0;">You can now manage your availability, view bookings, and collaborate with your team.</p>
    </div>

    <div class="card">
      <h3 style="margin-top: 0; color: #667eea;">Quick Start Guide</h3>
      <p><strong>1. Set Your Availability</strong><br>
      Go to the Availability page and mark when you're free for meetings.</p>
      
      <p><strong>2. View Team Bookings</strong><br>
      Check the dashboard to see all upcoming team bookings.</p>
      
      <p><strong>3. Share Your Link</strong><br>
      Get your team's public booking link and share it with clients.</p>
    </div>

    <div style="text-align: center;">
      <a href="${APP_URL}/dashboard" class="button">Go to Dashboard</a>
      <br>
      <a href="${APP_URL}/availability" class="button button-secondary">Set Availability</a>
    </div>

    <p style="font-size: 14px; color: #666;">
      <strong>Team Owner:</strong> ${teamOwner}<br>
      If you have questions, reach out to your team owner.
    </p>
  `;

  return await sendEmail(
    memberEmail,
    `Welcome to ${teamName}!`,
    emailTemplate(`Welcome to the Team!`, '🎉', content)
  );
}

// Send member removed notification
async function sendMemberRemovedNotification(memberEmail, memberName, teamName, reason) {
  const content = `
    <p style="font-size: 16px;">Hi ${memberName},</p>
    <p>You have been removed from the team <strong>${teamName}</strong>.</p>
    
    <div class="card">
      <h3 style="margin-top: 0; color: #ef4444;">Account Status</h3>
      <p><strong>Team:</strong> ${teamName}</p>
      <p><strong>Status:</strong> Removed</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
    </div>

    <p>You will no longer have access to this team's:</p>
    <ul>
      <li>Bookings and schedules</li>
      <li>Team availability calendar</li>
      <li>Team settings and members</li>
    </ul>

    <p>If you believe this was a mistake, please contact the team owner.</p>

    <div style="text-align: center;">
      <a href="${APP_URL}/dashboard" class="button button-secondary">View Your Teams</a>
    </div>
  `;

  return await sendEmail(
    memberEmail,
    `Removed from ${teamName}`,
    emailTemplate(`Team Update`, '👋', content)
  );
}

// Send team deleted notification to all members
async function sendTeamDeletedNotification(memberEmail, memberName, teamName, deletedBy) {
  const content = `
    <p style="font-size: 16px;">Hi ${memberName},</p>
    <p>The team <strong>${teamName}</strong> has been deleted by ${deletedBy}.</p>
    
    <div class="card alert">
      <h3 style="margin-top: 0;">Team Deleted</h3>
      <p style="margin-bottom: 0;">This team and all its data have been permanently removed from ScheduleSync.</p>
    </div>

    <div class="card">
      <p><strong>What this means:</strong></p>
      <ul style="margin: 10px 0;">
        <li>All team bookings have been cancelled</li>
        <li>Team availability is no longer accessible</li>
        <li>The public booking link is inactive</li>
        <li>Team data has been removed</li>
      </ul>
    </div>

    <p>If you have any questions, please contact ${deletedBy}.</p>

    <div style="text-align: center;">
      <a href="${APP_URL}/dashboard" class="button button-secondary">View Your Other Teams</a>
    </div>
  `;

  return await sendEmail(
    memberEmail,
    `Team Deleted: ${teamName}`,
    emailTemplate(`Team Deleted`, '🗑️', content)
  );
}

// ============================================================================
// BOOKING EMAILS
// ============================================================================

// Send booking confirmation to guest
async function sendBookingConfirmation(booking, team) {
  const content = `
    <p style="font-size: 16px;">Hi <strong>${booking.guest_name}</strong>,</p>
    <p>Your meeting with <strong>${team.name}</strong> has been successfully confirmed.</p>
    
    <div class="card success">
      <h2 style="margin-top: 0; color: #10b981;">✓ Booking Confirmed</h2>
    </div>

    <div class="card">
      <h3 style="margin-top: 0; color: #667eea;">Booking Details</h3>
      <p><strong>Team:</strong> ${team.name}</p>
      <p><strong>Date:</strong> ${booking.booking_date ? new Date(booking.booking_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD'}</p>
      <p><strong>Time:</strong> ${booking.booking_time || 'TBD'}</p>
      <p><strong>Status:</strong> <span style="color: #22c55e; font-weight: bold;">${booking.status}</span></p>
      <p><strong>Booking ID:</strong> #${booking.id}</p>
    </div>

    ${booking.guest_notes ? `
      <div class="card">
        <h3 style="margin-top: 0; color: #667eea;">Your Notes</h3>
        <p style="margin: 0;">${booking.guest_notes}</p>
      </div>
    ` : ''}

    <p style="font-size: 16px;">We look forward to meeting with you!</p>
    
    <div style="text-align: center;">
      <a href="${APP_URL}/booking/${booking.id}" class="button">View Booking Details</a>
    </div>
  `;

  return await sendEmail(
    booking.guest_email,
    `Booking Confirmed - ${team.name}`,
    emailTemplate('Booking Confirmed!', '⚡', content)
  );
}

// Send booking notification to team owner
async function sendBookingNotificationToOwner(booking, team, ownerEmail) {
  const content = `
    <div class="alert">
      <strong>Action Required:</strong> You have a new booking for ${team.name}
    </div>
    
    <div class="card">
      <h2 style="margin-top: 0; color: #667eea;">Guest Information</h2>
      <p><strong>Name:</strong> ${booking.guest_name}</p>
      <p><strong>Email:</strong> ${booking.guest_email}</p>
      <p><strong>Date:</strong> ${booking.booking_date ? new Date(booking.booking_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD'}</p>
      <p><strong>Time:</strong> ${booking.booking_time || 'TBD'}</p>
      <p><strong>Status:</strong> <span style="color: #22c55e; font-weight: bold;">${booking.status}</span></p>
    </div>

    ${booking.guest_notes ? `
      <div class="card">
        <h3 style="margin-top: 0; color: #667eea;">Guest Notes</h3>
        <p style="margin: 0;">${booking.guest_notes}</p>
      </div>
    ` : ''}

    <div style="text-align: center;">
      <a href="${APP_URL}/dashboard" class="button">View in Dashboard</a>
    </div>
  `;

  return await sendEmail(
    ownerEmail,
    `New Booking - ${team.name}`,
    emailTemplate('New Booking Received!', '📅', content)
  );
}

// Send booking cancellation to guest
async function sendBookingCancellation(booking, team, reason) {
  const content = `
    <p style="font-size: 16px;">Hi ${booking.guest_name},</p>
    <p>Your booking with <strong>${team.name}</strong> has been cancelled.</p>
    
    <div class="card alert">
      <h3 style="margin-top: 0;">Booking Cancelled</h3>
      <p style="margin-bottom: 0;">This booking is no longer active.</p>
    </div>

    <div class="card">
      <h3 style="margin-top: 0; color: #667eea;">Booking Details</h3>
      <p><strong>Team:</strong> ${team.name}</p>
      <p><strong>Date:</strong> ${booking.booking_date ? new Date(booking.booking_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD'}</p>
      <p><strong>Time:</strong> ${booking.booking_time || 'TBD'}</p>
      <p><strong>Booking ID:</strong> #${booking.id}</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
    </div>

    <p>If you'd like to reschedule, you can book a new time using the link below.</p>

    <div style="text-align: center;">
      <a href="${APP_URL}/book/${team.id}" class="button">Book New Time</a>
    </div>
  `;

  return await sendEmail(
    booking.guest_email,
    `Booking Cancelled - ${team.name}`,
    emailTemplate('Booking Cancelled', '❌', content)
  );
}

// Send booking reminder
async function sendBookingReminder(booking, team) {
  const content = `
    <div class="card alert">
      <h2 style="margin-top: 0;">Your meeting is coming up soon!</h2>
      <p style="margin-bottom: 0;">This is a friendly reminder about your upcoming meeting.</p>
    </div>
    
    <div class="card">
      <h3 style="margin-top: 0; color: #667eea;">Meeting Details</h3>
      <p><strong>Team:</strong> ${team.name}</p>
      <p><strong>Date:</strong> ${booking.booking_date ? new Date(booking.booking_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD'}</p>
      <p><strong>Time:</strong> ${booking.booking_time || 'TBD'}</p>
    </div>

    <p style="font-size: 16px;">We look forward to seeing you!</p>

    <div style="text-align: center;">
      <a href="${APP_URL}/booking/${booking.id}" class="button">View Details</a>
    </div>
  `;

  return await sendEmail(
    booking.guest_email,
    `Reminder: Upcoming Meeting - ${team.name}`,
    emailTemplate('Meeting Reminder', '⏰', content)
  );
}

module.exports = {
  // Team emails
  sendTeamInvitation,
  sendTeamWelcome,
  sendMemberRemovedNotification,
  sendTeamDeletedNotification,
  
  // Booking emails
  sendBookingConfirmation,
  sendBookingNotificationToOwner,
  sendBookingCancellation,
  sendBookingReminder
};