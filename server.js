// ScheduleSync Backend API - Clean Production Version
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ========================
// ENVIRONMENT VARIABLES
// ========================

const JWT_SECRET = process.env.JWT_SECRET || 'schedulesync-dev-secret-2025';
const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || 'development';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

console.log('🚀 ScheduleSync API Starting...');
console.log(`📡 Environment: ${NODE_ENV}`);
console.log(`🔗 App URL: ${APP_URL}`);
console.log(`📍 Port: ${PORT}`);

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
// EMAIL SETUP (SIMPLE)
// ========================

let transporter = null;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;

if (EMAIL_USER && EMAIL_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASSWORD
    }
  });
  console.log('✅ Email service configured');
} else {
  console.log('⚠️ Email not configured (optional)');
}

// ========================
// EMAIL QUEUE
// ========================

const emailQueue = [];
let emailWorkerRunning = false;

async function enqueueEmail(emailData, priority = 'normal') {
  if (!transporter) {
    console.log('📧 Email skipped (not configured):', emailData.to);
    return null;
  }

  const queueItem = {
    id: Date.now() + '-' + Math.random(),
    ...emailData,
    priority,
    createdAt: new Date(),
    retries: 0,
    maxRetries: 2,
    status: 'queued'
  };
  
  emailQueue.push(queueItem);
  
  if (!emailWorkerRunning) {
    startEmailWorker();
  }
  
  return queueItem.id;
}

function startEmailWorker() {
  if (emailWorkerRunning) return;
  emailWorkerRunning = true;
  
  const interval = setInterval(async () => {
    const readyEmails = emailQueue.filter(item => item.status === 'queued');
    
    for (const emailItem of readyEmails) {
      if (emailItem.status !== 'queued') continue;
      emailItem.status = 'sending';
      
      try {
        await transporter.sendMail(emailItem);
        emailItem.status = 'sent';
        console.log(`✅ Email sent to ${emailItem.to}`);
      } catch (error) {
        emailItem.retries++;
        
        if (emailItem.retries < emailItem.maxRetries) {
          emailItem.status = 'queued';
          console.warn(`⚠️ Email retry (${emailItem.retries}/${emailItem.maxRetries}): ${emailItem.to}`);
        } else {
          emailItem.status = 'failed';
          console.error(`❌ Email failed: ${emailItem.to}`);
        }
      }
    }
    
    if (emailQueue.length === 0) {
      clearInterval(interval);
      emailWorkerRunning = false;
    }
  }, 3000);
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
  if (!token) return res.status(401).json({ error: 'No token' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ========================
// STATIC FILES
// ========================

app.use(express.static(path.join(__dirname, 'public')));

// ========================
// HEALTH CHECK
// ========================

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM users');
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      database: 'connected',
      users: parseInt(result.rows[0].count)
    });
  } catch (error) {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

// ========================
// PAGES
// ========================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/team-management', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'team-management.html'));
});

app.get('/booking.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'booking.html'));
});

// ========================
// AUTH
// ========================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, name, extensionId } = req.body;
    
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user;
    
    if (existing.rows.length > 0) {
      user = existing.rows[0];
      await pool.query('UPDATE users SET extension_id = $1 WHERE id = $2', [extensionId, user.id]);
    } else {
      const result = await pool.query(
        'INSERT INTO users (email, name, extension_id) VALUES ($1, $2, $3) RETURNING *',
        [email, name, extensionId]
      );
      user = result.rows[0];
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========================
// CALENDAR
// ========================

app.post('/api/calendar/connect', authenticate, async (req, res) => {
  try {
    const { provider, accessToken, refreshToken, expiresAt } = req.body;
    
    await pool.query(`
      INSERT INTO calendar_connections (user_id, provider, access_token, refresh_token, expires_at, connected_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (user_id, provider) 
      DO UPDATE SET access_token = $3, refresh_token = $4, expires_at = $5
    `, [req.userId, provider, accessToken, refreshToken, expiresAt]);
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/connections', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT provider, connected_at, expires_at FROM calendar_connections WHERE user_id = $1',
      [req.userId]
    );
    res.json({ connections: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========================
// AVAILABILITY
// ========================

app.get('/api/availability', authenticate, async (req, res) => {
  try {
    const prefsResult = await pool.query(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [req.userId]
    );
    
    const prefs = prefsResult.rows[0] || {
      work_start: 9,
      work_end: 17,
      slot_duration: 30,
      max_slots: 10
    };
    
    const freeSlots = generateSampleSlots(prefs);
    res.json({ freeSlots, preferences: prefs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/preferences', authenticate, async (req, res) => {
  try {
    const { workStart, workEnd, slotDuration, maxSlots, bufferTime } = req.body;
    
    const result = await pool.query(`
      INSERT INTO user_preferences (user_id, work_start, work_end, slot_duration, max_slots, buffer_time)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id) 
      DO UPDATE SET work_start = $2, work_end = $3, slot_duration = $4, max_slots = $5, buffer_time = $6
      RETURNING *
    `, [req.userId, workStart, workEnd, slotDuration, maxSlots, bufferTime || 0]);
    
    res.json({ success: true, preferences: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========================
// PUBLIC BOOKING
// ========================

app.get('/api/booking/team/:publicUrl', async (req, res) => {
  try {
    const teamResult = await pool.query(
      'SELECT id, name, description, scheduling_mode FROM teams WHERE public_url = $1 AND is_active = true',
      [req.params.publicUrl]
    );
    
    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    const team = teamResult.rows[0];
    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email, tm.booking_count
       FROM team_members tm
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
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/booking/availability/:teamId', async (req, res) => {
  try {
    const { teamId } = req.params;
    
    const teamResult = await pool.query('SELECT scheduling_mode FROM teams WHERE id = $1', [teamId]);
    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    const membersResult = await pool.query(
      'SELECT user_id FROM team_members WHERE team_id = $1 AND role IN (\'admin\', \'member\')',
      [teamId]
    );
    
    if (membersResult.rows.length === 0) {
      return res.json({ availableSlots: [] });
    }
    
    const memberIds = membersResult.rows.map(m => m.user_id);
    const availableSlots = await findFirstAvailableSlots(memberIds);
    
    res.json({ availableSlots });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/booking/create', async (req, res) => {
  try {
    const { teamId, slotStart, slotEnd, guestEmail, guestName, notes } = req.body;
    
    if (!teamId || !slotStart || !slotEnd || !guestEmail || !guestName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [teamId]);
    const team = teamResult.rows[0];
    
    const membersResult = await pool.query(
      'SELECT user_id FROM team_members WHERE team_id = $1 LIMIT 1',
      [teamId]
    );
    
    const confirmationToken = jwt.sign(
      { bookingId: Date.now(), type: 'booking' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    const result = await pool.query(
      `INSERT INTO bookings (
        team_id, assigned_member_id, slot_start, slot_end,
        guest_email, guest_name, notes, status, confirmation_token, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       RETURNING *`,
      [teamId, membersResult.rows[0].user_id, slotStart, slotEnd, guestEmail, guestName, notes, 'pending', confirmationToken]
    );
    
    const booking = result.rows[0];
    console.log(`Booking created: ${booking.id}`);
    
    res.json({
      success: true,
      booking: {
        id: booking.id,
        confirmationToken,
        status: 'pending',
        cancelUrl: `${APP_URL}/booking.html?cancel=${confirmationToken}`
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/booking/cancel', async (req, res) => {
  try {
    const { bookingId, token } = req.body;
    
    if (!bookingId || !token) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    try {
      jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    const bookingResult = await pool.query(
      'SELECT * FROM bookings WHERE id = $1 AND confirmation_token = $2',
      [bookingId, token]
    );
    
    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    await pool.query(
      'UPDATE bookings SET status = $1, cancelled_at = NOW() WHERE id = $2',
      ['cancelled', bookingId]
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// TEAMS
// ========================

app.post('/api/teams', authenticate, async (req, res) => {
  try {
    const { name, schedulingMode } = req.body;
    
    const result = await pool.query(
      `INSERT INTO teams (name, created_by, public_url, scheduling_mode, is_active, created_at)
       VALUES ($1, $2, $3, $4, true, NOW())
       RETURNING *`,
      [name, req.userId, name.toLowerCase().replace(/\s+/g, '-'), schedulingMode]
    );
    
    const team = result.rows[0];
    await pool.query(
      `INSERT INTO team_members (team_id, user_id, role, joined_at)
       VALUES ($1, $2, 'admin', NOW())`,
      [team.id, req.userId]
    );
    
    res.json({ success: true, team });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/teams', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, tm.role, 
        (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
       FROM teams t
       JOIN team_members tm ON t.id = tm.team_id
       WHERE tm.user_id = $1`,
      [req.userId]
    );
    res.json({ teams: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/teams/:teamId', authenticate, async (req, res) => {
  try {
    const teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [req.params.teamId]);
    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email, tm.role FROM team_members tm
       JOIN users u ON tm.user_id = u.id WHERE tm.team_id = $1`,
      [req.params.teamId]
    );
    
    res.json({ team: teamResult.rows[0], members: membersResult.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/teams/:teamId/members', authenticate, async (req, res) => {
  try {
    const { userId } = req.body;
    
    await pool.query(
      `INSERT INTO team_members (team_id, user_id, role, joined_at)
       VALUES ($1, $2, 'member', NOW())
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [req.params.teamId, userId]
    );
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/teams/:teamId/members/:userId', authenticate, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2',
      [req.params.teamId, req.params.userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========================
// ANALYTICS
// ========================

app.get('/api/analytics/dashboard', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) as count FROM users');
    const bookings = await pool.query('SELECT COUNT(*) as count FROM bookings');
    
    res.json({
      stats: {
        totalUsers: parseInt(users.rows[0].count),
        totalBookings: parseInt(bookings.rows[0].count),
        activeConnections: 0,
        cacheHitRate: 85
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/member/bookings', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, t.name as team_name FROM bookings b
       JOIN teams t ON b.team_id = t.id
       WHERE b.assigned_member_id = $1 ORDER BY b.slot_start DESC`,
      [req.userId]
    );
    res.json({ bookings: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========================
// HELPERS
// ========================

function generateSampleSlots(prefs) {
  const slots = [];
  const now = new Date();
  const slotMs = (prefs.slot_duration || 30) * 60 * 1000;
  let current = new Date(Math.ceil(now.getTime() / slotMs) * slotMs);
  
  for (let i = 0; i < (prefs.max_slots || 10); i++) {
    const hour = current.getHours();
    const day = current.getDay();
    
    if (day >= 1 && day <= 5 && hour >= (prefs.work_start || 9) && hour < (prefs.work_end || 17)) {
      slots.push({ start: current.toISOString(), end: new Date(current.getTime() + slotMs).toISOString() });
    }
    current = new Date(current.getTime() + slotMs);
  }
  
  return slots;
}

async function findFirstAvailableSlots(memberIds) {
  const slots = [];
  for (const id of memberIds) {
    slots.push(...generateSampleSlots({}));
  }
  return slots.slice(0, 20);
}

// ========================
// ERROR HANDLING
// ========================

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// ========================
// START SERVER
// ========================

app.listen(PORT, () => {
  console.log('');
  console.log('✅ ScheduleSync API running');
  console.log(`📡 Listening on port ${PORT}`);
  console.log('');
});