// ScheduleSync - Clean Production Server
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const path = require('path');

// ========================
// CONFIGURATION
// ========================

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'schedulesync-dev-secret-2025';
const DATABASE_URL = process.env.DATABASE_URL;
const NODE_ENV = process.env.NODE_ENV || 'development';

console.log('🚀 ScheduleSync Server Starting');
console.log(`📡 PORT: ${PORT}`);
console.log(`🔗 DATABASE_URL: ${DATABASE_URL ? 'SET' : 'NOT SET'}`);
console.log(`🔐 JWT_SECRET: ${JWT_SECRET ? 'SET' : 'NOT SET'}`);

// ========================
// DATABASE
// ========================

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
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
    console.error('❌ Database error:', err);
  });
} else {
  console.error('❌ DATABASE_URL not set!');
}

// ========================
// EMAIL SETUP
// ========================

const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || '';
const EMAIL_SERVICE = process.env.EMAIL_SERVICE || 'gmail';
const APP_URL = process.env.APP_URL || 'https://schedulesync-production.up.railway.app';

let transporter = null;
let emailEnabled = false;

console.log('📧 Email Configuration:');
console.log('  USER:', EMAIL_USER ? 'SET' : 'NOT SET');
console.log('  PASSWORD:', EMAIL_PASSWORD ? 'SET' : 'NOT SET');
console.log('  SERVICE:', EMAIL_SERVICE);

if (EMAIL_USER && EMAIL_PASSWORD) {
  try {
    transporter = nodemailer.createTransport({
      service: EMAIL_SERVICE,
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASSWORD
      }
    });
    emailEnabled = true;
    console.log('✅ Email transporter created');
  } catch (e) {
    console.warn('⚠️ Email transporter error:', e.message);
  }
} else {
  console.warn('⚠️ Email not configured - no credentials provided');
}

// Email helper function
async function sendEmail(to, subject, html) {
  if (!emailEnabled || !transporter) {
    console.log('📧 Email skipped (not configured):', to);
    return false;
  }

  try {
    const info = await transporter.sendMail({
      from: `ScheduleSync <${EMAIL_USER}>`,
      to,
      subject,
      html
    });
    console.log(`✅ Email sent to ${to} (ID: ${info.messageId})`);
    return true;
  } catch (error) {
    console.error(`❌ Email error for ${to}:`, error.message);
    return false;
  }
}

// Email templates
function getTeamInviteEmail(inviteeEmail, inviterName, teamName) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">ScheduleSync</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
        <h2 style="color: #1a202c;">Welcome to ${teamName}!</h2>
        <p style="color: #4a5568; font-size: 16px;">Hi ${inviteeEmail.split('@')[0]},</p>
        <p style="color: #4a5568; font-size: 16px;"><strong>${inviterName}</strong> has invited you to join <strong>${teamName}</strong> on ScheduleSync.</p>
        <p style="color: #4a5568; margin-top: 20px;">You can now access the team management dashboard and start scheduling meetings.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${APP_URL}/dashboard" style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Go to Dashboard</a>
        </div>
      </div>
    </div>
  `;
}

function getBookingConfirmationEmail(guestName, teamName, slotStart, slotEnd, meetingLink) {
  const start = new Date(slotStart);
  const end = new Date(slotEnd);
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">Booking Confirmed</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
        <h2 style="color: #1a202c;">Thank you, ${guestName}!</h2>
        <p style="color: #4a5568;">Your booking with <strong>${teamName}</strong> has been confirmed.</p>
        <div style="background: white; border-left: 4px solid #667eea; padding: 20px; margin: 20px 0;">
          <p style="margin: 0 0 10px 0;"><strong>Date & Time:</strong> ${start.toLocaleDateString()} at ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
          <p style="margin: 0 0 10px 0;"><strong>Duration:</strong> ${Math.round((end - start) / 60000)} minutes</p>
          <p style="margin: 0 0 10px 0;"><strong>Team:</strong> ${teamName}</p>
          ${meetingLink ? `<p style="margin: 0;"><strong>Meeting Link:</strong> <a href="${meetingLink}">${meetingLink}</a></p>` : ''}
        </div>
        <p style="color: #4a5568; font-size: 14px;">Check your email for additional details.</p>
      </div>
    </div>
  `;
}

function getBookingCancellationEmail(guestName, teamName, slotStart) {
  const start = new Date(slotStart);
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #f87171 0%, #dc2626 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">Booking Cancelled</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
        <p style="color: #4a5568; font-size: 16px;">Hi ${guestName},</p>
        <p style="color: #4a5568; font-size: 16px;">Your booking with <strong>${teamName}</strong> has been cancelled.</p>
        <div style="background: white; border-left: 4px solid #dc2626; padding: 20px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Original Date & Time:</strong> ${start.toLocaleDateString()} at ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
        </div>
        <p style="color: #4a5568;">If you need to reschedule, please visit the booking page to select a new time.</p>
      </div>
    </div>
  `;
}

function getNewBookingNotificationEmail(memberName, guestName, teamName, slotStart, slotEnd) {
  const start = new Date(slotStart);
  const end = new Date(slotEnd);
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">New Booking</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
        <h2 style="color: #1a202c;">Hi ${memberName},</h2>
        <p style="color: #4a5568; font-size: 16px;"><strong>${guestName}</strong> has booked a meeting with your team <strong>${teamName}</strong>.</p>
        <div style="background: white; border-left: 4px solid #10b981; padding: 20px; margin: 20px 0;">
          <p style="margin: 0 0 10px 0;"><strong>Guest:</strong> ${guestName}</p>
          <p style="margin: 0 0 10px 0;"><strong>Date & Time:</strong> ${start.toLocaleDateString()} at ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
          <p style="margin: 0;"><strong>Duration:</strong> ${Math.round((end - start) / 60000)} minutes</p>
        </div>
        <div style="text-align: center; margin: 20px 0;">
          <a href="${APP_URL}/dashboard" style="background: #10b981; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">View Booking</a>
        </div>
      </div>
    </div>
  `;
}

// ========================
// MIDDLEWARE
// ========================

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    console.error('JWT verification failed:', error.message);
    return res.status(401).json({ error: 'Invalid token: ' + error.message });
  }
};

// ========================
// STATIC FILES
// ========================

app.use(express.static(path.join(__dirname, 'public')));

// ========================
// HEALTH & INFO
// ========================

app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  
  if (pool) {
    try {
      await pool.query('SELECT NOW()');
      dbStatus = 'connected';
    } catch (e) {
      dbStatus = 'error';
    }
  }

  res.json({
    status: 'ok',
    database: dbStatus,
    environment: NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

// ========================
// AUTH ENDPOINTS
// ========================

app.post('/api/auth/register', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const { email, name, extensionId } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    let user;
    if (existing.rows.length > 0) {
      user = existing.rows[0];
      if (extensionId) {
        await pool.query('UPDATE users SET extension_id = $1 WHERE id = $2', [extensionId, user.id]);
      }
    } else {
      const result = await pool.query(
        'INSERT INTO users (email, name, extension_id) VALUES ($1, $2, $3) RETURNING *',
        [email, name || email.split('@')[0], extensionId || null]
      );
      user = result.rows[0];
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      }
    });
  } catch (error) {
    console.error('Register error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// TEAM ENDPOINTS
// ========================

app.post('/api/teams', authenticate, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const { name, schedulingMode } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Team name is required' });
    }

    const publicUrl = name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();

    const result = await pool.query(
      `INSERT INTO teams (name, created_by, public_url, scheduling_mode, is_active, created_at)
       VALUES ($1, $2, $3, $4, true, NOW())
       RETURNING *`,
      [name, req.userId, publicUrl, schedulingMode || 'round_robin']
    );

    const team = result.rows[0];

    await pool.query(
      `INSERT INTO team_members (team_id, user_id, role, joined_at)
       VALUES ($1, $2, $3, NOW())`,
      [team.id, req.userId, 'admin']
    );

    console.log(`✅ Team created: ${team.name}`);
    res.json({ success: true, team });
  } catch (error) {
    console.error('Create team error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/teams', authenticate, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const result = await pool.query(
      `SELECT t.*, tm.role, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
       FROM teams t
       JOIN team_members tm ON t.id = tm.team_id
       WHERE tm.user_id = $1
       ORDER BY t.created_at DESC`,
      [req.userId]
    );

    res.json({ teams: result.rows });
  } catch (error) {
    console.error('Get teams error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/teams/:teamId', authenticate, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const { teamId } = req.params;

    const memberCheck = await pool.query(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, req.userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a team member' });
    }

    const teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [teamId]);
    const team = teamResult.rows[0];

    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email, tm.role, tm.booking_count, tm.joined_at
       FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1
       ORDER BY tm.joined_at`,
      [teamId]
    );

    res.json({ team, members: membersResult.rows, userRole: memberCheck.rows[0].role });
  } catch (error) {
    console.error('Get team error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/teams/:teamId/members', authenticate, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const { teamId } = req.params;
    const { userId, role } = req.body;

    const adminCheck = await pool.query(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, req.userId]
    );

    if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can add members' });
    }

    await pool.query(
      `INSERT INTO team_members (team_id, user_id, role, joined_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [teamId, userId, role || 'member']
    );

    console.log(`✅ Member ${userId} added to team ${teamId}`);
    
    // Send email in background (don't wait for it)
    setImmediate(async () => {
      try {
        const teamResult = await pool.query('SELECT name FROM teams WHERE id = $1', [teamId]);
        const inviterResult = await pool.query('SELECT name FROM users WHERE id = $1', [req.userId]);
        const inviteeResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);

        const teamName = teamResult.rows[0]?.name || 'Team';
        const inviterName = inviterResult.rows[0]?.name || 'Team Admin';
        const inviteeEmail = inviteeResult.rows[0]?.email;

        if (inviteeEmail) {
          const emailHtml = getTeamInviteEmail(inviteeEmail, inviterName, teamName);
          await sendEmail(inviteeEmail, `You've been invited to join ${teamName} on ScheduleSync`, emailHtml);
        }
      } catch (emailError) {
        console.error('Background email send error:', emailError.message);
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Add member error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/teams/:teamId/members/:userId', authenticate, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const { teamId, userId } = req.params;

    const adminCheck = await pool.query(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, req.userId]
    );

    if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can remove members' });
    }

    await pool.query(
      'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, userId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Remove member error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/teams/:teamId/members/:userId/role', authenticate, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const { teamId, userId } = req.params;
    const { role } = req.body;

    if (!['admin', 'member', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const adminCheck = await pool.query(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, req.userId]
    );

    if (adminCheck.rows.length === 0 || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can change roles' });
    }

    const result = await pool.query(
      `UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3 RETURNING *`,
      [role, teamId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    res.json({ success: true, member: result.rows[0] });
  } catch (error) {
    console.error('Update role error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// BOOKING ENDPOINTS
// ========================

app.get('/api/booking/team/:publicUrl', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const { publicUrl } = req.params;

    const teamResult = await pool.query(
      'SELECT id, name, description, scheduling_mode FROM teams WHERE public_url = $1 AND is_active = true',
      [publicUrl]
    );

    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const team = teamResult.rows[0];

    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1 AND tm.role IN ('admin', 'member')`,
      [team.id]
    );

    res.json({
      team: {
        id: team.id,
        name: team.name,
        description: team.description,
        schedulingMode: team.scheduling_mode,
        members: membersResult.rows
      }
    });
  } catch (error) {
    console.error('Get booking team error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/booking/availability/:teamId', async (req, res) => {
  try {
    const slots = [];
    const now = new Date();
    
    for (let i = 1; i <= 10; i++) {
      const start = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      start.setHours(9, 0, 0, 0);
      
      if (start.getDay() >= 1 && start.getDay() <= 5) {
        const end = new Date(start.getTime() + 30 * 60 * 1000);
        slots.push({ start: start.toISOString(), end: end.toISOString() });
      }
    }

    res.json({ availableSlots: slots });
  } catch (error) {
    console.error('Get availability error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/booking/create', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const { teamId, slotStart, slotEnd, guestEmail, guestName, description, notes, meetingLink } = req.body;

    if (!teamId || !slotStart || !slotEnd || !guestEmail || !guestName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await pool.query(
      `INSERT INTO bookings (team_id, slot_start, slot_end, guest_email, guest_name, description, notes, meeting_link, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
       RETURNING *`,
      [teamId, slotStart, slotEnd, guestEmail, guestName, description || null, notes || null, meetingLink || null]
    );

    const booking = result.rows[0];
    const confirmationToken = jwt.sign({ bookingId: booking.id }, JWT_SECRET, { expiresIn: '7d' });

    // Get team and member info
    const teamResult = await pool.query('SELECT name FROM teams WHERE id = $1', [teamId]);
    const teamName = teamResult.rows[0]?.name || 'Team';

    // Send booking confirmation email to guest
    const confirmationHtml = getBookingConfirmationEmail(guestName, teamName, slotStart, slotEnd, meetingLink);
    await sendEmail(guestEmail, `Booking Confirmed with ${teamName}`, confirmationHtml);

    console.log(`✅ Booking created: ${booking.id}`);
    res.json({ success: true, booking: { id: booking.id, confirmationToken } });
  } catch (error) {
    console.error('Create booking error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// BOOKING CANCELLATION
// ========================

app.post('/api/booking/cancel', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const { bookingId, cancelReason } = req.body;

    if (!bookingId) {
      return res.status(400).json({ error: 'Booking ID required' });
    }

    const bookingResult = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: 'Booking already cancelled' });
    }

    // Update booking status
    await pool.query(
      `UPDATE bookings SET status = $1, cancelled_at = NOW(), cancellation_reason = $2 WHERE id = $3`,
      ['cancelled', cancelReason || null, bookingId]
    );

    // Get team info
    const teamResult = await pool.query('SELECT name FROM teams WHERE id = $1', [booking.team_id]);
    const teamName = teamResult.rows[0]?.name || 'Team';

    // Send cancellation email to guest
    const cancellationHtml = getBookingCancellationEmail(booking.guest_name, teamName, booking.slot_start);
    await sendEmail(booking.guest_email, `Booking Cancelled with ${teamName}`, cancellationHtml);

    console.log(`✅ Booking cancelled: ${bookingId}`);
    res.json({ success: true, message: 'Booking cancelled successfully' });
  } catch (error) {
    console.error('Cancel booking error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// ANALYTICS
// ========================

app.get('/api/analytics/dashboard', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const users = await pool.query('SELECT COUNT(*) as count FROM users');
    const bookings = await pool.query('SELECT COUNT(*) as count FROM bookings');
    const connections = await pool.query('SELECT COUNT(*) as count FROM calendar_connections WHERE is_active = true');

    res.json({
      stats: {
        totalUsers: parseInt(users.rows[0].count),
        totalBookings: parseInt(bookings.rows[0].count),
        activeConnections: parseInt(connections.rows[0].count),
        cacheHitRate: 85
      }
    });
  } catch (error) {
    console.error('Analytics error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// MEMBER BOOKINGS
// ========================

app.get('/api/member/bookings', authenticate, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database unavailable' });

    const result = await pool.query(
      `SELECT b.*, t.name as team_name FROM bookings b
       JOIN teams t ON b.team_id = t.id
       WHERE b.assigned_member_id = $1 OR b.guest_email IN (SELECT email FROM users WHERE id = $1)
       ORDER BY b.slot_start DESC`,
      [req.userId]
    );

    res.json({ bookings: result.rows });
  } catch (error) {
    console.error('Get member bookings error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ========================
// PAGE ROUTES
// ========================

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/team-management', (req, res) => res.sendFile(path.join(__dirname, 'public', 'team-management.html')));
app.get('/booking.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'booking.html')));

// ========================
// ERROR HANDLING
// ========================

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

// ========================
// START SERVER
// ========================

app.listen(PORT, () => {
  console.log('');
  console.log('✅ ScheduleSync API Server Running');
  console.log(`📡 Listening on port ${PORT}`);
  console.log(`🌐 https://schedulesync-production.up.railway.app`);
  console.log('');
});