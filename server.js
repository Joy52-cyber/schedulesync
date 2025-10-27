// server.js — ScheduleSync (cleaned with fixes)
// -----------------------------------------------------------------------------
// Loads env, initializes DB, defines routes (auth, teams, members, availability
// requests), and starts the server with graceful shutdown. Optional Google OAuth
// is supported if google-auth-service.js is present.
// -----------------------------------------------------------------------------

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

// ----------------------------------------------------------------------------
// Optional modules
// ----------------------------------------------------------------------------
let emailService = null;
try {
  emailService = require('./email-service');
  console.log('✅ Email service loaded');
} catch {
  console.log('ℹ️  Email service not found — emails disabled');
}

let googleAuth = null;
try {
  googleAuth = require('./google-auth-service');
  console.log('✅ Google Auth service loaded');
} catch {
  console.log('⚠️  Google Auth service not found — OAuth disabled');
}

// ----------------------------------------------------------------------------
// Config and helpers
// ----------------------------------------------------------------------------
const clean = (v) => (v || '').toString().trim();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = clean(process.env.JWT_SECRET) || 'schedulesync-secret-2025';

// DB: prefer DB_CONNECTION_STRING, fall back to DATABASE_URL
const connectionString = process.env.DB_CONNECTION_STRING || process.env.DATABASE_URL;
console.log('🔍 DB Connection:', connectionString ? connectionString.substring(0, 90) + '…' : '❌ none');

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Utility: parse date+time to SQL timestamps (UTC) for 60-min meetings by default
function parseDateAndTimeToTimestamp(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const parts = String(timeStr).trim().split(/\s+/);
  let h, m;
  if (parts.length >= 2) {
    const [hm, ampmRaw] = parts;
    const [hRaw, mRaw = '0'] = hm.split(':');
    h = parseInt(hRaw, 10);
    m = parseInt(mRaw, 10);
    const ampm = (ampmRaw || '').toUpperCase();
    if (isNaN(h) || isNaN(m)) return null;
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
  } else {
    const [hRaw, mRaw = '0'] = timeStr.split(':');
    h = parseInt(hRaw, 10);
    m = parseInt(mRaw, 10);
    if (isNaN(h) || isNaN(m)) return null;
  }
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const start = new Date(`${dateStr}T${hh}:${mm}:00Z`);
  if (isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 60 * 60000);
  const fmt = (d) => {
    const yyyy = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const HH = String(d.getUTCHours()).padStart(2, '0');
    const MM = String(d.getUTCMinutes()).padStart(2, '0');
    const SS = String(d.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}-${mo}-${dd} ${HH}:${MM}:${SS}`;
  };
  return { start: fmt(start), end: fmt(end) };
}

// ----------------------------------------------------------------------------
// App & middleware
// ----------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ----------------------------------------------------------------------------
// Health & status
// ----------------------------------------------------------------------------
app.get('/health', (_req, res) => res.status(200).json({ status: 'healthy' }));
app.get('/api/status', async (_req, res) => {
  const dbOk = await pool.query('SELECT 1').then(() => true).catch(() => false);
  res.json({ status: 'ScheduleSync API Running', config: { google: !!googleAuth, database: dbOk } });
});

// ----------------------------------------------------------------------------
// DB bootstrap (idempotent migrations)
// ----------------------------------------------------------------------------
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255),
      google_id VARCHAR(255) UNIQUE,
      google_access_token TEXT,
      google_refresh_token TEXT,
      default_calendar_id VARCHAR(255),
      profile_picture TEXT,
      timezone VARCHAR(100) DEFAULT 'UTC',
      working_hours JSONB DEFAULT '{}'::jsonb,
      booking_preferences JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      owner_id INTEGER REFERENCES users(id),
      public_url VARCHAR(255) UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(50) DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(team_id, user_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS time_slots (
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_of_week INTEGER,
      start_time TIME,
      end_time TIME,
      is_available BOOLEAN DEFAULT true,
      slot_start TIMESTAMP,
      slot_end TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      slot_id INTEGER REFERENCES time_slots(id) ON DELETE SET NULL,
      guest_name VARCHAR(255) NOT NULL,
      guest_email VARCHAR(255) NOT NULL,
      guest_notes TEXT,
      booking_date DATE,
      booking_time VARCHAR(50),
      slot_start TIMESTAMP,
      slot_end TIMESTAMP,
      calendar_event_id VARCHAR(255),
      meet_link TEXT,
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS availability_requests (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      guest_name VARCHAR(255) NOT NULL,
      guest_email VARCHAR(255) NOT NULL,
      guest_notes TEXT,
      token VARCHAR(255) UNIQUE NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      booked_date DATE,
      booked_time VARCHAR(50),
      booking_id INTEGER REFERENCES bookings(id),
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guest_availability_slots (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES availability_requests(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL
    )`);
}

(async () => {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');
    await initDatabase();
    console.log('✅ Database schema ready');
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
})();

// ----------------------------------------------------------------------------
// Auth helpers
// ----------------------------------------------------------------------------
function authenticateToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ----------------------------------------------------------------------------
// Basic auth (email/password)
// ----------------------------------------------------------------------------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
    const hashed = await bcrypt.hash(password, 10);
    const out = await pool.query(
      'INSERT INTO users (name,email,password) VALUES ($1,$2,$3) RETURNING id,name,email',
      [name, email, hashed]
    );
    const token = jwt.sign({ userId: out.rows[0].id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ success: true, token, user: out.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const out = await pool.query('SELECT id,name,email,password FROM users WHERE email=$1', [email]);
    if (!out.rowCount) return res.status(401).json({ error: 'No account found with this email address', type: 'email_not_found' });
    const user = out.rows[0];
    let passwordValid = false;
    if (user.password?.startsWith('$2b$')) passwordValid = await bcrypt.compare(password, user.password);
    else passwordValid = user.password === password; // legacy plain text
    if (!passwordValid) return res.status(401).json({ error: 'Incorrect password', type: 'wrong_password' });

    if (!user.password?.startsWith('$2b$')) {
      const hashed = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hashed, user.id]);
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/users/me', authenticateToken, async (req, res) => {
  const out = await pool.query('SELECT id,name,email,profile_picture,default_calendar_id FROM users WHERE id=$1', [req.userId]);
  if (!out.rowCount) return res.status(404).json({ error: 'User not found' });
  res.json({ user: out.rows[0] });
});

// ----------------------------------------------------------------------------
// Teams & Members
// ----------------------------------------------------------------------------
app.post('/api/teams', authenticateToken, async (req, res) => {
  try {
    const { name, description } = req.body || {};
    const result = await pool.query(
      `INSERT INTO teams (name, description, owner_id, public_url)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, description || '', req.userId, Math.random().toString(36).slice(2)]
    );

    // Optional: ensure owner appears in members list
    await pool.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT DO NOTHING`,
      [result.rows[0].id, req.userId]
    );

    res.status(201).json({ team: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create team' });
  }
});

// List teams the current user can access (owner OR member)
app.get('/api/teams', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    const { rows } = await pool.query(
      `
      SELECT
        t.*,
        u.name  AS owner_name,
        u.email AS owner_email,
        COUNT(tm2.id) AS member_count,
        CASE WHEN t.owner_id = $1 THEN true ELSE false END AS is_owner,
        COALESCE((
          SELECT role FROM team_members tm
          WHERE tm.team_id = t.id AND tm.user_id = $1
          LIMIT 1
        ), CASE WHEN t.owner_id = $1 THEN 'owner' ELSE NULL END) AS my_role
      FROM teams t
      JOIN users u ON u.id = t.owner_id
      LEFT JOIN team_members tm2 ON tm2.team_id = t.id
      WHERE t.owner_id = $1
         OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = $1)
      GROUP BY t.id, u.name, u.email
      ORDER BY is_owner DESC, t.created_at DESC
      `,
      [userId]
    );
    res.json({ teams: rows });
  } catch (e) {
    console.error('Error listing teams:', e);
    res.status(500).json({ error: 'Failed to list teams' });
  }
});

// Team details if requester is owner OR member
app.get('/api/teams/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req;

    const { rows } = await pool.query(
      `
      SELECT
        t.*,
        u.name  AS owner_name,
        u.email AS owner_email,
        COUNT(tm2.id) AS member_count,
        CASE WHEN t.owner_id = $2 THEN true ELSE false END AS is_owner,
        COALESCE((
          SELECT role FROM team_members tm
          WHERE tm.team_id = t.id AND tm.user_id = $2
          LIMIT 1
        ), CASE WHEN t.owner_id = $2 THEN 'owner' ELSE NULL END) AS my_role
      FROM teams t
      JOIN users u ON t.owner_id = u.id
      LEFT JOIN team_members tm2 ON tm2.team_id = t.id
      WHERE t.id = $1
        AND (
          t.owner_id = $2
          OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = $2)
        )
      GROUP BY t.id, u.name, u.email
      `,
      [id, userId]
    );

    if (!rows.length) return res.status(404).json({ error: 'Team not found or access denied' });
    res.json({ team: rows[0] });
  } catch (e) {
    console.error('Error fetching team:', e);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

// Team members — owner first and flagged via owner_id
app.get('/api/teams/:id/members', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const allowed = await pool.query(
      `
      SELECT 1
      FROM teams t
      WHERE t.id = $1 AND (
        t.owner_id = $2 OR EXISTS (
          SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = $2
        )
      )
      `,
      [id, req.userId]
    );
    if (!allowed.rowCount) return res.status(403).json({ error: 'Access denied' });

    const owner = await pool.query(
      `SELECT u.id, u.name, u.email, 'owner' as role
       FROM teams t JOIN users u ON u.id = t.owner_id
       WHERE t.id = $1`,
      [id]
    );

    const members = await pool.query(
      `SELECT u.id, u.name, u.email, tm.role
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1
       ORDER BY u.name ASC`,
      [id]
    );

    const dedup = new Map();
    [...owner.rows, ...members.rows].forEach(m => dedup.set(m.id, m));
    const list = Array.from(dedup.values());
    const ownerId = owner.rows[0]?.id;

    res.json({ members: list, owner_id: ownerId });
  } catch (e) {
    console.error('Error listing members:', e);
    res.status(500).json({ error: 'Failed to list members' });
  }
});

// Owner availability CRUD
app.post('/api/teams/:id/availability', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { slots } = req.body; // [{day_of_week,start_time,end_time}]

    await pool.query('DELETE FROM time_slots WHERE team_id=$1 AND user_id=$2', [id, req.userId]);

    if (Array.isArray(slots) && slots.length) {
      for (const s of slots) {
        await pool.query(
          `INSERT INTO time_slots (team_id,user_id,day_of_week,start_time,end_time,is_available)
           VALUES ($1,$2,$3,$4,$5,true)`,
          [id, req.userId, s.day_of_week, s.start_time, s.end_time]
        );
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save availability' });
  }
});

app.get('/api/teams/:id/availability', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await pool
      .query('SELECT * FROM time_slots WHERE team_id=$1 AND user_id=$2 ORDER BY day_of_week,start_time', [id, req.userId])
      .then((r) => r.rows);
    res.json({ slots: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// ----------------------------------------------------------------------------
// Availability Requests (owner invites guest; guest submits)
// ----------------------------------------------------------------------------
app.post('/api/availability-requests', authenticateToken, async (req, res) => {
  try {
    const { team_id, guest_name, guest_email, guest_notes } = req.body;

    const team = await pool
      .query('SELECT * FROM teams WHERE id=$1 AND owner_id=$2', [team_id, req.userId])
      .then((r) => r.rows[0]);
    if (!team) return res.status(403).json({ error: 'Team not found or access denied' });

    const token = crypto.randomBytes(32).toString('hex');
    const created = await pool
      .query(
        `INSERT INTO availability_requests (team_id,guest_name,guest_email,guest_notes,token)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [team_id, guest_name, guest_email, guest_notes || '', token]
      )
      .then((r) => r.rows[0]);

    // Always use your Railway domain for email and booking links
const base = process.env.APP_URL || 'https://schedulesync-production.up.railway.app';
      const bookingUrl = `${base}/availability-request/${token}`;

    if (emailService?.sendAvailabilityRequest) {
      emailService
        .sendAvailabilityRequest(guest_email, guest_name, team.name, bookingUrl)
        .catch((err) => console.error('Email error:', err));
    }

    res.status(201).json({ success: true, request: created, url: bookingUrl });
  } catch (error) {
    console.error('Error creating availability request:', error);
    res.status(500).json({ error: 'Failed to create availability request' });
  }
});

// Back-compat for old “Send Request” button & payload
app.post('/api/booking-request/create', authenticateToken, async (req, res) => {
  try {
    const { team_id, guest_name, guest_email, guest_notes, recipients } = req.body || {};

    const team = await pool
      .query('SELECT * FROM teams WHERE id=$1 AND owner_id=$2', [team_id, req.userId])
      .then((r) => r.rows[0]);
    if (!team) return res.status(403).json({ error: 'Team not found or access denied' });

    // Always use your Railway domain for email and booking links
const base = process.env.APP_URL || 'https://schedulesync-production.up.railway.app';
    const toCreate = Array.isArray(recipients) && recipients.length
      ? recipients
      : [{ name: guest_name, email: guest_email, notes: guest_notes }];

    const out = [];
    for (const r of toCreate) {
      if (!r?.email) continue;
      const token = crypto.randomBytes(32).toString('hex');
      const created = await pool
        .query(
          `INSERT INTO availability_requests (team_id,guest_name,guest_email,guest_notes,token)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [team_id, r.name || '', r.email, r.notes || '', token]
        )
        .then((q) => q.rows[0]);

      const url = `${base}/availability-request/${token}`;

      if (emailService?.sendAvailabilityRequest) {
        emailService
          .sendAvailabilityRequest(r.email, r.name || '', team.name, url)
          .catch((err) => console.error('Email error:', err));
      }

      out.push({ id: created.id, token, url, guest_email: r.email, guest_name: r.name || '' });
    }

    res.json({ success: true, requests_created: out.length, requests: out });
  } catch (e) {
    console.error('Back-compat booking-request/create error:', e);
    res.status(500).json({ error: 'Failed to create booking request' });
  }
});

// Get availability request (public)
app.get('/api/availability-requests/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const request = await pool
      .query(
        `SELECT ar.*, t.name as team_name, t.description as team_description, u.name as owner_name
         FROM availability_requests ar
         JOIN teams t ON ar.team_id = t.id
         JOIN users u ON t.owner_id = u.id
         WHERE ar.token = $1 AND ar.status != 'expired'`,
        [token]
      )
      .then((r) => r.rows[0]);

    if (!request) return res.status(404).json({ error: 'Availability request not found or expired' });

    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      await pool.query('UPDATE availability_requests SET status=$1 WHERE id=$2', ['expired', request.id]);
      return res.status(410).json({ error: 'This availability request has expired' });
    }

    const ownerId = await pool
      .query('SELECT owner_id FROM teams WHERE id=$1', [request.team_id])
      .then((r) => r.rows[0].owner_id);

    const ownerSlots = await pool
      .query('SELECT * FROM time_slots WHERE user_id=$1 ORDER BY day_of_week,start_time', [ownerId])
      .then((r) => r.rows);

    res.json({
      request: {
        id: request.id,
        team_name: request.team_name,
        team_description: request.team_description,
        owner_name: request.owner_name,
        guest_name: request.guest_name,
        status: request.status,
        created_at: request.created_at,
        expires_at: request.expires_at
      },
      owner_availability: ownerSlots
    });
  } catch (error) {
    console.error('Error fetching availability request:', error);
    res.status(500).json({ error: 'Failed to fetch availability request' });
  }
});

// Guest submits availability
app.post('/api/availability-requests/:token/submit', async (req, res) => {
  try {
    const { token } = req.params;
    const { slots } = req.body;

    const request = await pool
      .query('SELECT * FROM availability_requests WHERE token=$1', [token])
      .then((r) => r.rows[0]);
    if (!request) return res.status(404).json({ error: 'Availability request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Availability already submitted' });

    await pool.query('DELETE FROM guest_availability_slots WHERE request_id=$1', [request.id]);

    if (Array.isArray(slots) && slots.length) {
      for (const s of slots) {
        await pool.query(
          `INSERT INTO guest_availability_slots (request_id,day_of_week,start_time,end_time)
           VALUES ($1,$2,$3,$4)`,
          [request.id, s.day_of_week, s.start_time, s.end_time]
        );
      }
    }

    await pool.query('UPDATE availability_requests SET status=$1 WHERE id=$2', ['submitted', request.id]);

    const overlap = await calculateOverlap(request.team_id, request.id);

    if (emailService?.sendAvailabilitySubmitted) {
      const team = await pool
        .query('SELECT t.*, u.email as owner_email, u.name as owner_name FROM teams t JOIN users u ON t.owner_id = u.id WHERE t.id=$1', [request.team_id])
        .then((r) => r.rows[0]);
      if (team) {
        emailService
          .sendAvailabilitySubmitted(team.owner_email, team.owner_name, request.guest_name, overlap.length)
          .catch((err) => console.error('Email error:', err));
      }
    }

    res.json({ success: true, message: 'Availability submitted successfully', overlap, overlap_count: overlap.length });
  } catch (error) {
    console.error('Error submitting guest availability:', error);
    res.status(500).json({ error: 'Failed to submit availability' });
  }
});

// Get overlap
app.get('/api/availability-requests/:token/overlap', async (req, res) => {
  try {
    const { token } = req.params;

    const request = await pool
      .query('SELECT * FROM availability_requests WHERE token=$1', [token])
      .then((r) => r.rows[0]);
    if (!request) return res.status(404).json({ error: 'Availability request not found' });
    if (request.status === 'pending') return res.status(400).json({ error: 'Guest has not submitted availability yet' });

    const overlap = await calculateOverlap(request.team_id, request.id);
    res.json({ overlap, count: overlap.length });
  } catch (error) {
    console.error('Error calculating overlap:', error);
    res.status(500).json({ error: 'Failed to calculate overlap' });
  }
});

// Finalize booking from overlap
app.post('/api/availability-requests/:token/book', async (req, res) => {
  try {
    const { token } = req.params;
    const { date, time } = req.body;

    const request = await pool
      .query('SELECT ar.*, t.owner_id FROM availability_requests ar JOIN teams t ON ar.team_id = t.id WHERE ar.token=$1', [token])
      .then((r) => r.rows[0]);
    if (!request) return res.status(404).json({ error: 'Availability request not found' });
    if (request.status !== 'submitted') return res.status(400).json({ error: 'Cannot book: availability not submitted or already booked' });

    const overlap = await calculateOverlap(request.team_id, request.id);
    const selected = overlap.find((s) => s.date === date && s.time === time);
    if (!selected) return res.status(400).json({ error: 'Selected time is not in the available overlap' });

    const ts = parseDateAndTimeToTimestamp(date, time);
    if (!ts) return res.status(400).json({ error: 'Invalid date/time format' });

    const booking = await pool
      .query(
        `INSERT INTO bookings (team_id,guest_name,guest_email,guest_notes,status,booking_date,booking_time,slot_start,slot_end)
         VALUES ($1,$2,$3,$4,'confirmed',$5,$6,$7,$8) RETURNING *`,
        [request.team_id, request.guest_name, request.guest_email, request.guest_notes || '', date, time, ts.start, ts.end]
      )
      .then((r) => r.rows[0]);

    await pool.query(
      `UPDATE availability_requests SET status='booked', booked_date=$1, booked_time=$2, booking_id=$3 WHERE id=$4`,
      [date, time, booking.id, request.id]
    );

    if (emailService) {
      const team = await pool.query('SELECT * FROM teams WHERE id=$1', [request.team_id]).then((r) => r.rows[0]);
      if (team) {
        emailService.sendBookingConfirmation(booking, team).catch((err) => console.error('Email error:', err));
        const ownerEmail = await pool.query('SELECT email FROM users WHERE id=$1', [request.owner_id]).then((r) => r.rows[0]?.email);
        if (ownerEmail) {
          emailService
            .sendBookingNotificationToOwner(booking, team, ownerEmail)
            .catch((err) => console.error('Email error:', err));
        }
      }
    }

    res.status(201).json({ success: true, booking, message: 'Booking confirmed successfully' });
  } catch (error) {
    console.error('Error finalizing booking:', error);
    res.status(500).json({ error: 'Failed to finalize booking' });
  }
});

// ----------------------------------------------------------------------------
// Guest page (pretty path)
// ----------------------------------------------------------------------------
app.get('/availability-request/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'availability-request-guest.html'));
});

// ----------------------------------------------------------------------------
// Overlap helpers
// ----------------------------------------------------------------------------
async function calculateOverlap(teamId, requestId) {
  try {
    const ownerId = await pool.query('SELECT owner_id FROM teams WHERE id=$1', [teamId]).then((r) => r.rows[0].owner_id);
    const ownerAvailability = await pool.query('SELECT * FROM time_slots WHERE user_id=$1', [ownerId]).then((r) => r.rows);
    const guestAvailability = await pool.query('SELECT * FROM guest_availability_slots WHERE request_id=$1', [requestId]).then((r) => r.rows);

    const overlap = [];
    for (let day = 1; day <= 7; day++) {
      const ownerSlots = ownerAvailability.filter((s) => s.day_of_week === day);
      const guestSlots = guestAvailability.filter((s) => s.day_of_week === day);
      if (!ownerSlots.length || !guestSlots.length) continue;

      // For simplicity, consider first slot of each list
      const ownerSlot = ownerSlots[0];
      const guestSlot = guestSlots[0];

      const ownerStart = timeToMinutes(ownerSlot.start_time);
      const ownerEnd = timeToMinutes(ownerSlot.end_time);
      const guestStart = timeToMinutes(guestSlot.start_time);
      const guestEnd = timeToMinutes(guestSlot.end_time);

      const overlapStart = Math.max(ownerStart, guestStart);
      const overlapEnd = Math.min(ownerEnd, guestEnd);

      if (overlapStart < overlapEnd) {
        const dayName = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][day];
        for (let minutes = overlapStart; minutes + 60 <= overlapEnd; minutes += 60) {
          const hour = Math.floor(minutes / 60);
          const min = minutes % 60;
          const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
          const nextDate = getNextDateForDay(day);
          overlap.push({ day_of_week: day, day_name: dayName, date: nextDate, time: timeStr, time_display: formatTime12Hour(timeStr) });
        }
      }
    }

    return overlap;
  } catch (e) {
    console.error('Error calculating overlap:', e);
    return [];
  }
}

function timeToMinutes(timeStr) {
  const [h, m] = String(timeStr).split(':').map(Number);
  return h * 60 + m;
}

function getNextDateForDay(dayOfWeek) {
  const today = new Date();
  const current = today.getDay(); // 0..6 Sun..Sat
  const target = dayOfWeek === 7 ? 0 : dayOfWeek; // 7=>0
  let delta = target - current;
  if (delta <= 0) delta += 7;
  const d = new Date(today);
  d.setDate(today.getDate() + delta);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatTime12Hour(time24) {
  const [h, m] = time24.split(':');
  const hn = parseInt(h, 10);
  const h12 = hn % 12 || 12;
  const period = hn >= 12 ? 'PM' : 'AM';
  return `${h12}:${m} ${period}`;
}

// ----------------------------------------------------------------------------
// 404
// ----------------------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ----------------------------------------------------------------------------
// Startup / Shutdown (single instance)
// ----------------------------------------------------------------------------
let server;

function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  try {
    server?.close?.(() => {
      console.log('HTTP server closed.');
      if (typeof pool?.end === 'function') {
        pool.end()
          .then(() => {
            console.log('DB pool closed. Bye!');
            process.exit(0);
          })
          .catch(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
  } catch (e) {
    console.error('Shutdown error:', e);
    process.exit(1);
  }
}

server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
  console.log('✅ ScheduleSync API Running\n');
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
