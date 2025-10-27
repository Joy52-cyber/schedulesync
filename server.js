// ============================================================================
// SCHEDULESYNC SERVER
// Complete scheduling system with Google Calendar integration
// ============================================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// Services
const googleAuthService = require('./google-auth-service');
let emailService = null;
try { 
  emailService = require('./email-service'); 
} catch (err) {
  console.log('⚠️  Email service not available');
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 8080;
const JWT_SECRET = (process.env.JWT_SECRET || 'schedulesync-secret-2025').trim();
const PUBLIC_BASE_URL = (process.env.APP_URL && process.env.APP_URL.replace(/\/+$/, '')) || 
                        'https://schedulesync-production.up.railway.app';

// ============================================================================
// DATABASE CONNECTION
// ============================================================================

const connectionString = process.env.DB_CONNECTION_STRING || process.env.DATABASE_URL;
const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Database connected:', res.rows[0].now);
  }
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

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
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
  } else {
    const [hRaw, mRaw = '0'] = timeStr.split(':');
    h = parseInt(hRaw, 10);
    m = parseInt(mRaw, 10);
  }
  
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  
  const start = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  
  const end = new Date(start.getTime() + 60 * 60000);
  
  const fmt = (d) => {
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const da = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${y}-${mo}-${da} ${hh}:${mm}:${ss}`;
  };
  
  return { start: fmt(start), end: fmt(end) };
}

function timeToMinutes(s) {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
}

function getNextDateForDay(dow) {
  const today = new Date();
  const current = today.getDay();
  const target = (dow === 7 ? 0 : dow);
  let delta = target - current;
  if (delta <= 0) delta += 7;
  const t = new Date(today);
  t.setDate(today.getDate() + delta);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function formatTime12Hour(t) {
  const [h, m] = t.split(':');
  const n = +h;
  const h12 = n % 12 || 12;
  return `${h12}:${m} ${n >= 12 ? 'PM' : 'AM'}`;
}

// ============================================================================
// CALENDAR HELPER FUNCTIONS
// ============================================================================

function findFreeSlots(startDate, endDate, busyTimes, durationMinutes) {
  const freeSlots = [];
  let currentTime = new Date(startDate);
  const workStart = 9;
  const workEnd = 17;

  const sortedBusy = busyTimes
    .map(b => ({
      start: new Date(b.start),
      end: new Date(b.end)
    }))
    .sort((a, b) => a.start - b.start);

  while (currentTime < endDate) {
    const currentHour = currentTime.getUTCHours();
    const dayOfWeek = currentTime.getUTCDay();

    if (dayOfWeek === 0 || dayOfWeek === 6) {
      currentTime.setUTCDate(currentTime.getUTCDate() + 1);
      currentTime.setUTCHours(workStart, 0, 0, 0);
      continue;
    }

    if (currentHour < workStart) {
      currentTime.setUTCHours(workStart, 0, 0, 0);
      continue;
    }
    if (currentHour >= workEnd) {
      currentTime.setUTCDate(currentTime.getUTCDate() + 1);
      currentTime.setUTCHours(workStart, 0, 0, 0);
      continue;
    }

    const slotEnd = new Date(currentTime.getTime() + durationMinutes * 60000);

    if (slotEnd.getUTCHours() > workEnd || 
        (slotEnd.getUTCHours() === workEnd && slotEnd.getUTCMinutes() > 0)) {
      currentTime.setUTCDate(currentTime.getUTCDate() + 1);
      currentTime.setUTCHours(workStart, 0, 0, 0);
      continue;
    }

    const isBusy = sortedBusy.some(busy => 
      (currentTime >= busy.start && currentTime < busy.end) ||
      (slotEnd > busy.start && slotEnd <= busy.end) ||
      (currentTime <= busy.start && slotEnd >= busy.end)
    );

    if (!isBusy) {
      freeSlots.push({
        start: new Date(currentTime),
        end: new Date(slotEnd),
        duration: durationMinutes
      });
    }

    currentTime = new Date(currentTime.getTime() + 30 * 60000);
  }

  return freeSlots;
}

function formatTimeSlot(slot) {
  const formatTime = (date) => {
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  };

  const formatDate = (date) => {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()}`;
  };

  return {
    date: formatDate(slot.start),
    time: formatTime(slot.start),
    endTime: formatTime(slot.end),
    startISO: slot.start.toISOString(),
    endISO: slot.end.toISOString(),
    duration: slot.duration
  };
}

async function calculateOverlap(teamId, requestId) {
  try {
    const ownerId = await pool.query('SELECT owner_id FROM teams WHERE id=$1', [teamId]).then(r => r.rows[0].owner_id);
    const ownerAvailability = await pool.query('SELECT * FROM time_slots WHERE user_id=$1', [ownerId]).then(r => r.rows);
    const guestAvailability = await pool.query('SELECT * FROM guest_availability_slots WHERE request_id=$1', [requestId]).then(r => r.rows);

    const out = [];
    for (let day = 1; day <= 7; day++) {
      const ownerSlots = ownerAvailability.filter(s => s.day_of_week === day);
      const guestSlots = guestAvailability.filter(s => s.day_of_week === day);
      if (!ownerSlots.length || !guestSlots.length) continue;

      const o = ownerSlots[0], g = guestSlots[0];
      const s = Math.max(timeToMinutes(o.start_time), timeToMinutes(g.start_time));
      const e = Math.min(timeToMinutes(o.end_time), timeToMinutes(g.end_time));
      
      if (s < e) {
        const dayName = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][day];
        for (let m = s; m + 60 <= e; m += 60) {
          const hh = String(Math.floor(m / 60)).padStart(2, '0');
          const mm = String(m % 60).padStart(2, '0');
          const t = `${hh}:${mm}`;
          out.push({
            day_of_week: day,
            day_name: dayName,
            date: getNextDateForDay(day),
            time: t,
            time_display: formatTime12Hour(t)
          });
        }
      }
    }
    return out;
  } catch (e) {
    console.error('Overlap calculation error:', e);
    return [];
  }
}

// ============================================================================
// EXPRESS APP SETUP
// ============================================================================

const app = express();

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Pretty URLs for HTML pages
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || path.extname(req.path)) return next();

  const cleaned = req.path.replace(/\/+$/, '');
  const candidate = path.join(__dirname, 'public', (cleaned || '/index').slice(1) + '.html');

  fs.access(candidate, fs.constants.F_OK, (err) => {
    if (err) return next();
    return res.sendFile(candidate);
  });
});

// Attach database to all requests
app.use((req, _res, next) => {
  req.db = pool;
  next();
});

// ============================================================================
// DATABASE INITIALIZATION
// ============================================================================

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255),
        google_id VARCHAR(255),
        google_access_token TEXT,
        google_refresh_token TEXT,
        picture TEXT,
        timezone VARCHAR(100) DEFAULT 'UTC',
        default_calendar_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams(
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        owner_id INTEGER REFERENCES users(id),
        public_url VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT NOW()
      )`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_members(
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(team_id, user_id)
      )`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS time_slots(
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        day_of_week INTEGER,
        start_time TIME,
        end_time TIME,
        is_available BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings(
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
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
      CREATE TABLE IF NOT EXISTS availability_requests(
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        guest_name VARCHAR(255) NOT NULL,
        guest_email VARCHAR(255) NOT NULL,
        guest_notes TEXT,
        token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        booked_date DATE,
        booked_time VARCHAR(50),
        booking_id INTEGER REFERENCES bookings(id),
        expires_at TIMESTAMP,
        guest_google_access_token TEXT,
        guest_google_refresh_token TEXT,
        guest_google_email VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS guest_availability_slots(
        id SERIAL PRIMARY KEY,
        request_id INTEGER REFERENCES availability_requests(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL
      )`);

    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
  }
}

initDatabase();

// ============================================================================
// MIDDLEWARE
// ============================================================================

function authenticateToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ============================================================================
// HEALTH & STATUS ROUTES
// ============================================================================

app.get('/', (_req, res) => res.status(200).send('ScheduleSync API'));

app.get('/health', (_req, res) => res.status(200).json({ 
  ok: true, 
  uptime: process.uptime(),
  timestamp: new Date().toISOString()
}));

app.head('/health', (_req, res) => res.status(200).end());

app.get('/api/status', async (_req, res) => {
  try {
    const dbOk = await pool.query('SELECT 1').then(() => true).catch(() => false);
    res.status(200).json({
      status: 'ScheduleSync API Running',
      database: dbOk,
      baseUrl: PUBLIC_BASE_URL,
      timestamp: new Date().toISOString()
    });
  } catch {
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ============================================================================
// AUTHENTICATION ROUTES
// ============================================================================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await pool.query(
      'INSERT INTO users(name, email, password) VALUES($1, $2, $3) RETURNING id, name, email',
      [name, email, hashed]
    ).then(r => r.rows[0]);

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ success: true, token, user });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await pool.query(
      'SELECT id, name, email, password FROM users WHERE email=$1',
      [email]
    ).then(r => r.rows[0]);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ok = user.password?.startsWith('$2b$') 
      ? await bcrypt.compare(password, user.password)
      : (user.password === password);

    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.password?.startsWith('$2b$')) {
      const hashed = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hashed, user.id]);
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true,
      token,
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query(
      'SELECT id, name, email, picture, timezone, default_calendar_id FROM users WHERE id=$1',
      [req.userId]
    ).then(r => r.rows[0]);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ============================================================================
// GOOGLE OAUTH ROUTES
// ============================================================================

app.get('/api/auth/google', (_req, res) => {
  try {
    const authUrl = googleAuthService.getAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    console.error('Error initiating Google OAuth:', error);
    res.status(500).json({ error: 'Failed to initiate Google authentication' });
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    console.error('OAuth error:', error);
    return res.redirect(`${PUBLIC_BASE_URL}/login?error=` + encodeURIComponent('Authentication failed'));
  }

  if (!code) {
    return res.redirect(`${PUBLIC_BASE_URL}/login?error=` + encodeURIComponent('No authorization code'));
  }

  try {
    const tokens = await googleAuthService.getTokensFromCode(code);
    const { access_token, refresh_token } = tokens;

    if (!access_token) {
      throw new Error('No access token received');
    }

    const userInfo = await googleAuthService.getUserInfo(access_token);

    // GUEST calendar connection
    if (state && state.startsWith('guest:')) {
      const requestToken = state.substring(6);
      
      await pool.query(
        `UPDATE availability_requests 
         SET guest_google_access_token=$1, 
             guest_google_refresh_token=$2,
             guest_google_email=$3
         WHERE token=$4`,
        [access_token, refresh_token, userInfo.email, requestToken]
      );

      return res.redirect(`${PUBLIC_BASE_URL}/availability-request/${requestToken}?google_connected=true`);
    }

    // USER login/signup
    let user = await pool.query(
      'SELECT * FROM users WHERE google_id = $1',
      [userInfo.google_id]
    ).then(r => r.rows[0]);

    if (user) {
      await pool.query(
        `UPDATE users 
         SET google_access_token=$1, google_refresh_token=$2, name=$3, picture=$4, updated_at=NOW()
         WHERE id=$5`,
        [access_token, refresh_token, userInfo.name, userInfo.picture, user.id]
      );
    } else {
      user = await pool.query('SELECT * FROM users WHERE email = $1', [userInfo.email]).then(r => r.rows[0]);

      if (user) {
        await pool.query(
          `UPDATE users 
           SET google_id=$1, google_access_token=$2, google_refresh_token=$3, name=$4, picture=$5, updated_at=NOW()
           WHERE id=$6`,
          [userInfo.google_id, access_token, refresh_token, userInfo.name, userInfo.picture, user.id]
        );
      } else {
        const result = await pool.query(
          `INSERT INTO users (email, name, google_id, google_access_token, google_refresh_token, picture, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
          [userInfo.email, userInfo.name, userInfo.google_id, access_token, refresh_token, userInfo.picture]
        );
        user = result.rows[0];
      }
    }

    const jwtToken = jwt.sign(
      { userId: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const redirectParams = new URLSearchParams({
      token: jwtToken,
      user: JSON.stringify({
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture
      })
    });

    return res.redirect(`${PUBLIC_BASE_URL}/dashboard?${redirectParams.toString()}`);

  } catch (error) {
    console.error('OAuth callback error:', error);
    return res.redirect(`${PUBLIC_BASE_URL}/login?error=authentication_failed`);
  }
});

app.get('/api/calendars', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query(
      'SELECT google_access_token, google_refresh_token FROM users WHERE id=$1',
      [req.userId]
    ).then(r => r.rows[0]);

    if (!user || !user.google_access_token) {
      return res.status(400).json({ error: 'Google Calendar not connected' });
    }

    const calendars = await googleAuthService.getCalendarList(
      user.google_access_token,
      user.google_refresh_token
    );

    res.json(calendars);
  } catch (error) {
    console.error('Error fetching calendars:', error);
    res.status(500).json({ error: 'Failed to fetch calendars' });
  }
});

app.put('/api/user/calendar', authenticateToken, async (req, res) => {
  try {
    const { calendar_id } = req.body;

    if (!calendar_id) {
      return res.status(400).json({ error: 'Calendar ID required' });
    }

    await pool.query(
      'UPDATE users SET default_calendar_id=$1, updated_at=NOW() WHERE id=$2',
      [calendar_id, req.userId]
    );

    res.json({ success: true, message: 'Calendar saved' });
  } catch (error) {
    console.error('Error saving calendar:', error);
    res.status(500).json({ error: 'Failed to save calendar' });
  }
});

// ============================================================================
// TEAMS ROUTES
// ============================================================================

app.post('/api/teams', authenticateToken, async (req, res) => {
  try {
    const { name, description = '' } = req.body || {};
    
    const team = await pool.query(
      `INSERT INTO teams(name, description, owner_id, public_url, created_at)
       VALUES($1, $2, $3, $4, NOW()) RETURNING *`,
      [name, description, req.userId, Math.random().toString(36).slice(2)]
    ).then(r => r.rows[0]);

    await pool.query(
      `INSERT INTO team_members(team_id, user_id, role)
       VALUES($1, $2, 'owner') ON CONFLICT DO NOTHING`,
      [team.id, req.userId]
    );

    res.status(201).json({ team });
  } catch {
    res.status(500).json({ error: 'Failed to create team' });
  }
});

app.get('/api/teams', authenticateToken, async (req, res) => {
  try {
    const teams = await pool.query(
      `SELECT t.*, u.name as owner_name, u.email as owner_email
       FROM teams t
       JOIN users u ON t.owner_id = u.id
       JOIN team_members tm ON t.id = tm.team_id
       WHERE tm.user_id = $1
       ORDER BY t.created_at DESC`,
      [req.userId]
    ).then(r => r.rows);

    res.json({ teams });
  } catch {
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

app.get('/api/teams/:id', authenticateToken, async (req, res) => {
  try {
    const team = await pool.query(
      `SELECT t.*, u.name as owner_name, u.email as owner_email
       FROM teams t
       JOIN users u ON t.owner_id = u.id
       WHERE t.id = $1`,
      [req.params.id]
    ).then(r => r.rows[0]);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    res.json({ team });
  } catch {
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

app.get('/api/teams/:id/members', authenticateToken, async (req, res) => {
  try {
    const members = await pool.query(
      `SELECT u.id as user_id, u.name as display_name, u.email, tm.role, tm.joined_at,
              (t.owner_id = u.id) as is_owner
       FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       JOIN teams t ON tm.team_id = t.id
       WHERE tm.team_id = $1
       ORDER BY is_owner DESC, tm.joined_at ASC`,
      [req.params.id]
    ).then(r => r.rows);

    res.json({ members });
  } catch {
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// ============================================================================
// AVAILABILITY REQUEST ROUTES
// ============================================================================

app.post('/api/booking-request/create', authenticateToken, async (req, res) => {
  try {
    const { team_id, team_members, recipients, custom_message } = req.body || {};

    if (!team_id || !recipients || recipients.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const team = await pool.query('SELECT * FROM teams WHERE id=$1', [team_id]).then(r => r.rows[0]);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const out = [];

    for (const r of recipients) {
      if (!r.email) continue;

      const token = crypto.randomBytes(32).toString('hex');
      const created = await pool.query(
        `INSERT INTO availability_requests(team_id, guest_name, guest_email, guest_notes, token)
         VALUES($1, $2, $3, $4, $5) RETURNING *`,
        [team_id, r.name || '', r.email, custom_message || '', token]
      ).then(result => result.rows[0]);

      const url = `${PUBLIC_BASE_URL}/availability-request/${token}`;

      if (emailService?.sendAvailabilityRequest) {
        emailService.sendAvailabilityRequest(r.email, r.name || '', url, team.name, team.description || '')
          .catch(err => console.error('Email error:', err));
      }

      out.push({
        id: created.id,
        token,
        url,
        guest_email: r.email,
        guest_name: r.name || ''
      });
    }

    res.json({ success: true, requests_created: out.length, requests: out });
  } catch (e) {
    console.error('Create booking request error:', e);
    res.status(500).json({ error: 'Failed to create booking request' });
  }
});

app.get('/api/availability-requests/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    const request = await pool.query(
      `SELECT ar.*, t.name as team_name, t.description as team_description, u.name as owner_name
       FROM availability_requests ar
       JOIN teams t ON ar.team_id=t.id
       JOIN users u ON t.owner_id=u.id
       WHERE ar.token=$1 AND ar.status!='expired'`,
      [token]
    ).then(r => r.rows[0]);

    if (!request) {
      return res.status(404).json({ error: 'Availability request not found' });
    }

    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      await pool.query('UPDATE availability_requests SET status=$1 WHERE id=$2', ['expired', request.id]);
      return res.status(410).json({ error: 'Request expired' });
    }

    const ownerId = await pool.query('SELECT owner_id FROM teams WHERE id=$1', [request.team_id]).then(r => r.rows[0].owner_id);
    const ownerSlots = await pool.query(
      'SELECT * FROM time_slots WHERE user_id=$1 ORDER BY day_of_week, start_time',
      [ownerId]
    ).then(r => r.rows);

    res.json({
      request: {
        id: request.id,
        team_name: request.team_name,
        team_description: request.team_description,
        owner_name: request.owner_name,
        guest_name: request.guest_name,
        status: request.status,
        created_at: request.created_at,
        expires_at: request.expires_at,
      },
      owner_availability: ownerSlots
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch request' });
  }
});

app.post('/api/availability-requests/:token/submit', async (req, res) => {
  try {
    const { token } = req.params;
    const { slots = [] } = req.body || {};

    const request = await pool.query(
      'SELECT * FROM availability_requests WHERE token=$1',
      [token]
    ).then(r => r.rows[0]);

    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Availability already submitted' });
    }

    await pool.query('DELETE FROM guest_availability_slots WHERE request_id=$1', [request.id]);

    for (const s of slots) {
      await pool.query(
        `INSERT INTO guest_availability_slots(request_id, day_of_week, start_time, end_time)
         VALUES($1, $2, $3, $4)`,
        [request.id, s.day_of_week, s.start_time, s.end_time]
      );
    }

    await pool.query('UPDATE availability_requests SET status=$1 WHERE id=$2', ['submitted', request.id]);

    const overlap = await calculateOverlap(request.team_id, request.id);

    try {
      const team = await pool.query(
        'SELECT t.*, u.email as owner_email, u.name as owner_name FROM teams t JOIN users u ON t.owner_id=u.id WHERE t.id=$1',
        [request.team_id]
      ).then(r => r.rows[0]);

      if (emailService?.sendAvailabilitySubmitted) {
        emailService.sendAvailabilitySubmitted(team.owner_email, team.owner_name, request.guest_name, overlap.length)
          .catch(() => {});
      }
    } catch {}

    res.json({ success: true, message: 'Availability submitted', overlap, overlap_count: overlap.length });
  } catch {
    res.status(500).json({ error: 'Failed to submit availability' });
  }
});

app.get('/api/availability-requests/:token/overlap', async (req, res) => {
  try {
    const { token } = req.params;
    
    const request = await pool.query('SELECT * FROM availability_requests WHERE token=$1', [token]).then(r => r.rows[0]);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.status === 'pending') {
      return res.status(400).json({ error: 'Guest has not submitted availability' });
    }

    const overlap = await calculateOverlap(request.team_id, request.id);
    res.json({ overlap, count: overlap.length });
  } catch {
    res.status(500).json({ error: 'Failed to calculate overlap' });
  }
});

app.post('/api/availability-requests/:token/book', async (req, res) => {
  try {
    const { token } = req.params;
    const { date, time } = req.body || {};

    const request = await pool.query(
      'SELECT ar.*, t.owner_id FROM availability_requests ar JOIN teams t ON ar.team_id=t.id WHERE ar.token=$1',
      [token]
    ).then(r => r.rows[0]);

    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.status !== 'submitted') {
      return res.status(400).json({ error: 'Cannot book yet' });
    }

    const overlap = await calculateOverlap(request.team_id, request.id);
    const selected = overlap.find(s => s.date === date && s.time === time);
    
    if (!selected) {
      return res.status(400).json({ error: 'Selected time not available' });
    }

    const ts = parseDateAndTimeToTimestamp(date, time);
    if (!ts) {
      return res.status(400).json({ error: 'Invalid date/time' });
    }

    const booking = await pool.query(
      `INSERT INTO bookings(team_id, guest_name, guest_email, guest_notes, status, booking_date, booking_time, slot_start, slot_end, created_at)
       VALUES($1, $2, $3, $4, 'confirmed', $5, $6, $7, $8, NOW()) RETURNING *`,
      [request.team_id, request.guest_name, request.guest_email, request.guest_notes || '', date, time, ts.start, ts.end]
    ).then(r => r.rows[0]);

    await pool.query(
      `UPDATE availability_requests SET status='booked', booked_date=$1, booked_time=$2, booking_id=$3 WHERE id=$4`,
      [date, time, booking.id, request.id]
    );

    try {
      const team = await pool.query('SELECT * FROM teams WHERE id=$1', [request.team_id]).then(r => r.rows[0]);
      
      if (emailService?.sendBookingConfirmation) {
        emailService.sendBookingConfirmation(booking, team).catch(() => {});
      }

      const ownerEmail = await pool.query('SELECT email FROM users WHERE id=$1', [request.owner_id]).then(r => r.rows[0]?.email);
      if (ownerEmail && emailService?.sendBookingNotificationToOwner) {
        emailService.sendBookingNotificationToOwner(booking, team, ownerEmail).catch(() => {});
      }
    } catch {}

    res.status(201).json({ success: true, booking, message: 'Booking confirmed' });
  } catch {
    res.status(500).json({ error: 'Failed to finalize booking' });
  }
});

// ============================================================================
// GOOGLE CALENDAR INTEGRATION FOR GUESTS
// ============================================================================

app.get('/api/availability-requests/:token/connect-google', async (req, res) => {
  try {
    const { token } = req.params;
    
    const request = await pool.query(
      'SELECT * FROM availability_requests WHERE token=$1 AND status IN ($2, $3)',
      [token, 'pending', 'submitted']
    ).then(r => r.rows[0]);

    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const authUrl = googleAuthService.getAuthUrl({ 
      state: `guest:${token}`,
      prompt: 'consent'
    });
    
    res.json({ authUrl });
  } catch (error) {
    console.error('Error initiating guest Google OAuth:', error);
    res.status(500).json({ error: 'Failed to connect Google Calendar' });
  }
});

app.get('/api/availability-requests/:token/calendar-slots', async (req, res) => {
  try {
    const { token } = req.params;
    const { days = 14, duration = 60 } = req.query;

    const request = await pool.query(
      `SELECT ar.*, t.owner_id, u.google_access_token as owner_access_token,
              u.google_refresh_token as owner_refresh_token
       FROM availability_requests ar
       JOIN teams t ON ar.team_id = t.id
       JOIN users u ON t.owner_id = u.id
       WHERE ar.token = $1`,
      [token]
    ).then(r => r.rows[0]);

    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (!request.guest_google_access_token) {
      return res.status(400).json({ 
        error: 'Connect Google Calendar first',
        needsGoogleAuth: true 
      });
    }

    if (!request.owner_access_token) {
      return res.status(400).json({ 
        error: 'Owner has not connected calendar',
        ownerNeedsAuth: true
      });
    }

    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + parseInt(days));
    endDate.setHours(23, 59, 59, 999);

    const [guestBusy, ownerBusy] = await Promise.all([
      googleAuthService.getBusyTimes(request.guest_google_access_token, startDate, endDate)
        .catch(() => []),
      googleAuthService.getBusyTimes(request.owner_access_token, startDate, endDate)
        .catch(() => [])
    ]);

    const allBusy = [...guestBusy, ...ownerBusy];
    const freeSlots = findFreeSlots(startDate, endDate, allBusy, parseInt(duration));
    const formattedSlots = freeSlots.map(slot => formatTimeSlot(slot));

    const groupedSlots = formattedSlots.reduce((acc, slot) => {
      if (!acc[slot.date]) {
        acc[slot.date] = [];
      }
      acc[slot.date].push(slot);
      return acc;
    }, {});

    res.json({
      success: true,
      totalSlots: freeSlots.length,
      slots: formattedSlots,
      groupedByDate: groupedSlots,
      searchRange: {
        start: startDate.toISOString(),
        end: endDate.toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting calendar slots:', error);
    res.status(500).json({ error: 'Failed to find available slots' });
  }
});

app.post('/api/availability-requests/:token/book-calendar', async (req, res) => {
  try {
    const { token } = req.params;
    const { startTime, endTime } = req.body;

    if (!startTime || !endTime) {
      return res.status(400).json({ error: 'Start and end time required' });
    }

    const request = await pool.query(
      `SELECT ar.*, t.name as team_name, t.description as team_description,
              t.owner_id, u.name as owner_name, u.email as owner_email,
              u.google_access_token as owner_access_token,
              u.google_refresh_token as owner_refresh_token
       FROM availability_requests ar
       JOIN teams t ON ar.team_id = t.id
       JOIN users u ON t.owner_id = u.id
       WHERE ar.token = $1`,
      [token]
    ).then(r => r.rows[0]);

    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.status === 'booked') {
      return res.status(400).json({ error: 'Already booked' });
    }

    if (!request.guest_google_access_token || !request.owner_access_token) {
      return res.status(400).json({ 
        error: 'Both parties must have Google Calendar connected' 
      });
    }

    const eventData = {
      summary: `Meeting: ${request.guest_name} & ${request.owner_name}`,
      description: [
        request.team_name,
        request.team_description,
        request.guest_notes ? `\n\nNotes:\n${request.guest_notes}` : ''
      ].filter(Boolean).join('\n\n'),
      start: {
        dateTime: startTime,
        timeZone: 'UTC'
      },
      end: {
        dateTime: endTime,
        timeZone: 'UTC'
      },
      attendees: [
        { email: request.owner_email },
        { email: request.guest_google_email }
      ],
      conferenceData: {
        createRequest: {
          requestId: `meet-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    };

    const createdEvent = await googleAuthService.createCalendarEvent(
      request.owner_access_token,
      eventData
    );

    const meetLink = createdEvent.hangoutLink || 
                    createdEvent.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri;

    const startDate = new Date(startTime);
    const booking = await pool.query(
      `INSERT INTO bookings(
        team_id, guest_name, guest_email, guest_notes,
        booking_date, booking_time, slot_start, slot_end,
        calendar_event_id, meet_link, status, created_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed', NOW())
      RETURNING *`,
      [
        request.team_id,
        request.guest_name,
        request.guest_google_email,
        request.guest_notes || '',
        startDate.toISOString().split('T')[0],
        startDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
        startTime,
        endTime,
        createdEvent.id,
        meetLink
      ]
    ).then(r => r.rows[0]);

    await pool.query(
      `UPDATE availability_requests 
       SET status='booked', 
           booked_date=$1, 
           booked_time=$2,
           booking_id=$3
       WHERE id=$4`,
      [booking.booking_date, booking.booking_time, booking.id, request.id]
    );

    res.status(201).json({
      success: true,
      booking: {
        id: booking.id,
        date: booking.booking_date,
        time: booking.booking_time,
        meetLink: meetLink,
        calendarLink: createdEvent.htmlLink,
        status: 'confirmed'
      },
      message: 'Meeting booked successfully!'
    });
  } catch (error) {
    console.error('Error booking calendar event:', error);
    res.status(500).json({ 
      error: 'Failed to book meeting',
      details: error.message 
    });
  }
});

app.get('/api/availability-requests/:token/google-status', async (req, res) => {
  try {
    const { token } = req.params;

    const request = await pool.query(
      `SELECT ar.guest_google_access_token, ar.guest_google_email,
              u.google_access_token as owner_connected
       FROM availability_requests ar
       JOIN teams t ON ar.team_id = t.id
       JOIN users u ON t.owner_id = u.id
       WHERE ar.token = $1`,
      [token]
    ).then(r => r.rows[0]);

    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    res.json({
      guestConnected: !!request.guest_google_access_token,
      guestEmail: request.guest_google_email,
      ownerConnected: !!request.owner_connected,
      bothConnected: !!(request.guest_google_access_token && request.owner_connected)
    });
  } catch (error) {
    console.error('Error checking Google status:', error);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// ============================================================================
// GUEST PAGE ROUTE
// ============================================================================

app.get('/availability-request/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'availability-request-guest.html'));
});

// ============================================================================
// 404 HANDLER
// ============================================================================

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================================================
// SERVER STARTUP & SHUTDOWN
// ============================================================================

let server;

function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  try {
    server?.close?.(() => {
      console.log('HTTP server closed');
      pool?.end?.().finally(() => {
        console.log('Database pool closed');
        process.exit(0);
      });
    });
  } catch {
    process.exit(0);
  }
}

server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║   📅  ScheduleSync Server                                      ║
║                                                                ║
║   🚀  Server running on port ${PORT}                           ║
║   🌐  Public URL: ${PUBLIC_BASE_URL}         ║
║   📊  Status: ${PUBLIC_BASE_URL}/api/status  ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  shutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});