require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');

// Load services
let googleAuth, microsoftAuth, emailService;
try { googleAuth = require('./google-auth-service'); console.log('✅ Google Auth loaded'); } catch (e) { console.log('ℹ️  Google Auth not found'); }
try { microsoftAuth = require('./microsoft-auth-service'); console.log('✅ Microsoft Auth loaded'); } catch (e) { console.log('ℹ️  Microsoft Auth not found'); }
try { emailService = require('./email-service'); console.log('✅ Email service loaded'); } catch (e) { console.log('ℹ️  Email service not found'); }

// Config
const PORT = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'schedulesync-secret-2025';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Database
const pool = new Pool({
  connectionString: process.env.DB_CONNECTION_STRING || process.env.DATABASE_URL,
  ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Init database
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255), google_id VARCHAR(255), google_access_token TEXT, google_refresh_token TEXT,
      microsoft_id VARCHAR(255), microsoft_access_token TEXT, microsoft_refresh_token TEXT,
      profile_picture TEXT, timezone VARCHAR(100) DEFAULT 'UTC',
      reset_token VARCHAR(255), reset_token_expiry TIMESTAMP, created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL, description TEXT, start_time TIMESTAMP NOT NULL, end_time TIMESTAMP NOT NULL,
      attendee_email VARCHAR(255), attendee_name VARCHAR(255), meet_link TEXT,
      calendar_event_id TEXT, calendar_provider VARCHAR(50), status VARCHAR(50) DEFAULT 'confirmed',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_integrations (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL, calendar_id VARCHAR(255) NOT NULL, calendar_name VARCHAR(255),
      is_primary BOOLEAN DEFAULT false, is_active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, provider, calendar_id)
    )
  `);
  console.log('✅ Database ready');
}

// Auth middleware
function auth(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Auth required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Google OAuth
app.get('/auth/google', (req, res) => {
  if (!googleAuth) return res.status(501).json({ error: 'Not configured' });
  res.redirect(googleAuth.getAuthUrl());
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/login?error=oauth_failed');
  try {
    const tokens = await googleAuth.getTokensFromCode(code);
    const userInfo = await googleAuth.getUserInfo(tokens.access_token);
    let result = await pool.query('SELECT * FROM users WHERE email = $1', [userInfo.email]);
    let user;
    if (result.rows.length > 0) {
      result = await pool.query(
        `UPDATE users SET google_id=$1, google_access_token=$2, google_refresh_token=COALESCE($3,google_refresh_token), name=$4, profile_picture=$5 WHERE email=$6 RETURNING *`,
        [userInfo.google_id, tokens.access_token, tokens.refresh_token, userInfo.name, userInfo.picture, userInfo.email]
      );
      user = result.rows[0];
    } else {
      result = await pool.query(
        `INSERT INTO users (name, email, google_id, google_access_token, google_refresh_token, profile_picture) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [userInfo.name, userInfo.email, userInfo.google_id, tokens.access_token, tokens.refresh_token, userInfo.picture]
      );
      user = result.rows[0];
    }
    const token = jwt.sign({ userId: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, secure: NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    console.log('✅ Google OAuth:', user.email);
    res.redirect('/dashboard.html');
  } catch (e) {
    console.error('❌ Google OAuth failed:', e);
    res.redirect('/login?error=oauth_failed');
  }
});

// Microsoft OAuth
app.get('/auth/microsoft', (req, res) => {
  if (!microsoftAuth) return res.status(501).json({ error: 'Not configured' });
  res.redirect(microsoftAuth.getAuthUrl());
});

app.get('/auth/microsoft/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/login?error=oauth_failed');
  try {
    const tokens = await microsoftAuth.getTokensFromCode(code);
    const userInfo = await microsoftAuth.getUserInfo(tokens.access_token);
    let result = await pool.query('SELECT * FROM users WHERE email = $1', [userInfo.email]);
    let user;
    if (result.rows.length > 0) {
      result = await pool.query(
        `UPDATE users SET microsoft_id=$1, microsoft_access_token=$2, microsoft_refresh_token=COALESCE($3,microsoft_refresh_token), name=$4 WHERE email=$5 RETURNING *`,
        [userInfo.microsoft_id, tokens.access_token, tokens.refresh_token, userInfo.name, userInfo.email]
      );
      user = result.rows[0];
    } else {
      result = await pool.query(
        `INSERT INTO users (name, email, microsoft_id, microsoft_access_token, microsoft_refresh_token) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [userInfo.name, userInfo.email, userInfo.microsoft_id, tokens.access_token, tokens.refresh_token]
      );
      user = result.rows[0];
    }
    const token = jwt.sign({ userId: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, secure: NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    console.log('✅ Microsoft OAuth:', user.email);
    res.redirect('/dashboard.html');
  } catch (e) {
    console.error('❌ Microsoft OAuth failed:', e);
    res.redirect('/login?error=oauth_failed');
  }
});

// Email/Password Auth
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  try {
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) return res.status(409).json({ error: 'Email exists' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users (name, email, password) VALUES ($1,$2,$3) RETURNING *', [name, email, hash]);
    const token = jwt.sign({ userId: result.rows[0].id, email, name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Not found' });
    const user = result.rows[0];
    if (!user.password) return res.status(401).json({ error: 'Use OAuth' });
    const valid = user.password.startsWith('$2') ? await bcrypt.compare(password, user.password) : password === user.password;
    if (!valid) return res.status(401).json({ error: 'Wrong password' });
    const token = jwt.sign({ userId: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/verify', (req, res) => {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ authenticated: false });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true, user: decoded });
  } catch (e) {
    res.status(401).json({ authenticated: false });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/dashboard.html', (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login?error=not_authenticated');
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.redirect('/login?error=expired');
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', google: !!googleAuth, microsoft: !!microsoftAuth });
  } catch (e) {
    res.status(503).json({ status: 'error' });
  }
});

// Start server
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🚀 ScheduleSync API');
    console.log(`📍 Port: ${PORT}`);
    console.log(`✅ Cookie Parser: Enabled`);
    console.log(`${googleAuth ? '✅' : '❌'} Google OAuth`);
    console.log(`${microsoftAuth ? '✅' : '❌'} Microsoft OAuth`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  });
}).catch(e => {
  console.error('❌ Failed to start:', e);
  process.exit(1);
});

process.on('SIGTERM', () => { pool.end(); process.exit(0); });
process.on('SIGINT', () => { pool.end(); process.exit(0); });