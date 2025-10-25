// ============================================================================
// ScheduleSync API Server - Final Version
// Google OAuth Fixed + Microsoft OAuth Support
// ============================================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');

// ============================================================================
// SERVICES
// ============================================================================

let googleAuth = null;
try {
  googleAuth = require('./google-auth-service');
  console.log('✅ Google Auth service loaded');
} catch (error) {
  console.log('⚠️  Google Auth service not found');
}

let microsoftAuth = null;
try {
  microsoftAuth = require('./microsoft-auth-service');
  console.log('✅ Microsoft Auth service loaded');
} catch (error) {
  console.log('ℹ️  Microsoft Auth service not found');
}

let emailService = null;
try {
  emailService = require('./email-service');
  console.log('✅ Email service loaded');
} catch (error) {
  console.log('ℹ️  Email service not found');
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'schedulesync-secret-change-in-production';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Database connection
const pool = new Pool({
  connectionString: process.env.DB_CONNECTION_STRING || process.env.DATABASE_URL,
  ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ============================================================================
// EXPRESS APP SETUP
// ============================================================================

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); // 🔥 CRITICAL for OAuth!

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// DATABASE INITIALIZATION
// ============================================================================

async function initDatabase() {
  try {
    await pool.query('SELECT 1');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255),
        google_id VARCHAR(255),
        google_access_token TEXT,
        google_refresh_token TEXT,
        microsoft_id VARCHAR(255),
        microsoft_access_token TEXT,
        microsoft_refresh_token TEXT,
        profile_picture TEXT,
        timezone VARCHAR(100) DEFAULT 'UTC',
        reset_token VARCHAR(255),
        reset_token_expiry TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP NOT NULL,
        attendee_email VARCHAR(255),
        attendee_name VARCHAR(255),
        meet_link TEXT,
        calendar_event_id TEXT,
        calendar_provider VARCHAR(50),
        status VARCHAR(50) DEFAULT 'confirmed',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS calendar_integrations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL,
        calendar_id VARCHAR(255) NOT NULL,
        calendar_name VARCHAR(255),
        is_primary BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, provider, calendar_id)
      )
    `);

    console.log('✅ Database schema initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
    process.exit(1);
  }
}

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================

function authenticateToken(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ============================================================================
// GOOGLE OAUTH ROUTES
// ============================================================================

app.get('/auth/google', (req, res) => {
  if (!googleAuth) return res.status(501).json({ error: 'Google OAuth not configured' });
  try {
    const authUrl = googleAuth.getAuthUrl();
    res.redirect(authUrl);
  } catch (error) {
    console.error('❌ Error generating Google auth URL:', error);
    res.redirect('/login?error=oauth_config_error');
  }
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  
  if (error || !code) return res.redirect('/login?error=oauth_failed');

  try {
    const tokens = await googleAuth.getTokensFromCode(code);
    const userInfo = await googleAuth.getUserInfo(tokens.access_token);

    let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [userInfo.email]);
    let user;

    if (userResult.rows.length > 0) {
      const updateResult = await pool.query(
        `UPDATE users SET google_id = $1, google_access_token = $2, google_refresh_token = COALESCE($3, google_refresh_token),
         name = $4, profile_picture = $5 WHERE email = $6 RETURNING id, name, email, profile_picture`,
        [userInfo.google_id, tokens.access_token, tokens.refresh_token, userInfo.name, userInfo.picture, userInfo.email]
      );
      user = updateResult.rows[0];
      console.log('✅ Google OAuth: User updated', user.id);
    } else {
      const insertResult = await pool.query(
        `INSERT INTO users (name, email, google_id, google_access_token, google_refresh_token, profile_picture)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, profile_picture`,
        [userInfo.name, userInfo.email, userInfo.google_id, tokens.access_token, tokens.refresh_token, userInfo.picture]
      );
      user = insertResult.rows[0];
      console.log('✅ Google OAuth: New user created', user.id);
    }

    const jwtToken = jwt.sign({ userId: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    
    res.cookie('token', jwtToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    console.log('✅ ✅ ✅ Google OAuth SUCCESS:', user.email);
    return res.redirect('/dashboard.html');
  } catch (error) {
    console.error('❌ Google OAuth failed:', error.message);
    return res.redirect('/login?error=oauth_failed');
  }
});

// ============================================================================
// MICROSOFT OAUTH ROUTES
// ============================================================================

app.get('/auth/microsoft', (req, res) => {
  if (!microsoftAuth) return res.status(501).json({ error: 'Microsoft OAuth not configured' });
  try {
    const authUrl = microsoftAuth.getAuthUrl();
    res.redirect(authUrl);
  } catch (error) {
    console.error('❌ Error generating Microsoft auth URL:', error);
    res.redirect('/login?error=oauth_config_error');
  }
});

app.get('/auth/microsoft/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/login?error=oauth_failed');

  try {
    const tokens = await microsoftAuth.getTokensFromCode(code);
    const userInfo = await microsoftAuth.getUserInfo(tokens.access_token);

    let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [userInfo.email]);
    let user;

    if (userResult.rows.length > 0) {
      const updateResult = await pool.query(
        `UPDATE users SET microsoft_id = $1, microsoft_access_token = $2, microsoft_refresh_token = COALESCE($3, microsoft_refresh_token),
         name = $4 WHERE email = $5 RETURNING id, name, email`,
        [userInfo.microsoft_id, tokens.access_token, tokens.refresh_token, userInfo.name, userInfo.email]
      );
      user = updateResult.rows[0];
    } else {
      const insertResult = await pool.query(
        `INSERT INTO users (name, email, microsoft_id, microsoft_access_token, microsoft_refresh_token)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email`,
        [userInfo.name, userInfo.email, userInfo.microsoft_id, tokens.access_token, tokens.refresh_token]
      );
      user = insertResult.rows[0];
    }

    const jwtToken = jwt.sign({ userId: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    
    res.cookie('token', jwtToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    console.log('✅ Microsoft OAuth SUCCESS:', user.email);
    return res.redirect('/dashboard.html');
  } catch (error) {
    console.error('❌ Microsoft OAuth failed:', error);
    return res.redirect('/login?error=oauth_failed');
  }
});

// ============================================================================
// EMAIL/PASSWORD AUTH
// ============================================================================

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hashedPassword]
    );

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user });
  } catch (error) {
    console.error('❌ Signup error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'email_not_found' });

    const user = result.rows[0];
    if (!user.password) return res.status(401).json({ error: 'no_password', message: 'Use OAuth' });

    const isHashed = user.password.startsWith('$2b$') || user.password.startsWith('$2a$');
    let passwordValid = isHashed ? await bcrypt.compare(password, user.password) : password === user.password;

    if (passwordValid && !isHashed) {
      const hashedPassword = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, user.id]);
    }

    if (!passwordValid) return res.status(401).json({ error: 'wrong_password' });

    const token = jwt.sign({ userId: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/verify', (req, res) => {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ authenticated: false });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true, user: { id: decoded.userId, email: decoded.email, name: decoded.name } });
  } catch (error) {
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
  } catch (error) {
    return res.redirect('/login?error=session_expired');
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'healthy',
      googleAuth: !!googleAuth,
      microsoftAuth: !!microsoftAuth,
      emailService: !!emailService,
    });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy' });
  }
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// START SERVER - NO RETRY LOOP!
// ============================================================================

async function startServer() {
  try {
    await initDatabase();
    
    app.listen(PORT, HOST, () => {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`🚀 ScheduleSync API Server`);
      console.log(`📍 ${HOST}:${PORT}`);
      console.log(`🌍 ${NODE_ENV}`);
      console.log(`✅ Database: Connected`);
      console.log(`✅ Cookie Parser: Enabled`);
      console.log(`${googleAuth ? '✅' : '❌'} Google OAuth`);
      console.log(`${microsoftAuth ? '✅' : '❌'} Microsoft OAuth`);
      console.log(`${emailService ? '✅' : '❌'} Email Service`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    });
  } catch (error) {
    console.error('❌ Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  pool.end();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  pool.end();
  process.exit(0);
});

startServer();