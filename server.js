// ========================
// SCHEDULESYNC - SERVER.JS
// Full-stack team scheduling platform backend
// ========================

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Resend } = require('resend');
const { google } = require('googleapis');
const path = require('path');
require('dotenv').config();

// ========================
// INITIALIZATION
// ========================

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Environment Variables
const JWT_SECRET = process.env.JWT_SECRET || 'schedulesync-dev-secret-2025';
const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || 'development';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'onboarding@resend.dev';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || `${APP_URL}/api/calendar/google/callback`;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MICROSOFT_CALLBACK_URL = process.env.MICROSOFT_CALLBACK_URL || `${APP_URL}/api/calendar/microsoft/callback`;

// Logging
console.log('🚀 ScheduleSync API Starting...');
console.log(`📡 Environment: ${NODE_ENV}`);
console.log(`🔗 App URL: ${APP_URL}`);
console.log(`📍 Port: ${PORT}`);
console.log(`📅 Google Calendar: ${GOOGLE_CLIENT_ID ? '✅ Configured' : '⚠️ Not configured'}`);
console.log(`📧 Microsoft Outlook: ${MICROSOFT_CLIENT_ID ? '✅ Configured' : '⚠️ Not configured'}`);

// ========================
// DATABASE SETUP
// ========================

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.query('SELECT NOW()', (err) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Database connected');
  }
});

pool.on('error', (err) => {
  console.error('❌ Database error:', err.message);
});

// ========================
// GOOGLE OAUTH SETUP
// ========================

let oauth2Client = null;

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_CALLBACK_URL
  );
  console.log('✅ Google OAuth client initialized');
}

// ========================
// MICROSOFT OAUTH SETUP
// ========================

let microsoftOAuthClient = null;

if (MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET) {
  microsoftOAuthClient = {
    clientId: MICROSOFT_CLIENT_ID,
    clientSecret: MICROSOFT_CLIENT_SECRET,
    authority: 'https://login.microsoftonline.com/common',
    redirectUri: MICROSOFT_CALLBACK_URL,
    scopes: ['https://graph.microsoft.com/Calendars.Read']
  };
  console.log('✅ Microsoft OAuth client initialized');
}

// ========================
// EMAIL SETUP
// ========================

let resend = null;
let emailEnabled = false;

if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  emailEnabled = true;
  console.log('✅ Resend email service configured');
} else {
  console.log('⚠️ Resend API key not configured (email disabled)');
}

// ========================
// EMAIL FUNCTIONS
// ========================

async function sendEmail(to, subject, html, text) {
  if (!emailEnabled) {
    console.log('📧 Email skipped (not configured):', to);
    return false;
  }

  try {
    console.log(`📧 Sending email to: ${to}`);
    await resend.emails.send({
      from: `ScheduleSync <${SENDER_EMAIL}>`,
      to,
      subject,
      html,
      text
    });
    console.log(`✅ Email sent to: ${to}`);
    return true;
  } catch (error) {
    console.error(`❌ Email failed for ${to}:`, error.message);
    return false;
  }
}

async function sendTeamInviteEmail(inviteeEmail, inviterName, teamName, teamId) {
  const joinLink = `${APP_URL}/join-team?teamId=${teamId}&email=${encodeURIComponent(inviteeEmail)}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 28px;">ScheduleSync</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
        <h2 style="color: #1a202c;">Welcome to ${teamName}!</h2>
        <p style="color: #4a5568; font-size: 16px;">Hi ${inviteeEmail.split('@')[0]},</p>
        <p style="color: #4a5568; font-size: 16px;"><strong>${inviterName}</strong> has invited you to join <strong>${teamName}</strong>.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${joinLink}" style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Join Team Now</a>
        </div>
      </div>
    </div>
  `;

  const text = `Welcome to ${teamName}!\n\n${inviterName} has invited you to join ${teamName}.\n\nJoin here: ${joinLink}`;

  return sendEmail(inviteeEmail, `You've been invited to join ${teamName} on ScheduleSync`, html, text);
}

async function sendBookingConfirmationEmail(guestEmail, guestName, teamName, meetingDetails) {
  const { date, time, duration, meetingLink, description } = meetingDetails;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">Booking Confirmed ✓</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
        <h2 style="color: #1a202c;">Thank you, ${guestName}!</h2>
        <div style="background: white; border-left: 4px solid #667eea; padding: 20px; margin: 20px 0;">
          <p style="margin: 0 0 10px 0;"><strong>Date & Time:</strong> ${date} at ${time}</p>
          <p style="margin: 0 0 10px 0;"><strong>Duration:</strong> ${duration} minutes</p>
          <p style="margin: 0 0 10px 0;"><strong>Team:</strong> ${teamName}</p>
          ${meetingLink ? `<p style="margin: 0;"><strong>Meeting:</strong> <a href="${meetingLink}">${meetingLink}</a></p>` : ''}
        </div>
        ${description ? `<p style="color: #4a5568;"><strong>Details:</strong> ${description}</p>` : ''}
      </div>
    </div>
  `;

  const text = `Booking Confirmed!\n\nDate: ${date} at ${time}\nDuration: ${duration} minutes\nTeam: ${teamName}`;

  return sendEmail(guestEmail, `Booking Confirmed: ${teamName} - ${date}`, html, text);
}

async function sendNewBookingNotificationEmail(memberEmail, memberName, guestName, teamName, meetingDetails) {
  const { date, time, duration } = meetingDetails;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">New Booking 📅</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
        <h2 style="color: #1a202c;">Hi ${memberName},</h2>
        <p style="color: #4a5568; font-size: 16px;"><strong>${guestName}</strong> has booked a meeting with your team <strong>${teamName}</strong>.</p>
        <div style="background: white; border-left: 4px solid #10b981; padding: 20px; margin: 20px 0;">
          <p style="margin: 0 0 10px 0;"><strong>Guest:</strong> ${guestName}</p>
          <p style="margin: 0 0 10px 0;"><strong>Date & Time:</strong> ${date} at ${time}</p>
          <p style="margin: 0 0 10px 0;"><strong>Duration:</strong> ${duration} minutes</p>
        </div>
      </div>
    </div>
  `;

  const text = `New Booking\n\n${guestName} has booked a meeting.\n\nDate: ${date} at ${time}\nDuration: ${duration} minutes`;

  return sendEmail(memberEmail, `New booking from ${guestName}`, html, text);
}

async function sendBookingCancellationEmail(guestEmail, guestName, teamName, meetingDetails) {
  const { date, time } = meetingDetails;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f87171 0%, #dc2626 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">Booking Cancelled</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
        <p style="color: #4a5568; font-size: 16px;">Hi ${guestName},</p>
        <p style="color: #4a5568; font-size: 16px;">Your booking with <strong>${teamName}</strong> has been cancelled.</p>
        <div style="background: white; border-left: 4px solid #dc2626; padding: 20px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Original Date & Time:</strong> ${date} at ${time}</p>
        </div>
      </div>
    </div>
  `;

  const text = `Booking Cancelled\n\nYour booking with ${teamName} on ${date} at ${time} has been cancelled.`;

  return sendEmail(guestEmail, `Booking Cancelled: ${teamName} - ${date}`, html, text);
}

// ========================
// MIDDLEWARE
// ========================

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ========================
// STATIC ROUTES & PAGES
// ========================

// Root - Landing page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>ScheduleSync - Team Scheduling Platform</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        .gradient-bg { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
      </style>
    </head>
    <body class="bg-gray-50">
      <nav class="gradient-bg text-white shadow-lg">
        <div class="max-w-6xl mx-auto px-6 py-6 flex justify-between items-center">
          <div class="flex items-center gap-2">
            <div class="text-3xl">📅</div>
            <div class="font-bold text-2xl">ScheduleSync</div>
          </div>
          <div class="flex gap-4">
            <a href="/login" class="px-6 py-2 bg-white/20 hover:bg-white/30 rounded-lg transition">Sign In</a>
            <a href="/booking" class="px-6 py-2 bg-white text-purple-600 rounded-lg font-semibold hover:bg-gray-100 transition">Book a Meeting</a>
          </div>
        </div>
      </nav>

      <div class="max-w-6xl mx-auto px-6 py-20">
        <div class="text-center mb-20">
          <h1 class="text-5xl font-bold text-gray-900 mb-6">Schedule Smarter with ScheduleSync</h1>
          <p class="text-xl text-gray-600 mb-8">Team scheduling made simple. Create teams, share booking links, manage meetings—all in one place.</p>
          <a href="/dashboard" class="inline-block px-8 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg font-semibold hover:shadow-lg transition">Get Started →</a>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div class="bg-white p-8 rounded-lg shadow-lg">
            <div class="text-4xl mb-4">👥</div>
            <h3 class="text-xl font-bold mb-2">Team Management</h3>
            <p class="text-gray-600">Create and manage unlimited teams with different scheduling modes.</p>
          </div>
          <div class="bg-white p-8 rounded-lg shadow-lg">
            <div class="text-4xl mb-4">📅</div>
            <h3 class="text-xl font-bold mb-2">Easy Booking</h3>
            <p class="text-gray-600">Share public booking links and let guests book meetings instantly.</p>
          </div>
          <div class="bg-white p-8 rounded-lg shadow-lg">
            <div class="text-4xl mb-4">📊</div>
            <h3 class="text-xl font-bold mb-2">Analytics</h3>
            <p class="text-gray-600">Track bookings, view trends, and optimize your scheduling.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Serve HTML pages from public folder
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/booking', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'booking.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/team-management', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'team-management.html'));
});



app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await pool.query(
      'INSERT INTO users (name, email, password, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id, name, email',
      [name, email, password]
    );

    const token = jwt.sign({ userId: result.rows[0].id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ success: true, token, user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await pool.query(
      'SELECT id, name, email FROM users WHERE email = $1 AND password = $2',
      [email, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: result.rows[0].id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ success: true, token, user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// GOOGLE CALENDAR ROUTES
// ========================

app.get('/api/calendar/google/auth', authenticate, (req, res) => {
  try {
    if (!oauth2Client) {
      return res.status(400).json({ error: 'Google Calendar not configured' });
    }

    const scopes = ['https://www.googleapis.com/auth/calendar.readonly'];

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent'
    });

    res.json({ url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calendar/google/callback', authenticate, async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'No authorization code' });
    }

    const { tokens } = await oauth2Client.getToken(code);

    await pool.query(
      `INSERT INTO calendar_connections (user_id, provider, access_token, refresh_token, token_expiry, is_active, created_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5), true, NOW())
       ON CONFLICT (user_id, provider) DO UPDATE SET
       access_token = $3, refresh_token = $4, token_expiry = to_timestamp($5), updated_at = NOW()`,
      [req.userId, 'google', tokens.access_token, tokens.refresh_token || null, tokens.expiry_date / 1000]
    );

    console.log(`✅ Google Calendar connected for user ${req.userId}`);
    res.redirect('/dashboard?calendar=connected');
  } catch (error) {
    console.error('Calendar callback error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calendar/connections', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, provider, is_active, created_at FROM calendar_connections WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );

    res.json({ connections: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/calendar/disconnect', authenticate, async (req, res) => {
  try {
    const { providerId } = req.body;

    await pool.query(
      'DELETE FROM calendar_connections WHERE id = $1 AND user_id = $2',
      [providerId, req.userId]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calendar/availability/:teamId', authenticate, async (req, res) => {
  try {
    const teamId = req.params.teamId;

    const membersResult = await pool.query(
      `SELECT u.id, u.email 
       FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1`,
      [teamId]
    );

    if (membersResult.rows.length === 0) {
      const slots = generateSampleSlots({ slot_duration: 30, max_slots: 20, work_start: 9, work_end: 17 });
      return res.json({ availableSlots: slots });
    }

    let busyTimes = [];

    for (const member of membersResult.rows) {
      // Check Google Calendar
      const googleCalResult = await pool.query(
        'SELECT access_token, token_expiry FROM calendar_connections WHERE user_id = $1 AND provider = $2 AND is_active = true',
        [member.id, 'google']
      );

      if (googleCalResult.rows.length > 0) {
        const calConnection = googleCalResult.rows[0];

        try {
          oauth2Client.setCredentials({
            access_token: calConnection.access_token,
            expiry_date: new Date(calConnection.token_expiry).getTime()
          });

          const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
          const now = new Date();
          const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

          const events = await calendar.events.list({
            calendarId: 'primary',
            timeMin: now.toISOString(),
            timeMax: thirtyDaysFromNow.toISOString(),
            singleEvents: true,
            orderBy: 'startTime'
          });

          events.data.items?.forEach(event => {
            if (event.start.dateTime && event.end.dateTime) {
              busyTimes.push({
                start: event.start.dateTime,
                end: event.end.dateTime,
                summary: event.summary
              });
            }
          });
        } catch (calError) {
          console.error(`Error fetching Google calendar for user ${member.id}:`, calError.message);
        }
      }

      // Check Microsoft Outlook Calendar
      const microsoftCalResult = await pool.query(
        'SELECT access_token, token_expiry FROM calendar_connections WHERE user_id = $1 AND provider = $2 AND is_active = true',
        [member.id, 'microsoft']
      );

      if (microsoftCalResult.rows.length > 0) {
        const calConnection = microsoftCalResult.rows[0];

        try {
          const now = new Date();
          const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

          const eventsResponse = await fetch(
            `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${now.toISOString()}&endDateTime=${thirtyDaysFromNow.toISOString()}`,
            {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${calConnection.access_token}`,
                'Content-Type': 'application/json'
              }
            }
          );

          if (eventsResponse.ok) {
            const data = await eventsResponse.json();
            data.value?.forEach(event => {
              if (event.start && event.end) {
                busyTimes.push({
                  start: event.start.dateTime,
                  end: event.end.dateTime,
                  summary: event.subject
                });
              }
            });
          }
        } catch (calError) {
          console.error(`Error fetching Microsoft calendar for user ${member.id}:`, calError.message);
        }
      }
    }

    const availableSlots = generateAvailableSlotsFromCalendar(busyTimes);
    res.json({ availableSlots });
  } catch (error) {
    console.error('Availability error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/teams/:teamId/calendar', authenticate, async (req, res) => {
  try {
    const { calendarConnectionId } = req.body;

    await pool.query(
      'UPDATE teams SET calendar_connection_id = $1 WHERE id = $2',
      [calendarConnectionId, req.params.teamId]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// MICROSOFT OUTLOOK CALENDAR ROUTES
// ========================

app.get('/api/calendar/microsoft/auth', authenticate, (req, res) => {
  try {
    if (!microsoftOAuthClient) {
      return res.status(400).json({ error: 'Microsoft Outlook not configured' });
    }

    const scopes = encodeURIComponent('https://graph.microsoft.com/Calendars.Read offline_access');
    const state = Buffer.from(JSON.stringify({ userId: req.userId })).toString('base64');
    
    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
      `client_id=${microsoftOAuthClient.clientId}` +
      `&redirect_uri=${encodeURIComponent(microsoftOAuthClient.redirectUri)}` +
      `&response_type=code` +
      `&scope=${scopes}` +
      `&state=${state}`;

    res.json({ url: authUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/calendar/microsoft/callback', authenticate, async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'No authorization code' });
    }

    // Exchange code for tokens
    const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: microsoftOAuthClient.clientId,
        client_secret: microsoftOAuthClient.clientSecret,
        code: code,
        redirect_uri: microsoftOAuthClient.redirectUri,
        grant_type: 'authorization_code',
        scope: 'https://graph.microsoft.com/Calendars.Read offline_access'
      })
    });

    if (!tokenResponse.ok) {
      throw new Error('Failed to exchange token');
    }

    const tokens = await tokenResponse.json();

    // Save to database
    await pool.query(
      `INSERT INTO calendar_connections (user_id, provider, access_token, refresh_token, token_expiry, is_active, created_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5), true, NOW())
       ON CONFLICT (user_id, provider) DO UPDATE SET
       access_token = $3, refresh_token = $4, token_expiry = to_timestamp($5), updated_at = NOW()`,
      [req.userId, 'microsoft', tokens.access_token, tokens.refresh_token || null, (Date.now() + tokens.expires_in * 1000) / 1000]
    );

    console.log(`✅ Microsoft Outlook connected for user ${req.userId}`);
    res.redirect('/dashboard?calendar=connected');
  } catch (error) {
    console.error('Microsoft callback error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// BOOKING ROUTES
// ========================

app.post('/api/booking/create', async (req, res) => {
  try {
    const { teamId, slotStart, slotEnd, guestEmail, guestName, notes } = req.body;

    const confirmationToken = Math.random().toString(36).substring(2, 15);

    const result = await pool.query(
      `INSERT INTO bookings (team_id, slot_start, slot_end, guest_email, guest_name, notes, status, confirmation_token, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW())
       RETURNING *`,
      [teamId, slotStart, slotEnd, guestEmail, guestName, notes || '', confirmationToken]
    );

    const booking = result.rows[0];

    // Get team info
    const teamResult = await pool.query('SELECT name FROM teams WHERE id = $1', [teamId]);
    const teamName = teamResult.rows[0]?.name || 'Our Team';

    // Send confirmation email to guest
    const meetingDetails = {
      date: new Date(slotStart).toLocaleDateString(),
      time: new Date(slotStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      duration: Math.round((new Date(slotEnd) - new Date(slotStart)) / 60000)
    };

    await sendBookingConfirmationEmail(guestEmail, guestName, teamName, meetingDetails);

    res.json({ success: true, booking });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/booking/team/:publicUrl', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email)) as members
       FROM teams t
       LEFT JOIN team_members tm ON t.id = tm.team_id
       LEFT JOIN users u ON tm.user_id = u.id
       WHERE t.public_url = $1 AND t.is_active = true
       GROUP BY t.id`,
      [req.params.publicUrl]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    res.json({ team: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/booking/availability/:teamId', async (req, res) => {
  try {
    const result = await pool.query('SELECT slot_duration, max_slots, work_start, work_end FROM teams WHERE id = $1', [req.params.teamId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const prefs = result.rows[0];
    const availableSlots = generateSampleSlots(prefs);

    res.json({ availableSlots });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/booking/cancel', async (req, res) => {
  try {
    const { bookingId, token, cancelReason } = req.body;

    const bookingResult = await pool.query(
      'SELECT * FROM bookings WHERE id = $1 AND confirmation_token = $2',
      [bookingId, token]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    await pool.query(
      'UPDATE bookings SET status = $1, cancelled_at = NOW() WHERE id = $2',
      ['cancelled', bookingId]
    );

    // Send cancellation email
    const teamResult = await pool.query('SELECT name FROM teams WHERE id = $1', [booking.team_id]);
    const teamName = teamResult.rows[0]?.name || 'Our Team';

    const meetingDetails = {
      date: new Date(booking.slot_start).toLocaleDateString(),
      time: new Date(booking.slot_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    await sendBookingCancellationEmail(booking.guest_email, booking.guest_name, teamName, meetingDetails);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// TEAMS ROUTES
// ========================

app.post('/api/teams', authenticate, async (req, res) => {
  try {
    const { name, schedulingMode, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Team name required' });
    }

    const publicUrl = name.toLowerCase().replace(/\s+/g, '-');

    const result = await pool.query(
      `INSERT INTO teams (name, description, created_by, public_url, scheduling_mode, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW())
       RETURNING *`,
      [name, description || '', req.userId, publicUrl, schedulingMode || 'one_on_one']
    );

    const team = result.rows[0];

    // Add creator as admin
    await pool.query(
      'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, $3, NOW())',
      [team.id, req.userId, 'admin']
    );

    res.json({ success: true, team });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/teams', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, tm.role,
        (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
       FROM teams t
       JOIN team_members tm ON t.id = tm.team_id
       WHERE tm.user_id = $1
       ORDER BY t.created_at DESC`,
      [req.userId]
    );

    res.json({ teams: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/teams/:teamId', authenticate, async (req, res) => {
  try {
    const teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [req.params.teamId]);

    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email, tm.role
       FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1`,
      [req.params.teamId]
    );

    res.json({ team: teamResult.rows[0], members: membersResult.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/teams/:teamId/members', authenticate, async (req, res) => {
  try {
    const { userId } = req.body;
    const teamId = req.params.teamId;

    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    // Add member to team
    await pool.query(
      `INSERT INTO team_members (team_id, user_id, role, joined_at)
       VALUES ($1, $2, 'member', NOW())
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [teamId, userId]
    );

    // Get team and user info for email
    const teamResult = await pool.query('SELECT name FROM teams WHERE id = $1', [teamId]);
    const userResult = await pool.query('SELECT email, name FROM users WHERE id = $1', [userId]);
    const inviterResult = await pool.query('SELECT name FROM users WHERE id = $1', [req.userId]);

    if (teamResult.rows[0] && userResult.rows[0]) {
      await sendTeamInviteEmail(
        userResult.rows[0].email,
        inviterResult.rows[0]?.name || 'A team member',
        teamResult.rows[0].name,
        teamId
      );
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/teams/:teamId/members/:userId', authenticate, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2',
      [req.params.teamId, req.params.userId]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// ANALYTICS ROUTES
// ========================

app.get('/api/analytics/dashboard', async (req, res) => {
  try {
    const usersResult = await pool.query('SELECT COUNT(*)::int as count FROM users');
    const bookingsResult = await pool.query('SELECT COUNT(*)::int as count FROM bookings');
    const confirmedResult = await pool.query('SELECT COUNT(*)::int as count FROM bookings WHERE status = $1', ['confirmed']);

    res.json({
      stats: {
        totalUsers: usersResult.rows[0].count,
        totalBookings: bookingsResult.rows[0].count,
        confirmedBookings: confirmedResult.rows[0].count,
        activeConnections: 0,
        cacheHitRate: 85
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/member/bookings', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, t.name as team_name
       FROM bookings b
       JOIN teams t ON b.team_id = t.id
       JOIN team_members tm ON t.id = tm.team_id
       WHERE tm.user_id = $1
       ORDER BY b.slot_start DESC`,
      [req.userId]
    );

    res.json({ bookings: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// HELPER FUNCTIONS
// ========================

function generateSampleSlots(prefs) {
  const slots = [];
  const now = new Date();
  const slotMs = (prefs.slot_duration || 30) * 60 * 1000;
  let current = new Date(Math.ceil(now.getTime() / slotMs) * slotMs);

  for (let i = 0; i < (prefs.max_slots || 10); i++) {
    const hour = current.getHours();
    const day = current.getDay();

    // Only weekdays (1-5) between work hours
    if (day >= 1 && day <= 5 && hour >= (prefs.work_start || 9) && hour < (prefs.work_end || 17)) {
      slots.push({
        start: current.toISOString(),
        end: new Date(current.getTime() + slotMs).toISOString()
      });
    }

    current = new Date(current.getTime() + slotMs);
  }

  return slots;
}

function generateAvailableSlotsFromCalendar(busyTimes) {
  const slots = [];
  const now = new Date();
  const slotDuration = 30;
  const slotMs = slotDuration * 60 * 1000;
  const workStart = 9;
  const workEnd = 17;

  let current = new Date(Math.ceil(now.getTime() / slotMs) * slotMs);
  const maxDays = 30;
  const maxSlots = 40;

  while (slots.length < maxSlots) {
    const hour = current.getHours();
    const day = current.getDay();
    const nextSlot = new Date(current.getTime() + slotMs);

    if (day >= 1 && day <= 5 && hour >= workStart && hour < workEnd) {
      const isAvailable = !busyTimes.some(busy => {
        const busyStart = new Date(busy.start);
        const busyEnd = new Date(busy.end);
        return (current < busyEnd && nextSlot > busyStart);
      });

      if (isAvailable) {
        slots.push({
          start: current.toISOString(),
          end: nextSlot.toISOString()
        });
      }
    }

    current = nextSlot;

    if (current.getTime() - now.getTime() > maxDays * 24 * 60 * 60 * 1000) {
      break;
    }
  }

  return slots;
}

// ========================
// ERROR HANDLING
// ========================

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ========================
// START SERVER
// ========================

app.listen(PORT, () => {
  console.log('');
  console.log('✅ ScheduleSync API Running');
  console.log(`📡 Listening on port ${PORT}`);
  console.log(`🌐 Visit http://localhost:${PORT}`);
  console.log('');
});

module.exports = app;