// server.js
require('dotenv').config();

// Debug: Show database connection string being used
const dbUrl = process.env.DB_CONNECTION_STRING || process.env.DATABASE_URL;
console.log('🔍 DB Connection:', dbUrl?.substring(0, 80) + '...');

// Google Auth service (optional - gracefully handles if not configured)
let googleAuth = null;
try {
  googleAuth = require('./google-auth-service');
  console.log('✅ Google Auth service loaded');
} catch (error) {
  console.log('⚠️  Google Auth service not found - OAuth will be disabled');
  console.log('   Error:', error.message);
}

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');

// Email service (optional - gracefully handles if not configured)
let emailService = null;
try {
  emailService = require('./email-service');
  console.log('✅ Email service loaded');
} catch (error) {
  console.log('ℹ️  Email service not found - emails will be disabled');
}

const app = express();

/* ---------------------------------- Config --------------------------------- */
const clean = (v) => (v || '').trim();

const PORT = process.env.PORT || 8080;
const JWT_SECRET = clean(process.env.JWT_SECRET) || 'schedulesync-secret-2025';

// Database - Use DB_CONNECTION_STRING (to bypass Railway auto-injection) or fallback to DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DB_CONNECTION_STRING || process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Google - Support both variable names
const GOOGLE_CLIENT_ID     = clean(process.env.GOOGLE_CLIENT_ID);
const GOOGLE_CLIENT_SECRET = clean(process.env.GOOGLE_CLIENT_SECRET);
const GOOGLE_REDIRECT_URI  = clean(process.env.GOOGLE_REDIRECT_URI || process.env.GOOGLE_CALLBACK_URL);

// Microsoft
const MICROSOFT_CLIENT_ID     = clean(process.env.MICROSOFT_CLIENT_ID);
const MICROSOFT_CLIENT_SECRET = clean(process.env.MICROSOFT_CLIENT_SECRET);
const MICROSOFT_CALLBACK_URL  = clean(process.env.MICROSOFT_CALLBACK_URL);

/* ------------------------------ App Middleware ----------------------------- */
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.set('trust proxy', 1);

/* --------------------------------- Logging -------------------------------- */
console.log('🚀 ScheduleSync API Starting...');
console.log(`📡 Will listen on port ${PORT}`);
console.log('\n📋 Environment Variables Check:');
console.log(`  GOOGLE_CLIENT_ID:        ${GOOGLE_CLIENT_ID ? '✅ Found' : '❌ Missing'}`);
console.log(`  GOOGLE_CLIENT_SECRET:    ${GOOGLE_CLIENT_SECRET ? '✅ Found' : '❌ Missing'}`);
console.log(`  GOOGLE_REDIRECT_URI:     ${GOOGLE_REDIRECT_URI ? '✅ Found' : '❌ Missing'}`);
console.log(`  MICROSOFT_CLIENT_ID:     ${MICROSOFT_CLIENT_ID ? '✅ Found' : '❌ Missing'}`);
console.log(`  MICROSOFT_CLIENT_SECRET: ${MICROSOFT_CLIENT_SECRET ? '✅ Found' : '❌ Missing'}`);
console.log(`  MICROSOFT_CALLBACK_URL:  ${MICROSOFT_CALLBACK_URL ? '✅ Found' : '❌ Missing'}`);
console.log();

/* ------------------------------ DB Bootstrap ------------------------------ */
let dbReady = false;

(async () => {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');
    await initDatabase();
    dbReady = true;
    console.log('✅ Database schema ready');
    await ensureTestUser();
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
})();

async function initDatabase() {
  // Users table with Google OAuth columns
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
      working_hours JSONB DEFAULT '{"monday":[{"start":"09:00","end":"17:00"}],"tuesday":[{"start":"09:00","end":"17:00"}],"wednesday":[{"start":"09:00","end":"17:00"}],"thursday":[{"start":"09:00","end":"17:00"}],"friday":[{"start":"09:00","end":"17:00"}],"saturday":[],"sunday":[]}'::jsonb,
      booking_preferences JSONB DEFAULT '{"buffer_before":10,"buffer_after":10,"lead_time_hours":24,"max_horizon_days":30,"daily_cap":8}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  
  // Add Google OAuth columns if table already exists
  try {
    await pool.query(`ALTER TABLE users ALTER COLUMN password DROP NOT NULL`);
  } catch (e) { /* Already nullable */ }
  
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE`);
  } catch (e) { /* Already exists */ }
  
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_access_token TEXT`);
  } catch (e) { /* Already exists */ }
  
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_refresh_token TEXT`);
  } catch (e) { /* Already exists */ }
  
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS default_calendar_id VARCHAR(255)`);
  } catch (e) { /* Already exists */ }
  
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture TEXT`);
  } catch (e) { /* Already exists */ }
  
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) DEFAULT 'UTC'`);
  } catch (e) { /* Already exists */ }
  
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS working_hours JSONB DEFAULT '{"monday":[{"start":"09:00","end":"17:00"}],"tuesday":[{"start":"09:00","end":"17:00"}],"wednesday":[{"start":"09:00","end":"17:00"}],"thursday":[{"start":"09:00","end":"17:00"}],"friday":[{"start":"09:00","end":"17:00"}],"saturday":[],"sunday":[]}'::jsonb`);
  } catch (e) { /* Already exists */ }
  
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_preferences JSONB DEFAULT '{"buffer_before":10,"buffer_after":10,"lead_time_hours":24,"max_horizon_days":30,"daily_cap":8}'::jsonb`);
  } catch (e) { /* Already exists */ }
  
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
      slot_start TIMESTAMP,
      slot_end TIMESTAMP,
      day_of_week INTEGER,
      start_time TIME,
      end_time TIME,
      is_available BOOLEAN DEFAULT true,
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
      calendar_event_id VARCHAR(255),
      meet_link TEXT,
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  
  // Add columns to bookings if table already exists
  try {
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS calendar_event_id VARCHAR(255)`);
  } catch (e) { /* Already exists */ }
  
  try {
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS meet_link TEXT`);
  } catch (e) { /* Already exists */ }
  
  // Add new columns to time_slots for weekly availability
  try {
    await pool.query(`ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS day_of_week INTEGER`);
    console.log('✅ Added day_of_week column');
  } catch (e) { 
    if (e.code !== '42701') console.log('⚠️  day_of_week column issue:', e.message);
  }
  try {
    await pool.query(`ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS start_time TIME`);
    console.log('✅ Added start_time column');
  } catch (e) { 
    if (e.code !== '42701') console.log('⚠️  start_time column issue:', e.message);
  }
  try {
    await pool.query(`ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS end_time TIME`);
    console.log('✅ Added end_time column');
  } catch (e) { 
    if (e.code !== '42701') console.log('⚠️  end_time column issue:', e.message);
  }
  try {
    await pool.query(`ALTER TABLE time_slots ALTER COLUMN team_id DROP NOT NULL`);
  } catch (e) { /* Already nullable */ }
  try {
    await pool.query(`ALTER TABLE time_slots ALTER COLUMN slot_start DROP NOT NULL`);
  } catch (e) { /* Already nullable */ }
  try {
    await pool.query(`ALTER TABLE time_slots ALTER COLUMN slot_end DROP NOT NULL`);
  } catch (e) { /* Already nullable */ }
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_connections (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      token_expiry TIMESTAMP,
      calendar_id VARCHAR(255),
      email VARCHAR(255),
      last_synced TIMESTAMP,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, provider)
    )`);
  
  // Create index on google_id
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)`);
  
  console.log('✅ Database schema migrated');
}

async function ensureTestUser() {
  const testEmail = 'test@example.com';
  const existing = await pool.query('SELECT id FROM users WHERE email=$1', [testEmail]);
  if (!existing.rowCount) {
    await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1,$2,$3)',
      ['Test User', testEmail, 'password123']
    );
    console.log('👤 Test user created: test@example.com / password123');
  }
}

/* ------------------------------ Auth Helpers ------------------------------ */
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

/* --------------------------- Time Parsing Helper --------------------------- */
function parseDateAndTimeToTimestamp(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;

  const parts = String(timeStr).trim().split(/\s+/);
  if (parts.length < 2) return null;

  const [hm, ampmRaw] = parts;
  const [hRaw, mRaw = '0'] = hm.split(':');
  let h = parseInt(hRaw, 10);
  const m = parseInt(mRaw, 10);
  const ampm = (ampmRaw || '').toUpperCase();

  if (isNaN(h) || isNaN(m)) return null;

  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;

  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');

  const d = new Date(`${dateStr}T${hh}:${mm}:00Z`);
  if (isNaN(d.getTime())) return null;

  const toTS = (dt) => {
    const yyyy = dt.getUTCFullYear();
    const mo   = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(dt.getUTCDate()).padStart(2, '0');
    const HH   = String(dt.getUTCHours()).padStart(2, '0');
    const MM   = String(dt.getUTCMinutes()).padStart(2, '0');
    const SS   = String(dt.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}-${mo}-${dd} ${HH}:${MM}:${SS}`;
  };

  const start = d;
  const end   = new Date(d.getTime() + 60 * 60000);

  return { start: toTS(start), end: toTS(end) };
}

/* ----------------------------- Config Guards ------------------------------ */
function assertGoogleConfigured(res) {
  const missing = [];
  if (!GOOGLE_CLIENT_ID)     missing.push('GOOGLE_CLIENT_ID');
  if (!GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  if (!GOOGLE_REDIRECT_URI)  missing.push('GOOGLE_REDIRECT_URI');
  if (missing.length) {
    res.status(400).json({ ok: false, provider: 'google', message: 'Google Calendar not configured', missing });
    return true;
  }
  return false;
}
function assertMicrosoftConfigured(res) {
  const missing = [];
  if (!MICROSOFT_CLIENT_ID)     missing.push('MICROSOFT_CLIENT_ID');
  if (!MICROSOFT_CLIENT_SECRET) missing.push('MICROSOFT_CLIENT_SECRET');
  if (!MICROSOFT_CALLBACK_URL)  missing.push('MICROSOFT_CALLBACK_URL');
  if (missing.length) {
    res.status(400).json({ ok: false, provider: 'microsoft', message: 'Microsoft Outlook not configured', missing });
    return true;
  }
  return false;
}

/* --------------------------------- Health --------------------------------- */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV || 'development', time: new Date().toISOString(), dbReady });
});
app.get('/ready', (_req, res) => res.json({ status: 'ready' }));

/* --------------------------------- Root ----------------------------------- */
app.get('/', (_req, res) => {
  res.json({
    status: 'ScheduleSync API Running',
    config: {
      google:    !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI),
      microsoft: !!(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET && MICROSOFT_CALLBACK_URL),
      database:  dbReady
    }
  });
});

/* ---------------------------- Auth (Basic Demo) ---------------------------- */
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
    const out = await pool.query(
      'INSERT INTO users (name,email,password) VALUES ($1,$2,$3) RETURNING id,name,email',
      [name, email, password]
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
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const out = await pool.query('SELECT id,name,email,password FROM users WHERE email=$1', [email]);
    if (!out.rowCount || out.rows[0].password !== password) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: out.rows[0].id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: out.rows[0].id, name: out.rows[0].name, email: out.rows[0].email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/users/me', authenticateToken, async (req, res) => {
  const out = await pool.query('SELECT id,name,email,profile_picture,default_calendar_id FROM users WHERE id=$1', [req.userId]);
  if (!out.rowCount) return res.status(404).json({ error: 'User not found' });
  res.json({ user: out.rows[0] });
});

/* ============================ GOOGLE OAUTH ROUTES ============================ */

// Initiate Google OAuth flow
app.get('/auth/google', (req, res) => {
  if (!googleAuth) {
    return res.status(503).json({ error: 'Google OAuth not configured', message: 'google-auth-service.js is missing' });
  }
  try {
    const authUrl = googleAuth.getAuthUrl();
    res.redirect(authUrl);
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.redirect('/login?error=oauth_failed');
  }
});

// Google OAuth callback - handles the redirect from Google
app.get('/auth/google/callback', async (req, res) => {
  if (!googleAuth) {
    return res.redirect('/login?error=oauth_not_configured');
  }
  try {
    const { code } = req.query;
    
    if (!code) {
      return res.redirect('/login?error=no_code');
    }

    console.log('📥 Google OAuth callback received');

    // Exchange code for tokens
    const tokens = await googleAuth.getTokensFromCode(code);
    console.log('✅ Got tokens from Google');

    // Get user info from Google
    const userInfo = await googleAuth.getUserInfo(tokens.access_token);
    console.log('✅ Got user info:', userInfo.email);

    // Check if user exists in database
    let user = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [userInfo.email]
    );

    if (user.rows.length === 0) {
      // Create new user
      console.log('➕ Creating new user:', userInfo.email);
      const result = await pool.query(
        `INSERT INTO users (email, name, google_id, google_access_token, google_refresh_token, profile_picture) 
         VALUES ($1, $2, $3, $4, $5, $6) 
         RETURNING *`,
        [
          userInfo.email,
          userInfo.name,
          userInfo.google_id,
          tokens.access_token,
          tokens.refresh_token,
          userInfo.picture
        ]
      );
      user = result;
    } else {
      // Update existing user with Google tokens
      console.log('🔄 Updating existing user:', userInfo.email);
      const result = await pool.query(
        `UPDATE users 
         SET google_id = $1, google_access_token = $2, google_refresh_token = $3, profile_picture = $4, name = $5
         WHERE email = $6 
         RETURNING *`,
        [
          userInfo.google_id,
          tokens.access_token,
          tokens.refresh_token,
          userInfo.picture,
          userInfo.name,
          userInfo.email
        ]
      );
      user = result;
    }

    const dbUser = user.rows[0];
    console.log('✅ User saved to database, ID:', dbUser.id);

    // Create JWT token for session
    const token = jwt.sign(
      { userId: dbUser.id, email: dbUser.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Redirect to calendar setup page
    console.log('➡️  Redirecting to calendar setup');
    res.redirect(`/calendar-setup?token=${token}`);

  } catch (error) {
    console.error('❌ OAuth callback error:', error);
    res.redirect('/login?error=oauth_callback_failed');
  }
});

/* ============================= CALENDAR API ================================= */

// Get user's Google Calendars
app.get('/api/calendars', authenticateToken, async (req, res) => {
  if (!googleAuth) {
    return res.status(503).json({ error: 'Google OAuth not configured' });
  }
  try {
    console.log('📅 Fetching calendars for user:', req.user.userId);

    // Get user's Google tokens from database
    const user = await pool.query(
      'SELECT google_access_token, google_refresh_token FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (user.rows.length === 0 || !user.rows[0].google_refresh_token) {
      console.log('❌ No Google tokens found');
      return res.status(401).json({ error: 'Google Calendar not connected', needsReauth: true });
    }

    const { google_access_token, google_refresh_token } = user.rows[0];

    // Fetch calendars from Google
    const calendars = await googleAuth.getCalendarList(
      google_access_token,
      google_refresh_token
    );

    console.log(`✅ Found ${calendars.length} calendars`);
    res.json(calendars);

  } catch (error) {
    console.error('❌ Error fetching calendars:', error);
    
    // If token expired, ask for reauth
    if (error.message?.includes('invalid_grant') || error.message?.includes('Token has been expired')) {
      return res.status(401).json({ 
        error: 'Calendar access expired', 
        needsReauth: true 
      });
    }
    
    res.status(500).json({ error: 'Failed to fetch calendars' });
  }
});

// Save user's selected default calendar
app.put('/api/user/calendar', authenticateToken, async (req, res) => {
  try {
    const { calendar_id } = req.body;
    
    if (!calendar_id) {
      return res.status(400).json({ error: 'Calendar ID required' });
    }

    console.log('💾 Saving calendar:', calendar_id, 'for user:', req.user.userId);

    // Update user's default calendar
    await pool.query(
      'UPDATE users SET default_calendar_id = $1 WHERE id = $2',
      [calendar_id, req.user.userId]
    );

    console.log('✅ Calendar saved');
    res.json({ success: true, calendar_id });

  } catch (error) {
    console.error('❌ Error saving calendar:', error);
    res.status(500).json({ error: 'Failed to save calendar' });
  }
});

// Get free/busy information for availability checking
app.post('/api/calendar/freebusy', authenticateToken, async (req, res) => {
  if (!googleAuth) {
    return res.status(503).json({ error: 'Google OAuth not configured' });
  }
  try {
    const { calendar_id, time_min, time_max } = req.body;

    console.log('🔍 Checking free/busy for user:', req.user.userId);

    // Get user's tokens
    const user = await pool.query(
      'SELECT google_access_token, google_refresh_token, default_calendar_id FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (user.rows.length === 0 || !user.rows[0].google_refresh_token) {
      return res.status(401).json({ error: 'Google Calendar not connected' });
    }

    const { google_access_token, google_refresh_token, default_calendar_id } = user.rows[0];

    // Fetch free/busy data
    const busySlots = await googleAuth.getFreeBusy(
      google_access_token,
      google_refresh_token,
      calendar_id || default_calendar_id,
      time_min,
      time_max
    );

    console.log(`✅ Found ${busySlots.length} busy slots`);
    res.json({ busy: busySlots });

  } catch (error) {
    console.error('❌ Error fetching free/busy:', error);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// Disconnect Google Calendar
app.post('/api/user/disconnect-google', authenticateToken, async (req, res) => {
  try {
    console.log('🔌 Disconnecting Google for user:', req.user.userId);

    await pool.query(
      'UPDATE users SET google_id = NULL, google_access_token = NULL, google_refresh_token = NULL, default_calendar_id = NULL WHERE id = $1',
      [req.user.userId]
    );

    console.log('✅ Google disconnected');
    res.json({ success: true, message: 'Google Calendar disconnected' });

  } catch (error) {
    console.error('❌ Error disconnecting Google:', error);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

/* ----------------------- Analytics (minimal demo) ------------------------- */
app.get('/api/analytics/dashboard', async (req, res) => {
  try {
    const a = { totalBookings: 0, upcomingMeetings: 0, completedMeetings: 0, teamMembers: 0, recentActivity: [] };
    try {
      const r = await pool.query('SELECT COUNT(*) AS c FROM bookings');
      a.totalBookings = parseInt(r.rows[0]?.c || 0);
    } catch {}
    try {
      const r = await pool.query('SELECT COUNT(*) AS c FROM team_members');
      a.teamMembers = parseInt(r.rows[0]?.c || 0);
    } catch {}
    res.json(a);
  } catch (e) {
    res.json({ totalBookings: 0, upcomingMeetings: 0, completedMeetings: 0, teamMembers: 0, recentActivity: [] });
  }
});

/* ============================================================================
   TEAMS API ENDPOINTS
   ========================================================================== */

// Get all teams for current user
app.get('/api/teams', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(
      `SELECT t.*, COUNT(tm.id) as member_count
       FROM teams t
       LEFT JOIN team_members tm ON t.id = tm.team_id
       WHERE t.owner_id = $1
       GROUP BY t.id
       ORDER BY t.created_at DESC`,
      [userId]
    );
    res.json({ teams: result.rows });
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// Get public team info (for booking page - must be BEFORE /api/teams/:id)
app.get('/api/teams/:id/public', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Try to parse as integer, if it fails, it's a public_url string
    const isNumeric = /^\d+$/.test(id);
    
    let result;
    if (isNumeric) {
      // Search by ID
      result = await pool.query(
        'SELECT id, name, description FROM teams WHERE id = $1',
        [parseInt(id)]
      );
    } else {
      // Search by public_url
      result = await pool.query(
        'SELECT id, name, description FROM teams WHERE public_url = $1',
        [id]
      );
    }
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    res.json({ team: result.rows[0] });
  } catch (error) {
    console.error('Error fetching public team:', error);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

// Get single team by ID
app.get('/api/teams/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    
    // Get team info
    const result = await pool.query(
      `SELECT t.*, COUNT(tm.id) as member_count
       FROM teams t
       LEFT JOIN team_members tm ON t.id = tm.team_id
       WHERE t.id = $1 AND t.owner_id = $2
       GROUP BY t.id`,
      [id, userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    res.json({ team: result.rows[0] });
  } catch (error) {
    console.error('Error fetching team:', error);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

// Create new team
app.post('/api/teams', authenticateToken, async (req, res) => {
  try {
    const { name, description } = req.body;
    const userId = req.userId;
    const result = await pool.query(
      `INSERT INTO teams (name, description, owner_id, public_url)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description, userId, Math.random().toString(36).substring(7)]
    );
    res.status(201).json({ team: result.rows[0] });
  } catch (error) {
    console.error('Error creating team:', error);
    res.status(500).json({ error: 'Failed to create team' });
  }
});

// Update team
app.put('/api/teams/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    const userId = req.userId;
    const result = await pool.query(
      `UPDATE teams SET name = $1, description = $2
       WHERE id = $3 AND owner_id = $4 RETURNING *`,
      [name, description, id, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    res.json({ team: result.rows[0] });
  } catch (error) {
    console.error('Error updating team:', error);
    res.status(500).json({ error: 'Failed to update team' });
  }
});

// Delete team
app.delete('/api/teams/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const result = await pool.query(
      'DELETE FROM teams WHERE id = $1 AND owner_id = $2 RETURNING *',
      [id, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting team:', error);
    res.status(500).json({ error: 'Failed to delete team' });
  }
});

// Get team members
app.get('/api/teams/:id/members', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT tm.*, u.name, u.email
       FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1
       ORDER BY tm.joined_at DESC`,
      [id]
    );
    res.json({ members: result.rows });
  } catch (error) {
    console.error('Error fetching members:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Add team member
app.post('/api/teams/:id/members', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, sendInvite } = req.body;
    const currentUserId = req.userId;
    
    // Get team info
    const teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [id]);
    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    const team = teamResult.rows[0];
    
    // Get inviter info
    const inviterResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [currentUserId]);
    const inviter = inviterResult.rows[0];
    
    // Check if user exists
    const userResult = await pool.query(
      'SELECT id, name FROM users WHERE email = $1',
      [email]
    );
    
    if (userResult.rows.length === 0) {
      // User doesn't exist - send invitation email
      if (emailService && sendInvite !== false) {
        await emailService.sendTeamInvitation(
          email,
          email.split('@')[0], // Use email prefix as name
          team.name,
          inviter.name,
          team.id
        ).catch(err => console.error('Email error:', err));
      }
      return res.status(404).json({ 
        error: 'User not found',
        invitationSent: !!emailService && sendInvite !== false,
        message: 'Invitation email sent to user'
      });
    }
    
    const userId = userResult.rows[0].id;
    const userName = userResult.rows[0].name;
    
    // Add to team
    const result = await pool.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, $3) RETURNING *`,
      [id, userId, 'member']
    );
    
    // Send welcome email
    if (emailService && sendInvite !== false) {
      await emailService.sendTeamWelcome(
        email,
        userName,
        team.name,
        inviter.name
      ).catch(err => console.error('Email error:', err));
    }
    
    res.status(201).json({ 
      member: result.rows[0],
      emailSent: !!emailService && sendInvite !== false
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'User already in team' });
    }
    console.error('Error adding member:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// Remove team member
app.delete('/api/teams/:teamId/members/:memberId', authenticateToken, async (req, res) => {
  try {
    const { teamId, memberId } = req.params;
    const currentUserId = req.userId;
    
    // Check if current user is team owner
    const teamResult = await pool.query(
      'SELECT owner_id FROM teams WHERE id = $1',
      [teamId]
    );
    
    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    const isOwner = teamResult.rows[0].owner_id === currentUserId;
    
    if (!isOwner) {
      return res.status(403).json({ error: 'Only team owner can remove members' });
    }
    
    // Delete the member
    const result = await pool.query(
      'DELETE FROM team_members WHERE id = $1 AND team_id = $2 RETURNING *',
      [memberId, teamId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    res.json({ success: true, message: 'Member removed from team' });
  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// Remove team member
app.delete('/api/teams/:teamId/members/:memberId', authenticateToken, async (req, res) => {
  try {
    const { teamId, memberId } = req.params;
    const userId = req.userId;
    
    // Check if user is team owner
    const teamResult = await pool.query('SELECT owner_id FROM teams WHERE id = $1', [teamId]);
    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    if (teamResult.rows[0].owner_id !== userId) {
      return res.status(403).json({ error: 'Only team owner can remove members' });
    }
    
    // Remove member
    const result = await pool.query(
      'DELETE FROM team_members WHERE id = $1 AND team_id = $2 RETURNING *',
      [memberId, teamId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    
    res.json({ success: true, message: 'Member removed from team' });
  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// Get team availability
app.get('/api/teams/:id/availability', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT slot_start, slot_end, is_available
       FROM time_slots WHERE team_id = $1 ORDER BY slot_start`,
      [id]
    );
    res.json({ slots: result.rows });
  } catch (error) {
    console.error('Error fetching availability:', error);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// Save team availability
app.post('/api/teams/:id/availability', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { availability } = req.body;
    const userId = req.userId;
    await pool.query(
      'DELETE FROM time_slots WHERE team_id = $1 AND user_id = $2',
      [id, userId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving availability:', error);
    res.status(500).json({ error: 'Failed to save availability' });
  }
});

// Get public team info (no auth required)

/* ============================================================================
   BOOKINGS API ENDPOINTS
   ========================================================================== */

// Create booking (public - no auth required)
// Public booking submission (supports both routes)
async function handleBookingSubmission(req, res) {
  try {
    let { team_id, date, time, guest_name, guest_email, guest_notes } = req.body;
    
    console.log('Creating booking with team_id:', team_id);
    
    // If team_id is not numeric, try to look it up as public_url
    const isNumeric = /^\d+$/.test(String(team_id));
    let teamResult;
    
    if (isNumeric) {
      // It's a numeric ID
      teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [parseInt(team_id)]);
    } else {
      // It's a public_url string - look it up
      teamResult = await pool.query('SELECT * FROM teams WHERE public_url = $1', [team_id]);
    }
    
    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    const team = teamResult.rows[0];
    const numericTeamId = team.id; // Use the numeric ID from the database
    
    console.log('Found team:', { id: team.id, name: team.name });

    // ────────────────────────── Option B: compute timestamps ──────────────────────────
    const ts = parseDateAndTimeToTimestamp(date, time);
    if (!ts || !ts.start || !ts.end) {
      return res.status(400).json({ error: 'Invalid date/time format' });
    }
    
    // Create booking with the numeric team ID and slot timestamps
    const result = await pool.query(
      `INSERT INTO bookings 
         (team_id, slot_id, guest_name, guest_email, guest_notes, status, booking_date, booking_time, slot_start, slot_end)
       VALUES 
         ($1,     NULL,     $2,         $3,          $4,          'confirmed', $5,          $6,          $7,         $8)
       RETURNING *`,
      [numericTeamId, guest_name, guest_email, guest_notes || '', date, time, ts.start, ts.end]
    );
    
    const booking = result.rows[0];
    
    console.log('Booking created:', booking.id);
    
    // Send emails if service is available
    if (emailService) {
      // Send confirmation to guest
      emailService.sendBookingConfirmation(booking, team)
        .catch(err => console.error('Email error:', err));
      
      // Send notification to team owner
      const ownerResult = await pool.query('SELECT email FROM users WHERE id = $1', [team.owner_id]);
      if (ownerResult.rows.length > 0) {
        emailService.sendBookingNotificationToOwner(booking, team, ownerResult.rows[0].email)
          .catch(err => console.error('Email error:', err));
      }
    }
    
    res.status(201).json({ booking: result.rows[0], emailSent: !!emailService });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({ error: error.message });
  }
}

// Support both old and new booking endpoints
app.post('/api/bookings', handleBookingSubmission);
app.post('/api/teams/bookings/public', handleBookingSubmission);

/* ----------------------- Availability Management ----------------------- */

// Save user/team availability
app.post('/api/availability', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { slots, team_id } = req.body;

    // Delete existing slots for this user/team
    if (team_id) {
      await pool.query('DELETE FROM time_slots WHERE team_id = $1', [team_id]);
    } else {
      await pool.query('DELETE FROM time_slots WHERE user_id = $1', [userId]);
    }

    // Insert new slots
    if (slots && slots.length > 0) {
      const insertPromises = slots.map(slot => 
        pool.query(
          `INSERT INTO time_slots (team_id, user_id, day_of_week, start_time, end_time, is_available)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [team_id || null, userId, slot.day_of_week, slot.start_time, slot.end_time]
        )
      );
      await Promise.all(insertPromises);
    }

    res.json({ success: true, message: 'Availability saved' });
  } catch (error) {
    console.error('Error saving availability:', error);
    res.status(500).json({ error: 'Failed to save availability' });
  }
});

// Get user availability
app.get('/api/availability', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(
      'SELECT * FROM time_slots WHERE user_id = $1 ORDER BY day_of_week, start_time',
      [userId]
    );
    res.json({ slots: result.rows });
  } catch (error) {
    console.error('Error fetching availability:', error);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

/* ------------------------- Get Team Bookings -------------------------- */

// Get all bookings for user
app.get('/api/bookings', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(
      `SELECT b.*, t.name as team_name
       FROM bookings b
       JOIN teams t ON b.team_id = t.id
       WHERE t.owner_id = $1
       ORDER BY b.created_at DESC`,
      [userId]
    );
    res.json({ bookings: result.rows });
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

/* -------------------------- Calendar: Connections ------------------------- */
app.get('/api/calendar/connections', async (req, res) => {
  let userId = null;
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) { try { userId = jwt.verify(token, JWT_SECRET).userId; } catch {} }
  if (!userId) return res.json({ connections: [] });

  const out = await pool.query(
    `SELECT id, provider, email, is_active, last_synced
     FROM calendar_connections
     WHERE user_id=$1
     ORDER BY id DESC`,
    [userId]
  );
  res.json({ connections: out.rows });
});

/* -------------------------- Google OAuth: Auth URL ------------------------ */
app.get('/api/calendar/google/auth', (req, res) => {
  if (assertGoogleConfigured(res)) return;

  let userId = 'guest';
  const tok = req.headers.authorization?.replace('Bearer ', '');
  if (tok) { try { userId = jwt.verify(tok, JWT_SECRET).userId; } catch {} }

  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events')}` +
    `&access_type=offline&prompt=consent` +
    `&state=${encodeURIComponent(String(userId))}`;

  res.json({ authUrl, configured: true });
});

/* ----------------------- Microsoft OAuth: Auth URL ------------------------ */
app.get('/api/calendar/microsoft/auth', (req, res) => {
  if (assertMicrosoftConfigured(res)) return;

  let userId = 'guest';
  const tok = req.headers.authorization?.replace('Bearer ', '');
  if (tok) { try { userId = jwt.verify(tok, JWT_SECRET).userId; } catch {} }

  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: MICROSOFT_CALLBACK_URL,
    response_mode: 'query',
    scope: 'offline_access Calendars.ReadWrite',
    state: String(userId),
  });
  const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;

  res.json({ authUrl, configured: true });
});

/* ----------------------------- OAuth Callbacks ---------------------------- */
// (Token exchange TODO — these endpoints currently just bounce back to dashboard)

app.get('/api/calendar/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/dashboard?error=google_auth_failed');
  console.log('Google OAuth callback received, code:', String(code).slice(0, 20) + '...');
  return res.redirect('/dashboard?success=google_connected');
});

app.get('/api/calendar/microsoft/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/dashboard?error=microsoft_auth_failed');
  console.log('Microsoft OAuth callback received, code:', String(code).slice(0, 20) + '...');
  return res.redirect('/dashboard?success=microsoft_connected');
});

/* --------------------------- Disconnect Calendar -------------------------- */
app.delete('/api/calendar/connections/:id', async (req, res) => {
  let userId = null;
  const tok = req.headers.authorization?.replace('Bearer ', '');
  if (tok) { try { userId = jwt.verify(tok, JWT_SECRET).userId; } catch {} }
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  await pool.query('DELETE FROM calendar_connections WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
  res.json({ success: true, message: 'Calendar disconnected' });
});

/* --------------------------- Config Status (UI) --------------------------- */
app.get('/api/config/status', (_req, res) => {
  const microsoftConfigured = !!(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET && MICROSOFT_CALLBACK_URL);
  const googleConfigured    = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);
  res.json({
    microsoft: { configured: microsoftConfigured, clientId: microsoftConfigured ? '✓ Set' : '✗ Not set' },
    google:    { configured: googleConfigured,    clientId: googleConfigured ? '✓ Set' : '✗ Not set' },
    database:  { connected: dbReady }
  });
});

/* ------------------------------- Static Pages ----------------------------- */
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/register', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/booking', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'booking.html')));
app.get('/teams', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'team-management.html')));
app.get('/availability', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'availability.html')));
app.get('/book/:id', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'book.html')));
app.get('/bookings', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'booking.html')));
app.get('/calendar-setup', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'calendar-setup.html')));
app.get('/teams/:id', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'team-detail.html')));

/* ----------------------------- Debug Endpoints ---------------------------- */
app.get('/api/debug/email', (req, res) => {
  res.json({
    emailServiceLoaded: !!emailService,
    emailServiceType: emailService ? typeof emailService : 'null',
    emailServiceKeys: emailService ? Object.keys(emailService) : [],
    resendApiKey: process.env.RESEND_API_KEY ? 'Set (length: ' + process.env.RESEND_API_KEY.length + ')' : 'Not set',
    fromEmail: process.env.FROM_EMAIL || 'default: onboarding@resend.dev',
    appUrl: process.env.APP_URL || 'default'
  });
});

app.get('/api/debug/status', (req, res) => {
  res.json({
    server: 'running',
    database: dbReady ? 'connected' : 'disconnected',
    emailService: !!emailService,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/debug/oauth', (req, res) => {
  res.json({
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || 'MISSING',
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? 'SET' : 'MISSING',
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || 'MISSING',
    GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL || 'MISSING',
    redirectUriUsed: process.env.GOOGLE_REDIRECT_URI || process.env.GOOGLE_CALLBACK_URL || 'NONE',
    authUrlTest: (() => {
      try {
        return googleAuth.getAuthUrl();
      } catch (e) {
        return 'ERROR: ' + e.message;
      }
    })()
  });
});

// Manual migration endpoint for time_slots
app.get('/api/migrate/fix-timeslots', async (req, res) => {
  try {
    const results = [];
    
    // Check current schema
    const checkQuery = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'time_slots'
      ORDER BY ordinal_position
    `);
    results.push({ current_columns: checkQuery.rows });
    
    // Add missing columns
    try {
      await pool.query(`ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS day_of_week INTEGER`);
      results.push({ added: 'day_of_week' });
    } catch (e) {
      results.push({ day_of_week: 'already exists or error: ' + e.message });
    }
    
    try {
      await pool.query(`ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS start_time TIME`);
      results.push({ added: 'start_time' });
    } catch (e) {
      results.push({ start_time: 'already exists or error: ' + e.message });
    }
    
    try {
      await pool.query(`ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS end_time TIME`);
      results.push({ added: 'end_time' });
    } catch (e) {
      results.push({ end_time: 'already exists or error: ' + e.message });
    }
    
    // Check schema after migration
    const afterQuery = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'time_slots'
      ORDER BY ordinal_position
    `);
    results.push({ updated_columns: afterQuery.rows });
    
    res.json({ success: true, results });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ error: error.message, details: error });
  }
});

/* --------------------------- Database Migrations -------------------------- */
app.get('/api/migrate/fix-bookings', async (req, res) => {
  try {
    const migrations = [];
    
    // Check if guest_notes column exists
    const checkColumn = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='bookings' AND column_name='guest_notes'
    `);
    
    if (checkColumn.rows.length === 0) {
      await pool.query(`ALTER TABLE bookings ADD COLUMN guest_notes TEXT`);
      migrations.push('Added guest_notes column');
    } else {
      migrations.push('guest_notes column already exists');
    }
    
    // Check if booking_date column exists
    const checkDate = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='bookings' AND column_name='booking_date'
    `);
    
    if (checkDate.rows.length === 0) {
      await pool.query(`ALTER TABLE bookings ADD COLUMN booking_date DATE`);
      migrations.push('Added booking_date column');
    } else {
      migrations.push('booking_date column already exists');
    }
    
    // Check if booking_time column exists
    const checkTime = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='bookings' AND column_name='booking_time'
    `);
    
    if (checkTime.rows.length === 0) {
      await pool.query(`ALTER TABLE bookings ADD COLUMN booking_time VARCHAR(50)`);
      migrations.push('Added booking_time column');
    } else {
      migrations.push('booking_time column already exists');
    }
    
    res.json({ 
      success: true, 
      migrations: migrations,
      message: 'Database migration completed!'
    });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ 
      error: error.message,
      hint: 'Check Railway logs for details'
    });
  }
});

app.get('/api/migrate/fix-slot-constraints', async (req, res) => {
  try {
    const migrations = [];
    
    // Make slot_start nullable
    await pool.query(`ALTER TABLE bookings ALTER COLUMN slot_start DROP NOT NULL`);
    migrations.push('Made slot_start column nullable');
    
    // Make slot_end nullable
    await pool.query(`ALTER TABLE bookings ALTER COLUMN slot_end DROP NOT NULL`);
    migrations.push('Made slot_end column nullable');
    
    // Make slot_id nullable (if it has NOT NULL constraint)
    try {
      await pool.query(`ALTER TABLE bookings ALTER COLUMN slot_id DROP NOT NULL`);
      migrations.push('Made slot_id column nullable');
    } catch (e) {
      migrations.push('slot_id already nullable or does not exist');
    }
    
    res.json({ 
      success: true, 
      migrations: migrations,
      message: 'Slot constraints fixed! Bookings should work now.'
    });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ 
      error: error.message,
      hint: 'Check Railway logs for details'
    });
  }
});

/* ======================= GOOGLE OAUTH MIGRATION ========================== */
app.get('/api/migrate/add-google-oauth', async (req, res) => {
  try {
    const migrations = [];
    
    // Make password nullable
    try {
      await pool.query(`ALTER TABLE users ALTER COLUMN password DROP NOT NULL`);
      migrations.push('✅ Made password nullable');
    } catch (e) {
      migrations.push('⚠️ Password: ' + e.message);
    }
    
    // Add google_id
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE`);
      migrations.push('✅ Added google_id');
    } catch (e) {
      migrations.push('⚠️ google_id: ' + e.message);
    }
    
    // Add google_access_token
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_access_token TEXT`);
      migrations.push('✅ Added google_access_token');
    } catch (e) {
      migrations.push('⚠️ google_access_token: ' + e.message);
    }
    
    // Add google_refresh_token
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_refresh_token TEXT`);
      migrations.push('✅ Added google_refresh_token');
    } catch (e) {
      migrations.push('⚠️ google_refresh_token: ' + e.message);
    }
    
    // Add default_calendar_id
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS default_calendar_id VARCHAR(255)`);
      migrations.push('✅ Added default_calendar_id');
    } catch (e) {
      migrations.push('⚠️ default_calendar_id: ' + e.message);
    }
    
    // Add profile_picture
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture TEXT`);
      migrations.push('✅ Added profile_picture');
    } catch (e) {
      migrations.push('⚠️ profile_picture: ' + e.message);
    }
    
    // Add timezone
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) DEFAULT 'UTC'`);
      migrations.push('✅ Added timezone');
    } catch (e) {
      migrations.push('⚠️ timezone: ' + e.message);
    }
    
    // Add working_hours
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS working_hours JSONB DEFAULT '{"monday":[{"start":"09:00","end":"17:00"}],"tuesday":[{"start":"09:00","end":"17:00"}],"wednesday":[{"start":"09:00","end":"17:00"}],"thursday":[{"start":"09:00","end":"17:00"}],"friday":[{"start":"09:00","end":"17:00"}],"saturday":[],"sunday":[]}'::jsonb`);
      migrations.push('✅ Added working_hours');
    } catch (e) {
      migrations.push('⚠️ working_hours: ' + e.message);
    }
    
    // Add booking_preferences
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_preferences JSONB DEFAULT '{"buffer_before":10,"buffer_after":10,"lead_time_hours":24,"max_horizon_days":30,"daily_cap":8}'::jsonb`);
      migrations.push('✅ Added booking_preferences');
    } catch (e) {
      migrations.push('⚠️ booking_preferences: ' + e.message);
    }
    
    // Create index
    try {
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)`);
      migrations.push('✅ Created index on google_id');
    } catch (e) {
      migrations.push('⚠️ Index: ' + e.message);
    }
    
    // Add calendar_event_id to bookings
    try {
      await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS calendar_event_id VARCHAR(255)`);
      migrations.push('✅ Added calendar_event_id to bookings');
    } catch (e) {
      migrations.push('⚠️ calendar_event_id: ' + e.message);
    }
    
    // Add meet_link to bookings
    try {
      await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS meet_link TEXT`);
      migrations.push('✅ Added meet_link to bookings');
    } catch (e) {
      migrations.push('⚠️ meet_link: ' + e.message);
    }
    
    res.json({ 
      success: true, 
      migrations: migrations,
      message: '🎉 Google OAuth migration completed!'
    });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ 
      error: error.message,
      hint: 'Check Railway logs for details'
    });
  }
});

/* --------------------------------- 404 ------------------------------------ */
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

/* ------------------------------- Start Server ----------------------------- */
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
  console.log('✅ ScheduleSync API Running\n');
});

/* ---------------------------- Graceful Shutdown --------------------------- */
function shutdown(sig) {
  console.log(`${sig} received. Shutting down...`);
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));