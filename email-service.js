// email-service.js - Email notification service using Resend API

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

// Send booking confirmation to guest
async function sendBookingConfirmation(booking, team) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px 20px; text-align: center; }
        .header h1 { margin: 0; font-size: 32px; }
        .content { background: #f9f9f9; padding: 30px 20px; }
        .booking-details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .detail-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #eee; }
        .detail-row:last-child { border-bottom: none; }
        .label { font-weight: bold; color: #667eea; }
        .value { text-align: right; }
        .button { display: inline-block; background: #667eea; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        .footer { text-align: center; color: #999; font-size: 13px; padding: 20px; }
        .emoji { font-size: 48px; margin-bottom: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="emoji">⚡</div>
          <h1>Booking Confirmed!</h1>
        </div>
        <div class="content">
          <p style="font-size: 16px;">Hi <strong>${booking.guest_name}</strong>,</p>
          <p>Your meeting with <strong>${team.name}</strong> has been successfully confirmed.</p>
          
          <div class="booking-details">
            <h2 style="margin-top: 0; color: #667eea;">Booking Details</h2>
            <div class="detail-row">
              <span class="label">Team</span>
              <span class="value">${team.name}</span>
            </div>
            <div class="detail-row">
              <span class="label">Date</span>
              <span class="value">${booking.booking_date ? new Date(booking.booking_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD'}</span>
            </div>
            <div class="detail-row">
              <span class="label">Time</span>
              <span class="value">${booking.booking_time || 'TBD'}</span>
            </div>
            <div class="detail-row">
              <span class="label">Status</span>
              <span class="value" style="color: #22c55e; font-weight: bold;">${booking.status}</span>
            </div>
            <div class="detail-row">
              <span class="label">Booking ID</span>
              <span class="value">#${booking.id}</span>
            </div>
          </div>

          ${booking.guest_notes ? `
            <div class="booking-details">
              <h3 style="margin-top: 0; color: #667eea;">Your Notes</h3>
              <p style="margin: 0;">${booking.guest_notes}</p>
            </div>
          ` : ''}

          <p style="font-size: 16px;">We look forward to meeting with you!</p>
          
          <div style="text-align: center;">
            <a href="${APP_URL}/booking/${booking.id}" class="button">View Booking Details</a>
          </div>

          <div class="footer">
            <p>This is an automated message from <strong>ScheduleSync</strong></p>
            <p>If you need to reschedule or cancel, please contact us directly.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmail(
    booking.guest_email,
    `Booking Confirmed - ${team.name}`,
    html
  );
}

// Send booking notification to team owner
async function sendBookingNotificationToOwner(booking, team, ownerEmail) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px 20px; text-align: center; }
        .header h1 { margin: 0; font-size: 32px; }
        .content { background: #f9f9f9; padding: 30px 20px; }
        .alert { background: #fff3cd; border-left: 4px solid #ffc107; padding: 16px; margin: 20px 0; border-radius: 6px; }
        .alert strong { color: #856404; }
        .booking-details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .detail-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #eee; }
        .detail-row:last-child { border-bottom: none; }
        .label { font-weight: bold; color: #667eea; }
        .value { text-align: right; }
        .button { display: inline-block; background: #667eea; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; margin: 20px 0; }
        .footer { text-align: center; color: #999; font-size: 13px; padding: 20px; }
        .emoji { font-size: 48px; margin-bottom: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="emoji">📅</div>
          <h1>New Booking Received!</h1>
        </div>
        <div class="content">
          <div class="alert">
            <strong>Action Required:</strong> You have a new booking for ${team.name}
          </div>
          
          <div class="booking-details">
            <h2 style="margin-top: 0; color: #667eea;">Guest Information</h2>
            <div class="detail-row">
              <span class="label">Name</span>
              <span class="value">${booking.guest_name}</span>
            </div>
            <div class="detail-row">
              <span class="label">Email</span>
              <span class="value">${booking.guest_email}</span>
            </div>
            <div class="detail-row">
              <span class="label">Date</span>
              <span class="value">${booking.booking_date ? new Date(booking.booking_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD'}</span>
            </div>
            <div class="detail-row">
              <span class="label">Time</span>
              <span class="value">${booking.booking_time || 'TBD'}</span>
            </div>
            <div class="detail-row">
              <span class="label">Status</span>
              <span class="value" style="color: #22c55e; font-weight: bold;">${booking.status}</span>
            </div>
          </div>

          ${booking.guest_notes ? `
            <div class="booking-details">
              <h3 style="margin-top: 0; color: #667eea;">Guest Notes</h3>
              <p style="margin: 0;">${booking.guest_notes}</p>
            </div>
          ` : ''}

          <div style="text-align: center;">
            <a href="${APP_URL}/dashboard" class="button">View in Dashboard</a>
          </div>

          <div class="footer">
            <p>This is an automated notification from <strong>ScheduleSync</strong></p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmail(
    ownerEmail,
    `New Booking - ${team.name}`,
    html
  );
}

// Send reminder email
async function sendBookingReminder(booking, team) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px 20px; text-align: center; }
        .header h1 { margin: 0; font-size: 32px; }
        .content { background: #f9f9f9; padding: 30px 20px; }
        .reminder-box { background: #fff3cd; border-left: 4px solid #ffc107; padding: 20px; margin: 20px 0; border-radius: 6px; }
        .booking-details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .detail-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #eee; }
        .detail-row:last-child { border-bottom: none; }
        .label { font-weight: bold; color: #667eea; }
        .value { text-align: right; }
        .footer { text-align: center; color: #999; font-size: 13px; padding: 20px; }
        .emoji { font-size: 48px; margin-bottom: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="emoji">⏰</div>
          <h1>Meeting Reminder</h1>
        </div>
        <div class="content">
          <div class="reminder-box">
            <h2 style="margin-top: 0;">Your meeting is coming up soon!</h2>
            <p style="margin-bottom: 0;">This is a friendly reminder about your upcoming meeting.</p>
          </div>
          
          <div class="booking-details">
            <div class="detail-row">
              <span class="label">Team</span>
              <span class="value">${team.name}</span>
            </div>
            <div class="detail-row">
              <span class="label">Date</span>
              <span class="value">${booking.booking_date ? new Date(booking.booking_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD'}</span>
            </div>
            <div class="detail-row">
              <span class="label">Time</span>
              <span class="value">${booking.booking_time || 'TBD'}</span>
            </div>
          </div>

          <p style="font-size: 16px;">We look forward to seeing you!</p>

          <div class="footer">
            <p>This is an automated reminder from <strong>ScheduleSync</strong></p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmail(
    booking.guest_email,
    `Reminder: Upcoming Meeting - ${team.name}`,
    html
  );
}

module.exports = {
  sendBookingConfirmation,
  sendBookingNotificationToOwner,
  sendBookingReminder
};