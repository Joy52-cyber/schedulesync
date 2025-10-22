// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');

const app = express();

/* ---------------------------------- Config --------------------------------- */
const clean = (v) => (v || '').trim();

const PORT = process.env.PORT || 8080;
const JWT_SECRET = clean(process.env.JWT_SECRET) || 'schedulesync-secret-2025';

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Google
const GOOGLE_CLIENT_ID     = clean(process.env.GOOGLE_CLIENT_ID);
const GOOGLE_CLIENT_SECRET = clean(process.env.GOOGLE_CLIENT_SECRET);
const GOOGLE_CALLBACK_URL  = clean(process.env.GOOGLE_CALLBACK_URL);

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
console.log(`  GOOGLE_CALLBACK_URL:     ${GOOGLE_CALLBACK_URL ? '✅ Found' : '❌ Missing'}`);
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
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
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slot_start TIMESTAMP NOT NULL,
      slot_end TIMESTAMP NOT NULL,
      is_available BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      slot_id INTEGER NOT NULL REFERENCES time_slots(id) ON DELETE CASCADE,
      guest_name VARCHAR(255) NOT NULL,
      guest_email VARCHAR(255) NOT NULL,
      guest_notes TEXT,
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
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
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/* ----------------------------- Config Guards ------------------------------ */
function assertGoogleConfigured(res) {
  const missing = [];
  if (!GOOGLE_CLIENT_ID)     missing.push('GOOGLE_CLIENT_ID');
  if (!GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  if (!GOOGLE_CALLBACK_URL)  missing.push('GOOGLE_CALLBACK_URL');
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
      google:    !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_CALLBACK_URL),
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
  const out = await pool.query('SELECT id,name,email FROM users WHERE id=$1', [req.userId]);
  if (!out.rowCount) return res.status(404).json({ error: 'User not found' });
  res.json({ user: out.rows[0] });
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
    `&redirect_uri=${encodeURIComponent(GOOGLE_CALLBACK_URL)}` +
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
  const googleConfigured    = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_CALLBACK_URL);
  res.json({
    microsoft: { configured: microsoftConfigured, clientId: microsoftConfigured ? '✓ Set' : '✗ Not set' },
    google:    { configured: googleConfigured,    clientId: googleConfigured ? '✓ Set' : '✗ Not set' },
    database:  { connected: dbReady }
  });
});

/* ------------------------------- Static Pages ----------------------------- */
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/booking', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'booking.html')));

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
