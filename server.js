// server.js - Fixed version with proper startup sequence and error handling
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
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
const axios = require('axios');

// Email service (optional - gracefully handles if not configured)
let emailService = null;
try {
  emailService = require('./email-service');
  console.log('✅ Email service loaded');
} catch (error) {
  console.log('ℹ️  Email service not found - emails will be disabled');
  console.log('   Error:', error.message);
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
  // Add connection pool settings for better stability
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Google - Support both variable names
const GOOGLE_CLIENT_ID     = clean(process.env.GOOGLE_CLIENT_ID);
const GOOGLE_CLIENT_SECRET = clean(process.env.GOOGLE_CLIENT_SECRET);
const GOOGLE_REDIRECT_URI  = clean(process.env.GOOGLE_REDIRECT_URI || process.env.GOOGLE_CALLBACK_URL);

// Microsoft
const MICROSOFT_CLIENT_ID     = clean(process.env.MICROSOFT_CLIENT_ID);
const MICROSOFT_CLIENT_SECRET = clean(process.env.MICROSOFT_CLIENT_SECRET);
const MICROSOFT_CALLBACK_URL  = clean(process.env.MICROSOFT_CALLBACK_URL);

// Microsoft OAuth URLs
const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MICROSOFT_GRAPH_URL = 'https://graph.microsoft.com/v1.0';
const MICROSOFT_SCOPES = [
  'offline_access',
  'Calendars.ReadWrite',
  'Calendars.Read',
  'User.Read'
].join(' ');

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

/* ----------------------------- Health Check -------------------------------- */
// Add this BEFORE database initialization to allow platform health checks
let dbReady = false;
let serverReady = false;

app.get('/health', (req, res) => {
  if (dbReady && serverReady) {
    res.status(200).json({ 
      status: 'healthy', 
      database: 'connected',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(503).json({ 
      status: 'starting', 
      database: dbReady ? 'connected' : 'connecting',
      server: serverReady ? 'ready' : 'initializing'
    });
  }
});

// Readiness check (returns 200 only when fully ready)
app.get('/ready', (req, res) => {
  if (dbReady && serverReady) {
    res.status(200).json({ ready: true });
  } else {
    res.status(503).json({ ready: false, dbReady, serverReady });
  }
});

/* ------------------------------ DB Bootstrap ------------------------------ */
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
  const alterQueries = [
    `ALTER TABLE users ALTER COLUMN password DROP NOT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_access_token TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_refresh_token TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS default_calendar_id VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) DEFAULT 'UTC'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS working_hours JSONB DEFAULT '{"monday":[{"start":"09:00","end":"17:00"}],"tuesday":[{"start":"09:00","end":"17:00"}],"wednesday":[{"start":"09:00","end":"17:00"}],"thursday":[{"start":"09:00","end":"17:00"}],"friday":[{"start":"09:00","end":"17:00"}],"saturday":[],"sunday":[]}'::jsonb`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_preferences JSONB DEFAULT '{"buffer_before":10,"buffer_after":10,"lead_time_hours":24,"max_horizon_days":30,"daily_cap":8}'::jsonb`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_id VARCHAR(255) UNIQUE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_access_token TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_refresh_token TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP`
  ];
  
  for (const query of alterQueries) {
    try {
      await pool.query(query);
    } catch (e) {
      // Column already exists or other non-critical error
    }
  }
  
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
}

async function ensureTestUser() {
  const testEmail = 'test@test.com';
  const testPass = 'test123';
  const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [testEmail]);
  if (existingUser.rows.length === 0) {
    const hash = await bcrypt.hash(testPass, 10);
    await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3)',
      ['Test User', testEmail, hash]
    );
    console.log(`✅ Test user created: ${testEmail} / ${testPass}`);
  }
}

/* ------------------------------ Middleware -------------------------------- */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }
  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.userId = payload.userId;
    next();
  });
}

/* --------------------------------- Routes --------------------------------- */

// Auth Routes
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = result.rows[0];
    if (!user.password) {
      return res.status(401).json({ error: 'Please use OAuth login (Google/Microsoft)' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ 
      token, 
      user: { 
        id: user.id, 
        name: user.name, 
        email: user.email,
        profile_picture: user.profile_picture,
        timezone: user.timezone
      } 
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, google_id, microsoft_id, default_calendar_id, profile_picture, timezone, working_hours, booking_preferences FROM users WHERE id = $1',
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Google OAuth Routes
app.get('/api/auth/google', (req, res) => {
  try {
    if (!googleAuth) {
      return res.status(503).json({ error: 'Google Calendar integration is not configured' });
    }
    const authUrl = googleAuth.getAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating Google auth URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

app.get('/api/calendar/google/callback', async (req, res) => {
  try {
    if (!googleAuth) {
      return res.redirect('/login?error=google_not_configured');
    }
    const { code, error: oauthError } = req.query;
    if (oauthError) {
      console.error('Google OAuth error:', oauthError);
      return res.redirect('/login?error=' + encodeURIComponent(oauthError));
    }
    if (!code) {
      return res.redirect('/login?error=no_authorization_code');
    }
    console.log('📝 Received Google OAuth code, exchanging for tokens...');
    const tokens = await googleAuth.getTokens(code);
    console.log('✅ Got tokens from Google');
    const userInfo = await googleAuth.getUserInfo(tokens.access_token);
    console.log('✅ Got user info:', userInfo.email);
    let userResult = await pool.query('SELECT id, email, name FROM users WHERE email = $1', [userInfo.email]);
    let userId;
    if (userResult.rows.length === 0) {
      console.log('📝 Creating new user from Google OAuth...');
      const newUser = await pool.query(
        `INSERT INTO users (name, email, google_id, google_access_token, google_refresh_token, profile_picture)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, name`,
        [userInfo.name, userInfo.email, userInfo.sub, tokens.access_token, tokens.refresh_token, userInfo.picture]
      );
      userId = newUser.rows[0].id;
      console.log('✅ Created new user:', userInfo.email);
    } else {
      console.log('📝 Updating existing user with Google credentials...');
      await pool.query(
        `UPDATE users 
         SET google_id = $1,
             google_access_token = $2,
             google_refresh_token = $3,
             profile_picture = $4
         WHERE email = $5`,
        [userInfo.sub, tokens.access_token, tokens.refresh_token, userInfo.picture, userInfo.email]
      );
      userId = userResult.rows[0].id;
      console.log('✅ Updated user:', userInfo.email);
    }
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    res.redirect(`/dashboard?token=${token}&google=connected`);
  } catch (error) {
    console.error('❌ Error in Google OAuth callback:', error.message);
    res.redirect('/login?error=' + encodeURIComponent(error.message));
  }
});

// Microsoft OAuth Routes
app.get('/api/auth/microsoft', (req, res) => {
  try {
    if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CALLBACK_URL) {
      return res.status(503).json({ error: 'Microsoft Calendar integration is not configured' });
    }
    const authUrl = `${MICROSOFT_AUTH_URL}?` +
      `client_id=${encodeURIComponent(MICROSOFT_CLIENT_ID)}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(MICROSOFT_CALLBACK_URL)}` +
      `&response_mode=query` +
      `&scope=${encodeURIComponent(MICROSOFT_SCOPES)}`;
    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating Microsoft auth URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

app.get('/api/calendar/microsoft/callback', async (req, res) => {
  try {
    const { code, error: oauthError } = req.query;
    if (oauthError) {
      console.error('Microsoft OAuth error:', oauthError);
      return res.redirect('/login?error=' + encodeURIComponent(oauthError));
    }
    if (!code) {
      return res.redirect('/login?error=no_authorization_code');
    }
    console.log('📝 Received Microsoft OAuth code, exchanging for tokens...');
    const tokenResponse = await axios.post(MICROSOFT_TOKEN_URL, new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      code: code,
      redirect_uri: MICROSOFT_CALLBACK_URL,
      grant_type: 'authorization_code'
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const { access_token, refresh_token } = tokenResponse.data;
    console.log('✅ Got tokens from Microsoft');
    const userResponse = await axios.get(`${MICROSOFT_GRAPH_URL}/me`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const userInfo = userResponse.data;
    const email = userInfo.mail || userInfo.userPrincipalName;
    const name = userInfo.displayName || email.split('@')[0];
    console.log('✅ Got user info:', email);
    let userResult = await pool.query('SELECT id, email, name FROM users WHERE email = $1', [email]);
    let userId;
    if (userResult.rows.length === 0) {
      console.log('📝 Creating new user from Microsoft OAuth...');
      const newUser = await pool.query(
        `INSERT INTO users (name, email, microsoft_id, microsoft_access_token, microsoft_refresh_token)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, name`,
        [name, email, userInfo.id, access_token, refresh_token]
      );
      userId = newUser.rows[0].id;
      console.log('✅ Created new user:', email);
    } else {
      console.log('📝 Updating existing user with Microsoft credentials...');
      await pool.query(
        `UPDATE users 
         SET microsoft_id = $1,
             microsoft_access_token = $2,
             microsoft_refresh_token = $3
         WHERE email = $4`,
        [userInfo.id, access_token, refresh_token, email]
      );
      userId = userResult.rows[0].id;
      console.log('✅ Updated user:', email);
    }
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    res.redirect(`/dashboard?token=${token}&microsoft=connected`);
  } catch (error) {
    console.error('❌ Error in Microsoft OAuth callback:', error.response?.data || error.message);
    res.redirect('/login?error=' + encodeURIComponent(error.message));
  }
});

// Calendar Routes
app.get('/api/calendars/google', authenticateToken, async (req, res) => {
  try {
    if (!googleAuth) {
      return res.status(503).json({ error: 'Google Calendar integration is not configured' });
    }
    const userId = req.userId;
    const userResult = await pool.query(
      'SELECT google_access_token, google_refresh_token FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];
    if (!user.google_access_token || !user.google_refresh_token) {
      return res.status(401).json({ 
        error: 'Google Calendar not connected. Please connect your calendar first.',
        needsAuth: true 
      });
    }
    try {
      const calendars = await googleAuth.getCalendars(user.google_access_token);
      res.json(calendars);
    } catch (calError) {
      console.error('Error fetching Google calendars:', calError);
      if (calError.message.includes('401') || calError.message.includes('expired')) {
        return res.status(401).json({ 
          error: 'Calendar access expired. Please reconnect your Google Calendar.',
          needsReauth: true 
        });
      }
      throw calError;
    }
  } catch (error) {
    console.error('Error fetching Google calendars:', error);
    res.status(500).json({ error: 'Failed to fetch calendars' });
  }
});

app.get('/api/calendars/microsoft', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const userResult = await pool.query(
      'SELECT microsoft_access_token, microsoft_refresh_token FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];
    if (!user.microsoft_access_token || !user.microsoft_refresh_token) {
      return res.status(401).json({ 
        error: 'Microsoft Calendar not connected. Please connect your calendar first.',
        needsAuth: true 
      });
    }
    try {
      const response = await axios.get(`${MICROSOFT_GRAPH_URL}/me/calendars`, {
        headers: { Authorization: `Bearer ${user.microsoft_access_token}` }
      });
      const calendars = response.data.value.map(cal => ({
        id: cal.id,
        name: cal.name,
        primary: cal.isDefaultCalendar || false,
        canEdit: cal.canEdit !== false,
        owner: cal.owner?.name || cal.owner?.address,
        color: cal.color
      }));
      res.json(calendars);
    } catch (calError) {
      console.error('Error fetching Microsoft calendars:', calError.response?.data || calError);
      if (calError.response?.status === 401) {
        return res.status(401).json({ 
          error: 'Calendar access expired. Please reconnect your Microsoft Calendar.',
          needsReauth: true 
        });
      }
      throw calError;
    }
  } catch (error) {
    console.error('Error fetching Microsoft calendars:', error);
    res.status(500).json({ error: 'Failed to fetch calendars' });
  }
});

app.post('/api/calendar/google/disconnect', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    await pool.query(
      `UPDATE users 
       SET google_access_token = NULL,
           google_refresh_token = NULL,
           google_id = NULL,
           default_calendar_id = NULL
       WHERE id = $1`,
      [userId]
    );
    res.json({ success: true, message: 'Google Calendar disconnected successfully' });
  } catch (error) {
    console.error('Error disconnecting Google calendar:', error);
    res.status(500).json({ error: 'Failed to disconnect calendar' });
  }
});

app.post('/api/calendar/microsoft/disconnect', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    await pool.query(
      `UPDATE users 
       SET microsoft_access_token = NULL,
           microsoft_refresh_token = NULL,
           microsoft_id = NULL
       WHERE id = $1`,
      [userId]
    );
    res.json({ success: true, message: 'Microsoft Calendar disconnected successfully' });
  } catch (error) {
    console.error('Error disconnecting Microsoft calendar:', error);
    res.status(500).json({ error: 'Failed to disconnect calendar' });
  }
});

/* --------------------------------- 404 ------------------------------------ */
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

/* ---------------------------- Graceful Shutdown --------------------------- */
let server;

function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  serverReady = false;
  
  if (server) {
    server.close(async () => {
      console.log('HTTP server closed');
      try {
        await pool.end();
        console.log('Database connections closed');
        process.exit(0);
      } catch (err) {
        console.error('Error closing database:', err);
        process.exit(1);
      }
    });
    
    // Force shutdown after 10 seconds
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  shutdown('UNCAUGHT_EXCEPTION');
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown('UNHANDLED_REJECTION');
});

/* ------------------------------- Start Server ----------------------------- */
async function startServer() {
  try {
    // Step 1: Test database connection
    console.log('🔄 Testing database connection...');
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');
    
    // Step 2: Initialize database schema
    console.log('🔄 Initializing database schema...');
    await initDatabase();
    console.log('✅ Database schema ready');
    
    // Step 3: Ensure test user exists
    console.log('🔄 Checking test user...');
    await ensureTestUser();
    
    // Step 4: Mark database as ready
    dbReady = true;
    console.log('✅ Database fully initialized');
    
    // Step 5: Start HTTP server
    console.log(`🔄 Starting HTTP server on port ${PORT}...`);
    server = app.listen(PORT, '0.0.0.0', () => {
      serverReady = true;
      console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
      console.log('✅ ScheduleSync API Running');
      console.log(`✅ Health check available at http://0.0.0.0:${PORT}/health`);
      console.log(`✅ Ready check available at http://0.0.0.0:${PORT}/ready\n`);
    });
    
    // Handle server errors
    server.on('error', (err) => {
      console.error('❌ Server error:', err);
      process.exit(1);
    });
    
  } catch (err) {
    console.error('❌ Failed to start server:', err.message);
    console.error('Stack trace:', err.stack);
    process.exit(1);
  }
}

// Start the server
startServer();