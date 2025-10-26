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
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto'); // For generating unique tokens

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
// Health check endpoint for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});
/* ---------------------------------- Config --------------------------------- */
const clean = (v) => (v || '').trim();

const PORT = process.env.PORT || 8080;
const JWT_SECRET = clean(process.env.JWT_SECRET) || 'schedulesync-secret-2025';

// Database - Use DB_CONNECTION_STRING (to bypass Railway auto-injection) or fallback to DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DB_CONNECTION_STRING || process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Auto-run migrations on startup
// FIXED AUTO-MIGRATION - Replace the runMigrations() function in server.js

// ROBUST AUTO-MIGRATION - Replace runMigrations() in server.js
// This version adds missing columns instead of dropping tables

// POSTGRESQL-COMPATIBLE MIGRATION - Replace runMigrations() in server.js

/*async function runMigrations() {
  console.log('🔄 Running database migrations...');
  try {
    // Create booking_requests table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS booking_requests (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
        recipient_email VARCHAR(255) NOT NULL,
        recipient_name VARCHAR(255) NOT NULL,
        team_members INTEGER[] NOT NULL,
        custom_message TEXT,
        unique_token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        guest_calendar_connected BOOLEAN DEFAULT FALSE,
        booked_slot_start TIMESTAMP,
        booked_slot_end TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ booking_requests table created');

    // Create indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_booking_requests_token ON booking_requests(unique_token)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_booking_requests_status ON booking_requests(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_booking_requests_team ON booking_requests(team_id)`);
    console.log('✅ Indexes created');
    
    // Create team_members table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) DEFAULT 'member',
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(team_id, user_id)
      )
    `);
    console.log('✅ team_members table exists');

    // Check if is_owner column exists
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'team_members' 
      AND column_name = 'is_owner'
    `);

    // Add is_owner column if it doesn't exist
    if (columnCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE team_members ADD COLUMN is_owner BOOLEAN DEFAULT FALSE`);
      console.log('✅ is_owner column added');
    } else {
      console.log('✅ is_owner column already exists');
    }

    // Create team_members indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id)`);
    console.log('✅ team_members indexes created');
    
    // Add existing team owners to team_members
    await pool.query(`
      INSERT INTO team_members (team_id, user_id, role, is_owner)
      SELECT id, owner_id, 'owner', TRUE
      FROM teams
      WHERE NOT EXISTS (
        SELECT 1 FROM team_members 
        WHERE team_members.team_id = teams.id 
        AND team_members.user_id = teams.owner_id
      )
    `);
    console.log('✅ Team owners added to team_members');
    
    console.log('🎉 All migrations completed successfully!');
  } catch (error) {
    console.error('❌ Migration error:', error.message);
    // Continue execution even if migration fails
  }
}
*/
runMigrations();

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
  
  // Add Microsoft OAuth columns if they don't exist
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_id VARCHAR(255) UNIQUE`);
    console.log('✅ Added microsoft_id column');
  } catch (e) { /* Already exists */ }
  
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_access_token TEXT`);
    console.log('✅ Added microsoft_access_token column');
  } catch (e) { /* Already exists */ }
  
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_refresh_token TEXT`);
    console.log('✅ Added microsoft_refresh_token column');
  } catch (e) { /* Already exists */ }
  
  // Add password reset token columns
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT`);
    console.log('✅ Added reset_token column');
  } catch (e) { /* Already exists */ }
  
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP`);
    console.log('✅ Added reset_token_expires column');
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

  let h, m;
  
  // Check if time has AM/PM (12-hour format)
  const parts = String(timeStr).trim().split(/\s+/);
  
  if (parts.length >= 2) {
    // 12-hour format: "4:00 PM" or "11:30 AM"
    const [hm, ampmRaw] = parts;
    const [hRaw, mRaw = '0'] = hm.split(':');
    h = parseInt(hRaw, 10);
    m = parseInt(mRaw, 10);
    const ampm = (ampmRaw || '').toUpperCase();

    if (isNaN(h) || isNaN(m)) return null;

    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
  } else {
    // 24-hour format: "16:00" or "09:30"
    const [hRaw, mRaw = '0'] = timeStr.split(':');
    h = parseInt(hRaw, 10);
    m = parseInt(mRaw, 10);
    
    if (isNaN(h) || isNaN(m)) return null;
  }

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

/* --------------------------------- Root ----------------------------------- */
// API status endpoint moved to /api/status
app.get('/api/status', (_req, res) => {
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
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check if user exists
    const out = await pool.query('SELECT id, name, email, password FROM users WHERE email = $1', [email]);
    
    if (!out.rowCount) {
      console.log('❌ Login failed: No account found with email:', email);
      return res.status(401).json({ 
        error: 'No account found with this email address',
        type: 'email_not_found'
      });
    }

    const user = out.rows[0];

    // Check if user has a password set
    if (!user.password) {
      console.log('⚠️ Login failed: No password set for user:', email);
      return res.status(401).json({ 
        error: 'Please use Google or Microsoft sign-in, or reset your password',
        type: 'no_password'
      });
    }

    // Check if password is hashed (starts with $2b$ for bcrypt)
    let passwordValid = false;
    if (user.password.startsWith('$2b$')) {
      // Hashed password - use bcrypt compare
      passwordValid = await bcrypt.compare(password, user.password);
      console.log(`🔐 Password check for ${email}:`, passwordValid ? 'Valid ✅' : 'Invalid ❌');
    } else {
      // Plain text password (old accounts) - direct compare
      passwordValid = user.password === password;
      console.log(`🔓 Plain text password check for ${email}:`, passwordValid ? 'Valid ✅' : 'Invalid ❌');
      
      // If valid, upgrade to hashed password
      if (passwordValid) {
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, user.id]);
        console.log('✅ Upgraded password to hashed for user:', user.email);
      }
    }

    if (!passwordValid) {
      console.log('❌ Login failed: Incorrect password for:', email);
      return res.status(401).json({ 
        error: 'Incorrect password. Please try again or use "Forgot password?"',
        type: 'wrong_password'
      });
    }

    console.log('✅ Login successful for user:', email);
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ 
      success: true, 
      token, 
      user: { 
        id: user.id, 
        name: user.name, 
        email: user.email 
      } 
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
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

// Check if email exists
app.post('/api/auth/check-email', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    res.json({ exists: result.rows.length > 0 });
  } catch (error) {
    console.error('Error checking email:', error);
    res.status(500).json({ error: 'Failed to check email' });
  }
});

// Forgot Password - Send reset email
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if user exists
    const userResult = await pool.query('SELECT id, name, email FROM users WHERE email = $1', [email]);

    if (userResult.rows.length === 0) {
      // For security, return success even if user doesn't exist
      return res.json({ success: true, message: 'If an account exists, a reset link has been sent' });
    }

    const user = userResult.rows[0];

    // Generate reset token
    const resetToken = jwt.sign({ userId: user.id, type: 'password_reset' }, JWT_SECRET, { expiresIn: '1h' });
    
    // Store reset token in database (optional - for extra security)
    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expires = NOW() + INTERVAL \'1 hour\' WHERE id = $2',
      [resetToken, user.id]
    );

    // Create reset link
    const resetLink = `https://schedulesync-production.up.railway.app/reset-password?token=${resetToken}`;

    // Send email using nodemailer directly
    if (emailService && emailService.sendPasswordReset) {
      // If email service has password reset method, use it
      try {
        await emailService.sendPasswordReset(email, user.name, resetLink);
        console.log('✅ Password reset email sent to:', email);
        res.json({ success: true, message: 'Password reset link sent' });
      } catch (error) {
        console.error('❌ Failed to send email:', error);
        // Still return success but log the link for testing
        console.log('🔗 Password reset link:', resetLink);
        res.json({ success: true, message: 'Password reset link generated' });
      }
    } else {
      // Email service not available - log the link for testing
      console.log('ℹ️  Email service not configured');
      console.log('🔗 Password reset link (copy this):', resetLink);
      res.json({ success: true, message: 'Password reset link generated', resetLink: resetLink });
    }
  } catch (error) {
    console.error('Error in forgot password:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// Reset Password - Actually reset the password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.type !== 'password_reset') {
        return res.status(400).json({ error: 'Invalid token type' });
      }
    } catch (error) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    // Check if token matches and hasn't expired
    const userResult = await pool.query(
      'SELECT id, reset_token, reset_token_expires FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Check if token matches (optional extra security)
    if (user.reset_token !== token) {
      return res.status(400).json({ error: 'Token mismatch' });
    }

    // Check if token expired
    if (new Date() > new Date(user.reset_token_expires)) {
      return res.status(400).json({ error: 'Token has expired. Please request a new password reset.' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Get user info for email
    const userInfo = await pool.query('SELECT name, email FROM users WHERE id = $1', [decoded.userId]);
    const userName = userInfo.rows[0]?.name || 'User';
    const userEmail = userInfo.rows[0]?.email;

    // Update password and clear reset token
    await pool.query(
      'UPDATE users SET password = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
      [hashedPassword, decoded.userId]
    );

    // Send confirmation email
    if (emailService && emailService.sendPasswordChanged && userEmail) {
      emailService.sendPasswordChanged(userEmail, userName)
        .catch(err => console.error('Failed to send password changed email:', err));
    }

    console.log('✅ Password reset successfully for user:', decoded.userId);
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ error: 'Failed to reset password' });
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

    // Encode user data to pass to frontend
    const userData = encodeURIComponent(JSON.stringify({
      id: dbUser.id,
      name: dbUser.name,
      email: dbUser.email,
      picture: dbUser.profile_picture
    }));

    // Redirect to dashboard with token and user data
    console.log('➡️  Redirecting to dashboard');
    res.redirect(`/dashboard?token=${token}&user=${userData}`);

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
app.get('/api/analytics/dashboard', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const a = { totalBookings: 0, upcomingMeetings: 0, completedMeetings: 0, teamMembers: 0, recentActivity: [] };
    
    try {
      // Count bookings for user's teams only
      const r = await pool.query(
        `SELECT COUNT(*) AS c FROM bookings b
         JOIN teams t ON b.team_id = t.id
         WHERE t.owner_id = $1`,
        [userId]
      );
      a.totalBookings = parseInt(r.rows[0]?.c || 0);
    } catch (e) {
      console.error('Error counting bookings:', e);
    }
    
    try {
      // Count upcoming meetings for user's teams
      const r = await pool.query(
        `SELECT COUNT(*) AS c FROM bookings b
         JOIN teams t ON b.team_id = t.id
         WHERE t.owner_id = $1 AND b.booking_date >= CURRENT_DATE`,
        [userId]
      );
      a.upcomingMeetings = parseInt(r.rows[0]?.c || 0);
    } catch (e) {
      console.error('Error counting upcoming meetings:', e);
    }
    
    try {
      // Count team members across all user's teams
      const r = await pool.query(
        `SELECT COUNT(DISTINCT tm.id) AS c FROM team_members tm
         JOIN teams t ON tm.team_id = t.id
         WHERE t.owner_id = $1`,
        [userId]
      );
      a.teamMembers = parseInt(r.rows[0]?.c || 0);
    } catch (e) {
      console.error('Error counting team members:', e);
    }
    
    res.json(a);
  } catch (e) {
    console.error('Error in analytics:', e);
    res.json({ totalBookings: 0, upcomingMeetings: 0, completedMeetings: 0, teamMembers: 0, recentActivity: [] });
  }
});

/* ============================================================================
   TEAMS API ENDPOINTS
   ========================================================================== */

// Get all teams for current user
// REPLACE the /api/teams/:teamId/members endpoint in server.js with this:
// Get all teams for current user
// ULTRA-SIMPLE VERSION - Replace /api/teams/:teamId/members with this:

app.get('/api/teams/:teamId/members', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId; // From authenticateToken middleware
    
    console.log('📋 Fetching members for user:', userId);

    // Get user info - simplest possible query
    const result = await pool.query(
      'SELECT id, email, display_name FROM users WHERE id = $1',
      [userId]
    );

    console.log('📋 Query result:', result.rows);

    if (result.rows.length === 0) {
      console.log('❌ User not found:', userId);
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    
    const response = {
      members: [{
        user_id: user.id,
        email: user.email,
        display_name: user.display_name || user.email,
        is_owner: true,
        role: 'owner'
      }]
    };

    console.log('✅ Returning members:', response);
    return res.json(response);

  } catch (error) {
    console.error('❌ Error fetching team members:', error);
    console.error('❌ Error details:', error.message);
    console.error('❌ Error stack:', error.stack);
    return res.status(500).json({ 
      error: 'Failed to fetch team members',
      details: error.message 
    });
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
       JOIN users u ON t.owner_id = u.id
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
    

    // ===================== VALIDATE AVAILABILITY =====================
    console.log('📅 Validating availability for date:', date, 'time:', time);
    
    // Get Day of Week
    const bookingDate = new Date(date);
    const dayOfWeek = bookingDate.getDay();
    const adjustedDayOfWeek = dayOfWeek === 0 ? 7 : dayOfWeek;
    
    // Check if owner has availability set for this day
    const availabilityResult = await pool.query(
      'SELECT * FROM time_slots WHERE user_id = $1 AND day_of_week = $2',
      [team.owner_id, adjustedDayOfWeek]
    );
    
    if (availabilityResult.rows.length === 0) {
      console.log('❌ No availability set for this day');
      return res.status(400).json({ 
        error: 'The selected day is not available for bookings',
        reason: 'day_unavailable'
      });
    }
    
    const availability = availabilityResult.rows[0];
    console.log('✅ Found availability:', availability.start_time, '-', availability.end_time);
    
    // Check if time is within available hours
    const [reqHour, reqMin] = time.split(':').map(Number);
    const requestedMinutes = reqHour * 60 + reqMin;
    const [startHour, startMin] = availability.start_time.split(':').map(Number);
    const [endHour, endMin] = availability.end_time.split(':').map(Number);
    const availStartMinutes = startHour * 60 + startMin;
    const availEndMinutes = endHour * 60 + endMin;
    const requestedEndMinutes = requestedMinutes + 60; // 1 hour booking
    
    if (requestedMinutes < availStartMinutes || requestedEndMinutes > availEndMinutes) {
      console.log('❌ Time outside available hours');
      return res.status(400).json({ 
        error: `Requested time is outside available hours (${availability.start_time} - ${availability.end_time})`,
        reason: 'time_unavailable',
        available_hours: {
          start: availability.start_time,
          end: availability.end_time
        }
      });
    }
    
    // Check for booking conflicts
    const conflictResult = await pool.query(
      'SELECT * FROM bookings WHERE team_id = $1 AND booking_date = $2 AND booking_time = $3 AND status != $4',
      [numericTeamId, date, time, 'cancelled']
    );
    
    if (conflictResult.rows.length > 0) {
      console.log('❌ Time slot already booked');
      return res.status(409).json({ 
        error: 'This time slot is already booked',
        reason: 'slot_conflict'
      });
    }
    
    console.log('✅ All validations passed - creating booking');

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

/* ============================================================================
   SMART BOOKING ASSISTANT API ENDPOINTS
   ========================================================================== */

// Find common available slots between host and guest
app.post('/api/booking/find-slots', async (req, res) => {
  try {
    const { team_id, guest_email } = req.body;

    if (!team_id || !guest_email) {
      return res.status(400).json({ error: 'team_id and guest_email required' });
    }

    // Get team and host info
    const teamResult = await pool.query(
      `SELECT t.*, u.email as host_email, u.google_access_token, u.google_refresh_token, u.display_name as host_name
       FROM teams t
       JOIN users u ON t.user_id = u.id
       WHERE t.id = $1 OR t.public_url = $1`,
      [team_id]
    );

    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const team = teamResult.rows[0];

    if (!team.google_access_token) {
      return res.status(400).json({ 
        error: 'Host calendar not connected',
        message: 'The host needs to connect their Google Calendar'
      });
    }

    // Get busy times for host (next 14 days)
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 14);

    const hostBusyTimes = await googleAuth.getCalendarBusyTimes(
      team.google_access_token,
      team.google_refresh_token,
      startDate,
      endDate
    );

    // Try to get guest's busy times (if they have connected calendar)
    let guestBusyTimes = [];
    const guestResult = await pool.query(
      'SELECT google_access_token, google_refresh_token FROM users WHERE email = $1',
      [guest_email]
    );

    if (guestResult.rows.length > 0 && guestResult.rows[0].google_access_token) {
      const guest = guestResult.rows[0];
      guestBusyTimes = await googleAuth.getCalendarBusyTimes(
        guest.google_access_token,
        guest.google_refresh_token,
        startDate,
        endDate
      );
    }

    // Find common free slots
    const availableSlots = [];
    const currentDate = new Date(startDate);
    const meetingDuration = 60; // 60 minutes default

    while (currentDate < endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      
      // Check business hours (9 AM - 5 PM)
      for (let hour = 9; hour < 17; hour++) {
        const slotStart = new Date(`${dateStr}T${hour.toString().padStart(2, '0')}:00:00`);
        const slotEnd = new Date(slotStart);
        slotEnd.setMinutes(slotEnd.getMinutes() + meetingDuration);

        // Skip if slot is in the past
        if (slotStart < new Date()) continue;

        // Check if slot is free for both host and guest
        const hostIsBusy = hostBusyTimes.some(busy => {
          const busyStart = new Date(busy.start);
          const busyEnd = new Date(busy.end);
          return (slotStart < busyEnd && slotEnd > busyStart);
        });

        const guestIsBusy = guestBusyTimes.some(busy => {
          const busyStart = new Date(busy.start);
          const busyEnd = new Date(busy.end);
          return (slotStart < busyEnd && slotEnd > busyStart);
        });

        if (!hostIsBusy && !guestIsBusy) {
          availableSlots.push({
            start: slotStart.toISOString(),
            end: slotEnd.toISOString(),
            date: dateStr,
            time: `${hour.toString().padStart(2, '0')}:00`,
            duration: meetingDuration,
            day_of_week: slotStart.getDay()
          });
        }
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Sort by date (closest first) and return top 10
    availableSlots.sort((a, b) => new Date(a.start) - new Date(b.start));
    const topSlots = availableSlots.slice(0, 10);

    if (topSlots.length === 0) {
      return res.status(404).json({ 
        error: 'No available slots found',
        message: 'No common free time found in the next 14 days'
      });
    }

    res.json({ 
      slots: topSlots,
      total_found: availableSlots.length,
      host_name: team.host_name || team.name,
      guest_calendar_connected: guestBusyTimes.length > 0
    });

  } catch (error) {
    console.error('Error finding slots:', error);
    res.status(500).json({ error: 'Failed to find available slots' });
  }
});

// Create booking with automatic calendar invites
app.post('/api/booking/create', async (req, res) => {
  try {
    const { team_id, slot, guest_name, guest_email, guest_notes } = req.body;

    if (!team_id || !slot || !guest_name || !guest_email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get team and host info
    const teamResult = await pool.query(
      `SELECT t.*, u.email as host_email, u.google_access_token, u.google_refresh_token, u.display_name as host_name
       FROM teams t
       JOIN users u ON t.user_id = u.id
       WHERE t.id = $1 OR t.public_url = $1`,
      [team_id]
    );

    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const team = teamResult.rows[0];

    // Create booking in database
    const bookingResult = await pool.query(
      `INSERT INTO bookings (
        team_id, guest_name, guest_email, guest_notes, 
        booking_date, booking_time, start_time, end_time, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        team.id,
        guest_name,
        guest_email,
        guest_notes || '',
        slot.date,
        slot.time,
        slot.start,
        slot.end,
        'confirmed'
      ]
    );

    const booking = bookingResult.rows[0];

    // Create calendar event for host
    if (team.google_access_token && googleAuth) {
      try {
        const eventData = {
          summary: `Meeting with ${guest_name}`,
          description: guest_notes || 'Scheduled via ScheduleSync',
          start: {
            dateTime: slot.start,
            timeZone: 'UTC'
          },
          end: {
            dateTime: slot.end,
            timeZone: 'UTC'
          },
          attendees: [
            { email: guest_email, displayName: guest_name }
          ]
        };

        const hostEvent = await googleAuth.createCalendarEvent(
          team.google_access_token,
          team.google_refresh_token,
          eventData
        );

        console.log('✅ Calendar event created for host:', hostEvent.id);
      } catch (calError) {
        console.error('Error creating host calendar event:', calError);
      }
    }

    // Create calendar event for guest (if they have calendar connected)
    const guestResult = await pool.query(
      'SELECT google_access_token, google_refresh_token FROM users WHERE email = $1',
      [guest_email]
    );

    if (guestResult.rows.length > 0 && guestResult.rows[0].google_access_token && googleAuth) {
      try {
        const guest = guestResult.rows[0];
        const eventData = {
          summary: `Meeting with ${team.host_name || team.name}`,
          description: guest_notes || 'Scheduled via ScheduleSync',
          start: {
            dateTime: slot.start,
            timeZone: 'UTC'
          },
          end: {
            dateTime: slot.end,
            timeZone: 'UTC'
          },
          attendees: [
            { email: team.host_email }
          ]
        };

        const guestEvent = await googleAuth.createCalendarEvent(
          guest.google_access_token,
          guest.google_refresh_token,
          eventData
        );

        console.log('✅ Calendar event created for guest:', guestEvent.id);
      } catch (calError) {
        console.error('Error creating guest calendar event:', calError);
      }
    }

    // Send confirmation emails (if email service available)
    if (emailService) {
      try {
        // Email to guest
        await emailService.sendEmail({
          to: guest_email,
          subject: `Meeting Confirmed: ${new Date(slot.start).toLocaleString()}`,
          html: `
            <h2>🎉 Your meeting is confirmed!</h2>
            <p>Hi ${guest_name},</p>
            <p>Your meeting with ${team.host_name || team.name} has been scheduled.</p>
            <p><strong>📅 Date & Time:</strong> ${new Date(slot.start).toLocaleString()}</p>
            <p><strong>⏱️ Duration:</strong> ${slot.duration} minutes</p>
            ${guest_notes ? `<p><strong>📝 Notes:</strong> ${guest_notes}</p>` : ''}
            <p>A calendar invite has been sent to your email.</p>
            <p>Booking ID: ${booking.id}</p>
          `
        });

        // Email to host
        await emailService.sendEmail({
          to: team.host_email,
          subject: `New Booking: ${guest_name}`,
          html: `
            <h2>📅 New Meeting Booked</h2>
            <p>${guest_name} has booked a meeting with you.</p>
            <p><strong>📅 Date & Time:</strong> ${new Date(slot.start).toLocaleString()}</p>
            <p><strong>📧 Guest Email:</strong> ${guest_email}</p>
            ${guest_notes ? `<p><strong>📝 Notes:</strong> ${guest_notes}</p>` : ''}
            <p>A calendar event has been added to your calendar.</p>
          `
        });

        console.log('✅ Confirmation emails sent');
      } catch (emailError) {
        console.error('Error sending emails:', emailError);
      }
    }

    res.json({
      success: true,
      id: booking.id,
      booking,
      host_name: team.host_name || team.name,
      calendar_invites_sent: true
    });

  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});
// ... existing code ...

/* ==========================================================================
   BOOKINGS API ENDPOINTS
   ========================================================================== */

app.post('/api/bookings', handleBookingSubmission);
app.post('/api/teams/bookings/public', handleBookingSubmission);

/* ============================================================================
   SMART BOOKING ASSISTANT API ENDPOINTS  ← Your existing smart booking code
   ========================================================================== */

app.post('/api/booking/find-slots', async (req, res) => {
  // ... existing smart booking code ...
});

app.post('/api/booking/create', async (req, res) => {
  // ... existing smart booking code ...
});

/* ============================================================================
   BOOKING REQUEST API ENDPOINTS - PHASE 1  ← ADD NEW CODE HERE
   ========================================================================== */

app.post('/api/booking-request/create', authenticateToken, async (req, res) => {
  // ... paste code from booking-request-endpoints.js ...
});

/* ============================================================================
   PHASE 1 - COMPLETE ENDPOINTS BUNDLE
   Add these endpoints to your server.js after your existing endpoints
   ========================================================================== */

// ==================== GET ALL TEAMS ====================
app.get('/api/teams', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(
      `SELECT t.*, 
       (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) as member_count
       FROM teams t
       WHERE t.owner_id = $1
       ORDER BY t.created_at DESC`,
      [userId]
    );
    res.json({ teams: result.rows });
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// ==================== GET TEAM MEMBERS ====================
app.get('/api/teams/:teamId/members', authenticateToken, async (req, res) => {
  try {
    const teamId = req.params.teamId;
    const userId = req.userId;

    // Get the current user's info
    const userResult = await pool.query(
      'SELECT id, email, display_name FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // For Phase 1, just return the logged-in user as owner
    return res.json({
      members: [{
        user_id: user.id,
        email: user.email,
        display_name: user.display_name,
        is_owner: true,
        role: 'owner'
      }]
    });

  } catch (error) {
    console.error('Error fetching team members:', error);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// ==================== CREATE BOOKING REQUEST ====================
app.post('/api/booking-request/create', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { team_id, team_members, recipients, custom_message } = req.body;

    // Validation
    if (!team_id || !team_members || !recipients || recipients.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify team ownership
    const teamCheck = await pool.query(
      'SELECT * FROM teams WHERE id = $1 AND owner_id = $2',
      [team_id, userId]
    );

    if (teamCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to create requests for this team' });
    }

    const team = teamCheck.rows[0];

    // Get user info
    const userResult = await pool.query(
      'SELECT display_name, email FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];

    // Create booking requests for each recipient
    const requests = [];

    for (const recipient of recipients) {
      // Generate unique token
      const uniqueToken = crypto.randomBytes(32).toString('hex');

      // Insert booking request
      const result = await pool.query(
        `INSERT INTO booking_requests (
          team_id, 
          created_by, 
          recipient_email, 
          recipient_name, 
          team_members, 
          custom_message,
          unique_token, 
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
          team_id,
          userId,
          recipient.email,
          recipient.name,
          team_members,
          custom_message || '',
          uniqueToken,
          'pending'
        ]
      );

      requests.push(result.rows[0]);

      // Create booking link
      const bookingLink = `${process.env.APP_URL || 'https://schedulesync-production.up.railway.app'}/booking-request/${uniqueToken}`;
      
      // Get team member names
      const memberNames = [];
      for (const memberId of team_members) {
        const memberResult = await pool.query(
          'SELECT display_name, email FROM users WHERE id = $1',
          [memberId]
        );
        if (memberResult.rows.length > 0) {
          memberNames.push(memberResult.rows[0].display_name || memberResult.rows[0].email);
        }
      }

      // Email HTML template
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              line-height: 1.6; 
              color: #333; 
              margin: 0;
              padding: 0;
            }
            .container { 
              max-width: 600px; 
              margin: 0 auto; 
              padding: 20px; 
            }
            .header { 
              background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); 
              color: white; 
              padding: 30px; 
              border-radius: 12px 12px 0 0; 
              text-align: center; 
            }
            .header h1 {
              margin: 0;
              font-size: 28px;
            }
            .content { 
              background: white; 
              padding: 30px; 
              border: 1px solid #e2e8f0; 
              border-top: none; 
              border-radius: 0 0 12px 12px;
            }
            .button { 
              display: inline-block; 
              padding: 14px 32px; 
              background: #7c3aed; 
              color: white !important; 
              text-decoration: none; 
              border-radius: 8px; 
              font-weight: 600; 
              margin: 20px 0; 
            }
            .team-members { 
              background: #f8fafc; 
              padding: 16px; 
              border-radius: 8px; 
              margin: 16px 0; 
            }
            .member { 
              padding: 4px 0; 
              color: #475569; 
            }
            .custom-message {
              background: #f1f5f9;
              padding: 16px;
              border-radius: 8px;
              font-style: italic;
              margin: 16px 0;
              border-left: 3px solid #7c3aed;
            }
            .features {
              color: #64748b;
              font-size: 14px;
              margin-top: 20px;
            }
            .features div {
              padding: 4px 0;
            }
            .footer {
              text-align: center;
              color: #94a3b8;
              font-size: 14px;
              margin-top: 30px;
              padding-top: 20px;
              border-top: 1px solid #e2e8f0;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>📅 Meeting Request</h1>
            </div>
            <div class="content">
              <h2>Hi ${recipient.name}!</h2>
              
              <p><strong>${user.display_name || user.email}</strong> from <strong>${team.name}</strong> would like to schedule a meeting with you.</p>
              
              ${custom_message ? `<div class="custom-message">"${custom_message}"</div>` : ''}
              
              <div class="team-members">
                <strong>📋 Meeting Attendees:</strong>
                ${memberNames.map(name => `<div class="member">• ${name}</div>`).join('')}
              </div>
              
              <p>To find the perfect time that works for everyone, click the button below:</p>
              
              <div style="text-align: center;">
                <a href="${bookingLink}" class="button">
                  📅 Connect Calendar & Book Meeting
                </a>
              </div>
              
              <div class="features">
                <p><strong>Our smart assistant will:</strong></p>
                <div>✓ Connect your calendar</div>
                <div>✓ Analyze everyone's availability</div>
                <div>✓ Find the perfect mutual time</div>
                <div>✓ Automatically book the meeting</div>
              </div>
              
              <div class="footer">
                <p>Powered by ScheduleSync</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `;

      // Send email
      if (emailService) {
        try {
          await emailService.sendEmail({
            to: recipient.email,
            subject: `Meeting Request from ${user.display_name || user.email}`,
            html: emailHtml
          });
          console.log(`✅ Booking request email sent to ${recipient.email}`);
        } catch (emailError) {
          console.error('Error sending email to', recipient.email, ':', emailError);
        }
      } else {
        console.log('⚠️ Email service not configured - request created but email not sent');
      }
    }

    res.json({
      success: true,
      requests_created: requests.length,
      requests: requests
    });

  } catch (error) {
    console.error('Error creating booking request:', error);
    res.status(500).json({ error: 'Failed to create booking request' });
  }
});

/* ============================================================================
   END OF PHASE 1 ENDPOINTS
   ==========================================================================
   */
/* ============================================================================
   STEP 1: ADD THIS AFTER YOUR DATABASE POOL INITIALIZATION
   
   Find this in your server.js (around line 20-40):
   
   const pool = new Pool({
     connectionString: process.env.DATABASE_URL,
     ssl: { rejectUnauthorized: false }
   });
   
   ADD THE CODE BELOW RIGHT AFTER IT:
   ========================================================================== */

// Auto-run database migrations on startup
async function runMigrations() {
  console.log('🔄 Running database migrations...');
  try {
    // Create booking_requests table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS booking_requests (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
        recipient_email VARCHAR(255) NOT NULL,
        recipient_name VARCHAR(255) NOT NULL,
        team_members INTEGER[] NOT NULL,
        custom_message TEXT,
        unique_token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        guest_calendar_connected BOOLEAN DEFAULT FALSE,
        booked_slot_start TIMESTAMP,
        booked_slot_end TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ booking_requests table created');

    // Create indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_booking_requests_token ON booking_requests(unique_token)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_booking_requests_status ON booking_requests(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_booking_requests_team ON booking_requests(team_id)`);
    console.log('✅ Indexes created');
    
    // Create team_members table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) DEFAULT 'member',
        is_owner BOOLEAN DEFAULT FALSE,
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(team_id, user_id)
      )
    `);
    console.log('✅ team_members table created');

    // Create team_members indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id)`);
    console.log('✅ team_members indexes created');
    
    // Add existing team owners to team_members
    await pool.query(`
      INSERT INTO team_members (team_id, user_id, role, is_owner)
      SELECT id, owner_id, 'owner', TRUE
      FROM teams
      ON CONFLICT (team_id, user_id) DO NOTHING
    `);
    console.log('✅ Team owners added to team_members');
    
    console.log('🎉 All migrations completed successfully!');
  } catch (error) {
    console.error('❌ Migration error:', error);
  }
}

// Run migrations
runMigrations();


/* ============================================================================
   STEP 2: ADD THESE ENDPOINTS AFTER YOUR EXISTING BOOKING ENDPOINTS
   
   Find this section in your server.js (around line 1700):
   
   // Smart booking endpoints
   app.post('/api/booking/find-slots', async (req, res) => { ... });
   app.post('/api/booking/create', async (req, res) => { ... });
   
   ADD THE CODE BELOW RIGHT AFTER THOSE:
   ========================================================================== */

/* ============================================================================
   BOOKING REQUEST API ENDPOINTS - PHASE 1
   ========================================================================== */

// Create booking request and send emails
app.post('/api/booking-request/create', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { team_id, team_members, recipients, custom_message } = req.body;

    // Validation
    if (!team_id || !team_members || !recipients || recipients.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify team ownership
    const teamCheck = await pool.query(
      'SELECT * FROM teams WHERE id = $1 AND owner_id = $2',
      [team_id, userId]
    );

    if (teamCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to create requests for this team' });
    }

    const team = teamCheck.rows[0];

    // Get user info
    const userResult = await pool.query(
      'SELECT display_name, email FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];

    // Create booking requests for each recipient
    const requests = [];

    for (const recipient of recipients) {
      // Generate unique token
      const uniqueToken = require('crypto').randomBytes(32).toString('hex');

      // Insert booking request
      const result = await pool.query(
        `INSERT INTO booking_requests (
          team_id, 
          created_by, 
          recipient_email, 
          recipient_name, 
          team_members, 
          custom_message,
          unique_token, 
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
          team_id,
          userId,
          recipient.email,
          recipient.name,
          team_members,
          custom_message || '',
          uniqueToken,
          'pending'
        ]
      );

      requests.push(result.rows[0]);

      // Create booking link
      const bookingLink = `${process.env.APP_URL}/booking-request/${uniqueToken}`;
      
      // Get team member names
      const memberNames = [];
      for (const memberId of team_members) {
        const memberResult = await pool.query(
          'SELECT display_name, email FROM users WHERE id = $1',
          [memberId]
        );
        if (memberResult.rows.length > 0) {
          memberNames.push(memberResult.rows[0].display_name || memberResult.rows[0].email);
        }
      }

      // Email HTML template
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              line-height: 1.6; 
              color: #333; 
              margin: 0;
              padding: 0;
            }
            .container { 
              max-width: 600px; 
              margin: 0 auto; 
              padding: 20px; 
            }
            .header { 
              background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); 
              color: white; 
              padding: 30px; 
              border-radius: 12px 12px 0 0; 
              text-align: center; 
            }
            .header h1 {
              margin: 0;
              font-size: 28px;
            }
            .content { 
              background: white; 
              padding: 30px; 
              border: 1px solid #e2e8f0; 
              border-top: none; 
              border-radius: 0 0 12px 12px;
            }
            .button { 
              display: inline-block; 
              padding: 14px 32px; 
              background: #7c3aed; 
              color: white !important; 
              text-decoration: none; 
              border-radius: 8px; 
              font-weight: 600; 
              margin: 20px 0; 
            }
            .team-members { 
              background: #f8fafc; 
              padding: 16px; 
              border-radius: 8px; 
              margin: 16px 0; 
            }
            .member { 
              padding: 4px 0; 
              color: #475569; 
            }
            .custom-message {
              background: #f1f5f9;
              padding: 16px;
              border-radius: 8px;
              font-style: italic;
              margin: 16px 0;
              border-left: 3px solid #7c3aed;
            }
            .features {
              color: #64748b;
              font-size: 14px;
              margin-top: 20px;
            }
            .features div {
              padding: 4px 0;
            }
            .footer {
              text-align: center;
              color: #94a3b8;
              font-size: 14px;
              margin-top: 30px;
              padding-top: 20px;
              border-top: 1px solid #e2e8f0;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>📅 Meeting Request</h1>
            </div>
            <div class="content">
              <h2>Hi ${recipient.name}!</h2>
              
              <p><strong>${user.display_name || user.email}</strong> from <strong>${team.name}</strong> would like to schedule a meeting with you.</p>
              
              ${custom_message ? `<div class="custom-message">"${custom_message}"</div>` : ''}
              
              <div class="team-members">
                <strong>📋 Meeting Attendees:</strong>
                ${memberNames.map(name => `<div class="member">• ${name}</div>`).join('')}
              </div>
              
              <p>To find the perfect time that works for everyone, click the button below:</p>
              
              <div style="text-align: center;">
                <a href="${bookingLink}" class="button">
                  📅 Connect Calendar & Book Meeting
                </a>
              </div>
              
              <div class="features">
                <p><strong>Our smart assistant will:</strong></p>
                <div>✓ Connect your calendar</div>
                <div>✓ Analyze everyone's availability</div>
                <div>✓ Find the perfect mutual time</div>
                <div>✓ Automatically book the meeting</div>
              </div>
              
              <div class="footer">
                <p>Powered by ScheduleSync</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `;

      // Send email
      if (emailService) {
        try {
          await emailService.sendEmail({
            to: recipient.email,
            subject: `Meeting Request from ${user.display_name || user.email}`,
            html: emailHtml
          });
          console.log(`✅ Booking request email sent to ${recipient.email}`);
        } catch (emailError) {
          console.error('Error sending email to', recipient.email, ':', emailError);
        }
      } else {
        console.log('⚠️ Email service not configured - request created but email not sent');
      }
    }

    res.json({
      success: true,
      requests_created: requests.length,
      requests: requests
    });

  } catch (error) {
    console.error('Error creating booking request:', error);
    res.status(500).json({ error: 'Failed to create booking request' });
  }
});

// Get team members endpoint
app.get('/api/teams/:teamId/members', authenticateToken, async (req, res) => {
  try {
    const teamId = req.params.teamId;
    const userId = req.userId;

    // Verify access to team
    const teamCheck = await pool.query(
      'SELECT * FROM teams WHERE id = $1 AND owner_id = $2',
      [teamId, userId]
    );

    if (teamCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized to access this team' });
    }

    // Try to get team members from team_members table
    const membersResult = await pool.query(
      `SELECT u.id as user_id, u.email, u.display_name, tm.role, tm.is_owner
       FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1
       ORDER BY tm.is_owner DESC, u.display_name ASC`,
      [teamId]
    );

    // If no team members found in junction table, just return the owner
    if (membersResult.rows.length === 0) {
      const ownerResult = await pool.query(
        `SELECT u.id as user_id, u.email, u.display_name
         FROM users u
         JOIN teams t ON t.owner_id = u.id
         WHERE t.id = $1`,
        [teamId]
      );
      
      return res.json({
        members: ownerResult.rows.map(row => ({
          ...row,
          is_owner: true,
          role: 'owner'
        }))
      });
    }

    res.json({ members: membersResult.rows });

  } catch (error) {
    console.error('Error fetching team members:', error);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});


/* ============================================================================
   END OF ADDITIONS
   
   That's it! These are the only two sections you need to add to server.js
   ========================================================================== */



// ... rest of server.js ...

/* ----------------------- Availability Management ----------------------- */

// Save user/team availability
app.post('/api/availability', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { slots, team_id } = req.body;

    console.log('📅 AVAILABILITY SAVE REQUEST');
    console.log('   User ID:', userId);
    console.log('   Slots received:', JSON.stringify(slots, null, 2));
    console.log('   Team ID:', team_id || 'none');

    // Delete existing slots for this user/team
    if (team_id) {
      const deleteResult = await pool.query('DELETE FROM time_slots WHERE team_id = $1', [team_id]);
      console.log('   Deleted', deleteResult.rowCount, 'existing team slots');
    } else {
      const deleteResult = await pool.query('DELETE FROM time_slots WHERE user_id = $1', [userId]);
      console.log('   Deleted', deleteResult.rowCount, 'existing user slots');
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
      console.log('   ✅ Inserted', slots.length, 'new slots');
    } else {
      console.log('   ⚠️ No slots to insert');
    }

    console.log('   ✅ AVAILABILITY SAVED SUCCESSFULLY');
    res.json({ success: true, message: 'Availability saved' });
  } catch (error) {
    console.error('❌ Error saving availability:', error);
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

/* ------------------------- Get Available Slots -------------------------- */

// Get available time slots for a team on a specific date (public - no auth required)
app.get('/api/teams/:teamId/available-slots', async (req, res) => {
  try {
    const { teamId } = req.params;
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required' });
    }
    
    console.log('🔍 Getting available slots for team:', teamId, 'date:', date);
    
    // Find Team
    const isNumeric = /^\d+$/.test(String(teamId));
    let teamResult;
    
    if (isNumeric) {
      teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [parseInt(teamId)]);
    } else {
      teamResult = await pool.query('SELECT * FROM teams WHERE public_url = $1', [teamId]);
    }
    
    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    const team = teamResult.rows[0];
    
    // Get Day of Week (0=Sunday, 6=Saturday -> Convert to 1-7 where 1=Monday, 7=Sunday)
    const bookingDate = new Date(date);
    const dayOfWeek = bookingDate.getDay();
    const adjustedDayOfWeek = dayOfWeek === 0 ? 7 : dayOfWeek;
    
    console.log('📅 Day of week:', adjustedDayOfWeek, '(', ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayOfWeek], ')');
    
    // Check Availability
    const availabilityResult = await pool.query(
      'SELECT * FROM time_slots WHERE user_id = $1 AND day_of_week = $2',
      [team.owner_id, adjustedDayOfWeek]
    );
    
    if (availabilityResult.rows.length === 0) {
      console.log('❌ No availability set for this day');
      return res.json({ 
        available: false, 
        slots: [],
        message: 'No availability on this day'
      });
    }
    
    const availability = availabilityResult.rows[0];
    console.log('✅ Found availability:', availability.start_time, '-', availability.end_time);
    
    // Generate Time Slots (1 hour duration)
    const slots = [];
    const [startHour, startMin] = availability.start_time.split(':').map(Number);
    const [endHour, endMin] = availability.end_time.split(':').map(Number);
    
    const slotDuration = 60; // 1 hour slots
    let currentMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;
    
    while (currentMinutes + slotDuration <= endMinutes) {
      const hour = Math.floor(currentMinutes / 60);
      const min = currentMinutes % 60;
      const timeString = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      
      slots.push({
        time: timeString,
        available: true
      });
      
      currentMinutes += slotDuration;
    }
    
    console.log('📋 Generated', slots.length, 'potential slots');
    
    // Check Existing Bookings
    const bookingsResult = await pool.query(
      `SELECT booking_time FROM bookings 
       WHERE team_id = $1 
       AND booking_date = $2
       AND status != 'cancelled'`,
      [team.id, date]
    );
    
    const bookedTimes = new Set(bookingsResult.rows.map(b => b.booking_time));
    console.log('📅 Already booked times:', Array.from(bookedTimes));
    
    // Mark booked slots as unavailable
    slots.forEach(slot => {
      if (bookedTimes.has(slot.time)) {
        slot.available = false;
      }
    });
    
    const availableCount = slots.filter(s => s.available).length;
    console.log('✅ Available slots:', availableCount, '/', slots.length);
    
    res.json({
      available: true,
      date: date,
      dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek],
      availableHours: {
        start: availability.start_time,
        end: availability.end_time
      },
      slots: slots,
      totalSlots: slots.length,
      availableSlots: availableCount
    });
    
  } catch (error) {
    console.error('Error fetching available slots:', error);
    res.status(500).json({ error: 'Failed to fetch available slots' });
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
app.get('/calendar-setup', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'calendar-setup-updated.html')));
app.get('/teams/:id', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'team-detail.html')));
app.get('/forgot-password', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'forgot-password.html')));
app.get('/availability-request/:token', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'availability-request.html')));
app.get('/reset-password', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));

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

/* ======================== CALENDAR API ENDPOINTS ======================== */

// Get user's Google Calendars
app.get('/api/calendars', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;

    if (!googleAuth) {
      return res.status(503).json({ error: 'Google Calendar integration is not configured' });
    }

    // Get user's tokens
    const userResult = await pool.query(
      'SELECT google_access_token, google_refresh_token FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    if (!user.google_access_token || !user.google_refresh_token) {
      return res.status(401).json({ error: 'Google Calendar not connected. Please connect your calendar first.' });
    }

    // Get calendar list from Google
    try {
      const calendars = await googleAuth.getCalendarList(
        user.google_access_token,
        user.google_refresh_token
      );

      res.json(calendars);
    } catch (calError) {
      console.error('Error fetching calendars from Google:', calError);
      
      // If token expired, try to refresh
      if (calError.message.includes('invalid_grant') || calError.message.includes('Token expired')) {
        return res.status(401).json({ 
          error: 'Calendar access expired. Please reconnect your Google Calendar.',
          needsReauth: true 
        });
      }
      
      throw calError;
    }
  } catch (error) {
    console.error('Error fetching calendars:', error);
    res.status(500).json({ error: 'Failed to fetch calendars' });
  }
});

// Save selected calendar
app.put('/api/user/calendar', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { calendar_id } = req.body;

    if (!calendar_id) {
      return res.status(400).json({ error: 'Calendar ID is required' });
    }

    // Update user's default calendar
    const result = await pool.query(
      'UPDATE users SET default_calendar_id = $1 WHERE id = $2 RETURNING *',
      [calendar_id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ 
      success: true, 
      message: 'Calendar saved successfully',
      user: {
        id: result.rows[0].id,
        default_calendar_id: result.rows[0].default_calendar_id
      }
    });
  } catch (error) {
    console.error('Error saving calendar:', error);
    res.status(500).json({ error: 'Failed to save calendar' });
  }
});

// Get Google OAuth authorization URL
app.get('/api/auth/google', (req, res) => {
  try {
    if (!googleAuth) {
      return res.status(503).json({ error: 'Google Calendar integration is not configured' });
    }

    const authUrl = googleAuth.getAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

// Handle Google OAuth callback
app.get('/api/calendar/google/callback', async (req, res) => {
  try {
    const { code, error: oauthError } = req.query;

    if (oauthError) {
      console.error('OAuth error:', oauthError);
      return res.redirect('/calendar-setup?error=' + encodeURIComponent(oauthError));
    }

    if (!code) {
      return res.redirect('/calendar-setup?error=no_authorization_code');
    }

    if (!googleAuth) {
      return res.redirect('/calendar-setup?error=service_unavailable');
    }

    console.log('📝 Received OAuth code, exchanging for tokens...');

    // Exchange code for tokens
    const tokens = await googleAuth.getTokensFromCode(code);
    console.log('✅ Got tokens from Google');

    // Get user info
    const userInfo = await googleAuth.getUserInfo(tokens.access_token);
    console.log('✅ Got user info:', userInfo.email);

    // Update user in database with Google tokens
    const result = await pool.query(
      `UPDATE users 
       SET google_id = $1,
           google_access_token = $2,
           google_refresh_token = $3,
           profile_picture = $4
       WHERE email = $5
       RETURNING id, email, name`,
      [
        userInfo.google_id,
        tokens.access_token,
        tokens.refresh_token,
        userInfo.picture,
        userInfo.email
      ]
    );

    if (result.rows.length === 0) {
      console.error('❌ User not found with email:', userInfo.email);
      return res.redirect('/calendar-setup?error=user_not_found');
    }

    console.log('✅ Updated user in database:', result.rows[0].email);

    // Redirect to calendar selection page
    res.redirect('/calendar-setup?connected=true');
  } catch (error) {
    console.error('❌ Error in OAuth callback:', error);
    res.redirect('/calendar-setup?error=' + encodeURIComponent(error.message));
  }
});

// Disconnect Google Calendar
app.post('/api/calendar/disconnect', authenticateToken, async (req, res) => {
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

    res.json({ success: true, message: 'Calendar disconnected successfully' });
  } catch (error) {
    console.error('Error disconnecting calendar:', error);
    res.status(500).json({ error: 'Failed to disconnect calendar' });
  }
});

/* ======================================================================== */

/* ==================== MICROSOFT CALENDAR ENDPOINTS ==================== */

const axios = require('axios');

// Microsoft OAuth configuration
const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MICROSOFT_GRAPH_URL = 'https://graph.microsoft.com/v1.0';

const MICROSOFT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'Calendars.ReadWrite',
  'Calendars.Read',
  'User.Read'
].join(' ');

// Get Microsoft OAuth authorization URL
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

// Handle Microsoft OAuth callback
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

    // Exchange code for tokens
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

    // Get user info
    const userResponse = await axios.get(`${MICROSOFT_GRAPH_URL}/me`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const userInfo = userResponse.data;
    const email = userInfo.mail || userInfo.userPrincipalName;
    const name = userInfo.displayName || email.split('@')[0];
    
    console.log('✅ Got user info:', email);

    // Try to find existing user
    let userResult = await pool.query('SELECT id, email, name FROM users WHERE email = $1', [email]);
    
    let userId;
    if (userResult.rows.length === 0) {
      // User doesn't exist - create new user
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
      // User exists - update with Microsoft credentials
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

    // Create JWT token and redirect to dashboard
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
    
    // Get full user data to pass to frontend
    const fullUserResult = await pool.query('SELECT id, name, email, profile_picture FROM users WHERE id = $1', [userId]);
    const user = fullUserResult.rows[0];
    
    const userData = encodeURIComponent(JSON.stringify({
      id: user.id,
      name: user.name,
      email: user.email,
      picture: user.profile_picture
    }));
    
    // Redirect to dashboard with token and user data
    res.redirect(`/dashboard?token=${token}&user=${userData}`);
  } catch (error) {
    console.error('❌ Error in Microsoft OAuth callback:', error.response?.data || error.message);
    res.redirect('/login?error=' + encodeURIComponent(error.message));
  }
});

// Get user's Microsoft Calendars
app.get('/api/calendars/microsoft', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;

    // Get user's tokens
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

    // Get calendar list from Microsoft
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
      
      // If token expired, try to refresh
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

// Disconnect Microsoft Calendar
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

/* ====================================================================== */

/* ====================================================================== */
/*                  2-WAY AVAILABILITY BOOKING SYSTEM                     */
/* ====================================================================== */

// ============================================================================
// 1. CREATE AVAILABILITY REQUEST (Owner generates link for guest)
// ============================================================================
app.post('/api/availability-requests', authenticateToken, async (req, res) => {
  try {
    const { team_id, guest_name, guest_email, guest_notes } = req.body;
    
    console.log('📬 Creating availability request for team:', team_id);
    
    // Verify team ownership
    const teamResult = await pool.query(
      'SELECT * FROM teams WHERE id = $1 AND owner_id = $2',
      [team_id, req.userId]
    );
    
    if (teamResult.rows.length === 0) {
      return res.status(403).json({ error: 'Team not found or access denied' });
    }
    
    const team = teamResult.rows[0];
    
    // Generate unique token
    const token = crypto.randomBytes(32).toString('hex');
    
    // Create request
    const result = await pool.query(
      `INSERT INTO availability_requests 
       (team_id, guest_name, guest_email, guest_notes, token) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [team_id, guest_name, guest_email, guest_notes || '', token]
    );
    
    const request = result.rows[0];
    const bookingUrl = `${req.protocol}://${req.get('host')}/availability-request/${token}`;
    
    console.log('✅ Availability request created:', request.id);
    console.log('🔗 Booking URL:', bookingUrl);
    
    // Send email to guest
    if (emailService && emailService.sendAvailabilityRequest) {
      await emailService.sendAvailabilityRequest(
        guest_email,
        guest_name,
        team.name,
        bookingUrl
      );
    }
    
    res.status(201).json({
      success: true,
      request: request,
      url: bookingUrl
    });
  } catch (error) {
    console.error('❌ Error creating availability request:', error);
    res.status(500).json({ error: 'Failed to create availability request' });
  }
});

// ============================================================================
// 2. GET AVAILABILITY REQUEST (Guest views - public, no auth)
// ============================================================================
app.get('/api/availability-requests/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    console.log('🔍 Looking up availability request:', token);
    
    // Get request with team info
    const result = await pool.query(
      `SELECT ar.*, t.name as team_name, t.description as team_description,
              u.name as owner_name
       FROM availability_requests ar
       JOIN teams t ON ar.team_id = t.id
       JOIN users u ON t.owner_id = u.id
       WHERE ar.token = $1 AND ar.status != 'expired'`,
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Availability request not found or expired' });
    }
    
    const request = result.rows[0];
    
    // Check if expired
    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      await pool.query(
        'UPDATE availability_requests SET status = $1 WHERE id = $2',
        ['expired', request.id]
      );
      return res.status(410).json({ error: 'This availability request has expired' });
    }
    
    // Get owner's availability
    const teamResult = await pool.query('SELECT owner_id FROM teams WHERE id = $1', [request.team_id]);
    const ownerId = teamResult.rows[0].owner_id;
    
    const availabilityResult = await pool.query(
      'SELECT * FROM time_slots WHERE user_id = $1 ORDER BY day_of_week, start_time',
      [ownerId]
    );
    
    console.log('✅ Found availability request:', request.id);
    
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
      owner_availability: availabilityResult.rows
    });
  } catch (error) {
    console.error('❌ Error fetching availability request:', error);
    res.status(500).json({ error: 'Failed to fetch availability request' });
  }
});

// ============================================================================
// 3. SUBMIT GUEST AVAILABILITY (Guest submits their availability)
// ============================================================================
app.post('/api/availability-requests/:token/submit', async (req, res) => {
  try {
    const { token } = req.params;
    const { slots } = req.body;
    
    console.log('📝 Guest submitting availability for token:', token);
    console.log('📅 Slots received:', slots.length);
    
    // Get request
    const requestResult = await pool.query(
      'SELECT * FROM availability_requests WHERE token = $1',
      [token]
    );
    
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Availability request not found' });
    }
    
    const request = requestResult.rows[0];
    
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Availability already submitted' });
    }
    
    // Delete any existing slots (in case of resubmission)
    await pool.query('DELETE FROM guest_availability_slots WHERE request_id = $1', [request.id]);
    
    // Insert new slots
    if (slots && slots.length > 0) {
      const insertPromises = slots.map(slot =>
        pool.query(
          `INSERT INTO guest_availability_slots (request_id, day_of_week, start_time, end_time)
           VALUES ($1, $2, $3, $4)`,
          [request.id, slot.day_of_week, slot.start_time, slot.end_time]
        )
      );
      await Promise.all(insertPromises);
    }
    
    // Update request status
    await pool.query(
      'UPDATE availability_requests SET status = $1 WHERE id = $2',
      ['submitted', request.id]
    );
    
    console.log('✅ Guest availability submitted successfully');
    
    // Calculate overlap
    const overlap = await calculateOverlap(request.team_id, request.id);
    
    // Send email to owner
    if (emailService && emailService.sendAvailabilitySubmitted) {
      try {
        const teamResult = await pool.query(
          'SELECT t.*, u.email as owner_email, u.name as owner_name FROM teams t JOIN users u ON t.owner_id = u.id WHERE t.id = $1',
          [request.team_id]
        );
        
        if (teamResult.rows.length > 0) {
          const team = teamResult.rows[0];
          await emailService.sendAvailabilitySubmitted(
            team.owner_email,
            team.owner_name,
            request.guest_name,
            overlap.length
          );
        }
      } catch (err) {
        console.error('Email notification error:', err);
      }
    }
    
    res.json({
      success: true,
      message: 'Availability submitted successfully',
      overlap: overlap,
      overlap_count: overlap.length
    });
  } catch (error) {
    console.error('❌ Error submitting guest availability:', error);
    res.status(500).json({ error: 'Failed to submit availability' });
  }
});

// ============================================================================
// 4. GET OVERLAP (View times when both are available)
// ============================================================================
app.get('/api/availability-requests/:token/overlap', async (req, res) => {
  try {
    const { token } = req.params;
    
    console.log('🔍 Calculating overlap for token:', token);
    
    // Get request
    const requestResult = await pool.query(
      'SELECT * FROM availability_requests WHERE token = $1',
      [token]
    );
    
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Availability request not found' });
    }
    
    const request = requestResult.rows[0];
    
    if (request.status === 'pending') {
      return res.status(400).json({ error: 'Guest has not submitted availability yet' });
    }
    
    const overlap = await calculateOverlap(request.team_id, request.id);
    
    console.log('✅ Found', overlap.length, 'overlap slots');
    
    res.json({
      overlap: overlap,
      count: overlap.length
    });
  } catch (error) {
    console.error('❌ Error calculating overlap:', error);
    res.status(500).json({ error: 'Failed to calculate overlap' });
  }
});

// ============================================================================
// 5. FINALIZE BOOKING (Owner or guest books final time from overlap)
// ============================================================================
app.post('/api/availability-requests/:token/book', async (req, res) => {
  try {
    const { token } = req.params;
    const { date, time } = req.body;
    
    console.log('📅 Finalizing booking for token:', token);
    console.log('📅 Date:', date, 'Time:', time);
    
    // Get request
    const requestResult = await pool.query(
      'SELECT ar.*, t.owner_id FROM availability_requests ar JOIN teams t ON ar.team_id = t.id WHERE ar.token = $1',
      [token]
    );
    
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Availability request not found' });
    }
    
    const request = requestResult.rows[0];
    
    if (request.status !== 'submitted') {
      return res.status(400).json({ error: 'Cannot book: availability not submitted or already booked' });
    }
    
    // Verify the time is in the overlap
    const overlap = await calculateOverlap(request.team_id, request.id);
    const selectedSlot = overlap.find(slot => 
      slot.date === date && slot.time === time
    );
    
    if (!selectedSlot) {
      return res.status(400).json({ error: 'Selected time is not in the available overlap' });
    }
    
    // Create the booking (reuse existing booking logic)
    const ts = parseDateAndTimeToTimestamp(date, time);
    if (!ts) {
      return res.status(400).json({ error: 'Invalid date/time format' });
    }
    
    const bookingResult = await pool.query(
      `INSERT INTO bookings 
       (team_id, guest_name, guest_email, guest_notes, status, booking_date, booking_time, slot_start, slot_end)
       VALUES ($1, $2, $3, $4, 'confirmed', $5, $6, $7, $8)
       RETURNING *`,
      [
        request.team_id,
        request.guest_name,
        request.guest_email,
        request.guest_notes || '',
        date,
        time,
        ts.start,
        ts.end
      ]
    );
    
    const booking = bookingResult.rows[0];
    
    // Update availability request
    await pool.query(
      `UPDATE availability_requests 
       SET status = 'booked', booked_date = $1, booked_time = $2, booking_id = $3 
       WHERE id = $4`,
      [date, time, booking.id, request.id]
    );
    
    console.log('✅ Booking created:', booking.id);
    
    // Send confirmation emails
    if (emailService) {
      const teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [request.team_id]);
      if (teamResult.rows.length > 0) {
        const team = teamResult.rows[0];
        
        // Email to guest
        emailService.sendBookingConfirmation(booking, team)
          .catch(err => console.error('Email error:', err));
        
        // Email to owner
        const ownerResult = await pool.query('SELECT email FROM users WHERE id = $1', [request.owner_id]);
        if (ownerResult.rows.length > 0) {
          emailService.sendBookingNotificationToOwner(booking, team, ownerResult.rows[0].email)
            .catch(err => console.error('Email error:', err));
        }
      }
    }
    
    res.status(201).json({
      success: true,
      booking: booking,
      message: 'Booking confirmed successfully'
    });
  } catch (error) {
    console.error('❌ Error finalizing booking:', error);
    res.status(500).json({ error: 'Failed to finalize booking' });
  }
});

// ============================================================================
// 6. OWNER DASHBOARD: Get all availability requests
// ============================================================================
app.get('/api/availability-requests', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    
    const result = await pool.query(
      `SELECT ar.*, t.name as team_name
       FROM availability_requests ar
       JOIN teams t ON ar.team_id = t.id
       WHERE t.owner_id = $1
       ORDER BY ar.created_at DESC`,
      [userId]
    );
    
    res.json({ requests: result.rows });
  } catch (error) {
    console.error('Error fetching availability requests:', error);
    res.status(500).json({ error: 'Failed to fetch availability requests' });
  }
});

// ============================================================================
// HELPER FUNCTION: Calculate Overlap
// ============================================================================
async function calculateOverlap(teamId, requestId) {
  try {
    // Get owner's availability
    const teamResult = await pool.query('SELECT owner_id FROM teams WHERE id = $1', [teamId]);
    const ownerId = teamResult.rows[0].owner_id;
    
    const ownerAvailability = await pool.query(
      'SELECT * FROM time_slots WHERE user_id = $1',
      [ownerId]
    );
    
    // Get guest's availability
    const guestAvailability = await pool.query(
      'SELECT * FROM guest_availability_slots WHERE request_id = $1',
      [requestId]
    );
    
    const overlap = [];
    
    // For each day, find overlapping time ranges
    for (let day = 1; day <= 7; day++) {
      const ownerSlots = ownerAvailability.rows.filter(s => s.day_of_week === day);
      const guestSlots = guestAvailability.rows.filter(s => s.day_of_week === day);
      
      if (ownerSlots.length === 0 || guestSlots.length === 0) continue;
      
      // For simplicity, take the first slot of each (can be enhanced for multiple slots per day)
      const ownerSlot = ownerSlots[0];
      const guestSlot = guestSlots[0];
      
      // Convert times to minutes for comparison
      const ownerStart = timeToMinutes(ownerSlot.start_time);
      const ownerEnd = timeToMinutes(ownerSlot.end_time);
      const guestStart = timeToMinutes(guestSlot.start_time);
      const guestEnd = timeToMinutes(guestSlot.end_time);
      
      // Find overlap
      const overlapStart = Math.max(ownerStart, guestStart);
      const overlapEnd = Math.min(ownerEnd, guestEnd);
      
      if (overlapStart < overlapEnd) {
        // Generate 1-hour slots in the overlap
        const dayName = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][day];
        
        for (let minutes = overlapStart; minutes + 60 <= overlapEnd; minutes += 60) {
          const hour = Math.floor(minutes / 60);
          const min = minutes % 60;
          const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
          
          // Get next occurrence of this day
          const nextDate = getNextDateForDay(day);
          
          overlap.push({
            day_of_week: day,
            day_name: dayName,
            date: nextDate,
            time: timeStr,
            time_display: formatTime12Hour(timeStr)
          });
        }
      }
    }
    
    return overlap;
  } catch (error) {
    console.error('Error calculating overlap:', error);
    return [];
  }
}

// Helper: Convert time string to minutes
function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

// Helper: Get next occurrence of a day of week
function getNextDateForDay(dayOfWeek) {
  const today = new Date();
  const currentDay = today.getDay(); // 0-6
  const targetDay = dayOfWeek === 7 ? 0 : dayOfWeek; // Convert 7 (Sunday) to 0
  
  let daysUntilTarget = targetDay - currentDay;
  if (daysUntilTarget <= 0) {
    daysUntilTarget += 7; // Next week
  }
  
  const targetDate = new Date(today);
  targetDate.setDate(today.getDate() + daysUntilTarget);
  
  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, '0');
  const day = String(targetDate.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

// Helper: Format time to 12-hour
function formatTime12Hour(time24) {
  const [hour, minute] = time24.split(':');
  const hourNum = parseInt(hour);
  const hour12 = hourNum % 12 || 12;
  const period = hourNum >= 12 ? 'PM' : 'AM';
  return `${hour12}:${minute} ${period}`;
}


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