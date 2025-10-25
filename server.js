// ============================================================================
// ScheduleSync API Server - Complete Clean Version
// Google OAuth Fixed + Microsoft OAuth Support
// ============================================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser'); // 🔥 CRITICAL for OAuth!
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');

// ============================================================================
// SERVICES (Optional imports - gracefully handle if missing)
// ============================================================================

let googleAuth = null;
try {
  googleAuth = require('./google-auth-service');
  console.log('✅ Google Auth service loaded');
} catch (error) {
  console.log('⚠️  Google Auth service not found - OAuth will be disabled');
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
  console.log('ℹ️  Email service not found - emails will be disabled');
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'schedulesync-secret-change-in-production';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Database connection
const pool = new Pool({
  connectionString: process.env.DB_CONNECTION_STRING || process.env.DATABASE_URL,
  ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Google OAuth config
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || process.env.GOOGLE_CALLBACK_URL;

// Microsoft OAuth config
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MICROSOFT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI;

// ============================================================================
// EXPRESS APP SETUP
// ============================================================================

const app = express();

// Middleware - ORDER MATTERS!
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); // 🔥 CRITICAL - Must be before routes!

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// DATABASE INITIALIZATION
// ============================================================================

async function initDatabase() {
  try {
    // Users table with all OAuth columns
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

    // Bookings table
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

    // Calendar integrations table
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
    throw error;
  }
}

// Initialize database on startup
initDatabase();

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================

function authenticateToken(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

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
  if (!googleAuth) {
    return res.status(501).json({ error: 'Google OAuth not configured' });
  }

  try {
    const authUrl = googleAuth.getAuthUrl();
    console.log('🔗 Redirecting to Google OAuth');
    res.redirect(authUrl);
  } catch (error) {
    console.error('❌ Error generating Google auth URL:', error);
    res.redirect('/login?error=oauth_config_error');
  }
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 Google OAuth Callback');
  console.log('Code:', code ? code.substring(0, 30) + '...' : 'NONE');
  console.log('Error:', error || 'NONE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (error || !code) {
    console.error('❌ OAuth error or no code');
    return res.redirect('/login?error=oauth_failed');
  }

  try {
    // Step 1: Exchange code for tokens
    console.log('📝 Step 1: Getting tokens...');
    const tokens = await googleAuth.getTokensFromCode(code);
    console.log('✅ Tokens received');

    // Step 2: Get user info
    console.log('📝 Step 2: Getting user info...');
    const userInfo = await googleAuth.getUserInfo(tokens.access_token);
    console.log('✅ User info:', userInfo.email);

    // Step 3: Find or create user
    console.log('📝 Step 3: Finding/creating user...');
    let userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [userInfo.email]
    );

    let user;

    if (userResult.rows.length > 0) {
      // Update existing user
      const updateResult = await pool.query(
        `UPDATE users 
         SET google_id = $1,
             google_access_token = $2,
             google_refresh_token = COALESCE($3, google_refresh_token),
             name = $4,
             profile_picture = $5
         WHERE email = $6
         RETURNING id, name, email, profile_picture`,
        [
          userInfo.google_id,
          tokens.access_token,
          tokens.refresh_token,
          userInfo.name,
          userInfo.picture,
          userInfo.email,
        ]
      );
      user = updateResult.rows[0];
      console.log('✅ User updated:', user.id);
    } else {
      // Create new user
      const insertResult = await pool.query(
        `INSERT INTO users (name, email, google_id, google_access_token, google_refresh_token, profile_picture)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, email, profile_picture`,
        [
          userInfo.name,
          userInfo.email,
          userInfo.google_id,
          tokens.access_token,
          tokens.refresh_token,
          userInfo.picture,
        ]
      );
      user = insertResult.rows[0];
      console.log('✅ New user created:', user.id);
    }

    // Step 4: Generate JWT
    console.log('📝 Step 4: Generating JWT...');
    const jwtToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        name: user.name,
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Step 5: Set cookie and redirect
    console.log('📝 Step 5: Setting cookie...');
    res.cookie('token', jwtToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    console.log('✅ ✅ ✅ Google OAuth SUCCESS:', user.email);
    console.log('🎯 Redirecting to /dashboard.html');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return res.redirect('/dashboard.html');
  } catch (error) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ ❌ ❌ Google OAuth FAILED');
    console.error('Error:', error.message);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    return res.redirect('/login?error=oauth_failed');
  }
});

// ============================================================================
// MICROSOFT OAUTH ROUTES
// ============================================================================

app.get('/auth/microsoft', (req, res) => {
  if (!microsoftAuth) {
    return res.status(501).json({ error: 'Microsoft OAuth not configured' });
  }

  try {
    const authUrl = microsoftAuth.getAuthUrl();
    console.log('🔗 Redirecting to Microsoft OAuth');
    res.redirect(authUrl);
  } catch (error) {
    console.error('❌ Error generating Microsoft auth URL:', error);
    res.redirect('/login?error=oauth_config_error');
  }
});

app.get('/auth/microsoft/callback', async (req, res) => {
  const { code, error } = req.query;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 Microsoft OAuth Callback');
  console.log('Code:', code ? 'Received' : 'NONE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (error || !code) {
    console.error('❌ OAuth error or no code');
    return res.redirect('/login?error=oauth_failed');
  }

  try {
    const tokens = await microsoftAuth.getTokensFromCode(code);
    const userInfo = await microsoftAuth.getUserInfo(tokens.access_token);

    let userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [userInfo.email]
    );

    let user;

    if (userResult.rows.length > 0) {
      const updateResult = await pool.query(
        `UPDATE users 
         SET microsoft_id = $1,
             microsoft_access_token = $2,
             microsoft_refresh_token = COALESCE($3, microsoft_refresh_token),
             name = $4
         WHERE email = $5
         RETURNING id, name, email`,
        [
          userInfo.microsoft_id,
          tokens.access_token,
          tokens.refresh_token,
          userInfo.name,
          userInfo.email,
        ]
      );
      user = updateResult.rows[0];
      console.log('✅ User updated:', user.id);
    } else {
      const insertResult = await pool.query(
        `INSERT INTO users (name, email, microsoft_id, microsoft_access_token, microsoft_refresh_token)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, email`,
        [
          userInfo.name,
          userInfo.email,
          userInfo.microsoft_id,
          tokens.access_token,
          tokens.refresh_token,
        ]
      );
      user = insertResult.rows[0];
      console.log('✅ New user created:', user.id);
    }

    const jwtToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        name: user.name,
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('token', jwtToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    console.log('✅ ✅ ✅ Microsoft OAuth SUCCESS:', user.email);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    return res.redirect('/dashboard.html');
  } catch (error) {
    console.error('❌ Microsoft OAuth failed:', error);
    return res.redirect('/login?error=oauth_failed');
  }
});

// ============================================================================
// EMAIL/PASSWORD AUTHENTICATION
// ============================================================================

// Sign up
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    // Check if user exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const result = await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hashedPassword]
    );

    const user = result.rows[0];

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('✅ New user signed up:', email);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error('❌ Signup error:', error);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      console.log('❌ Login failed: Email not found:', email);
      return res.status(401).json({
        error: 'email_not_found',
        message: 'No account found with this email',
      });
    }

    const user = result.rows[0];

    if (!user.password) {
      console.log('❌ Login failed: No password (OAuth account):', email);
      return res.status(401).json({
        error: 'no_password',
        message: 'This account was created with Google/Microsoft. Please sign in with that provider.',
      });
    }

    // Check password
    const isHashed = user.password.startsWith('$2b$') || user.password.startsWith('$2a$');
    let passwordValid = false;

    if (isHashed) {
      passwordValid = await bcrypt.compare(password, user.password);
      console.log(`🔐 Login attempt for ${email}: ${passwordValid ? 'Valid ✅' : 'Invalid ❌'} (hashed)`);
    } else {
      // Legacy plain text password
      passwordValid = password === user.password;
      console.log(`🔐 Login attempt for ${email}: ${passwordValid ? 'Valid ✅' : 'Invalid ❌'} (plain text)`);

      if (passwordValid) {
        // Upgrade to hashed password
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, user.id]);
        console.log(`✅ Upgraded password to hashed for: ${email}`);
      }
    }

    if (!passwordValid) {
      console.log('❌ Login failed: Incorrect password for:', email);
      return res.status(401).json({
        error: 'wrong_password',
        message: 'Incorrect password',
      });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('✅ ✅ Login successful:', email);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        profile_picture: user.profile_picture,
      },
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'server_error', message: 'Server error during login' });
  }
});

// ============================================================================
// PASSWORD RESET
// ============================================================================

// Request password reset
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const result = await pool.query('SELECT id, name FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'email_not_found', message: 'No account with this email' });
    }

    const user = result.rows[0];

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour

    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
      [resetToken, resetTokenExpiry, user.id]
    );

    // Send email if service available
    if (emailService) {
      try {
        await emailService.sendPasswordResetEmail(email, user.name, resetToken);
        console.log('✅ Password reset email sent to:', email);
      } catch (emailError) {
        console.error('❌ Failed to send reset email:', emailError);
      }
    }

    res.json({
      success: true,
      message: 'Password reset email sent',
      resetToken: NODE_ENV === 'development' ? resetToken : undefined,
    });
  } catch (error) {
    console.error('❌ Forgot password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify reset token
app.post('/api/auth/verify-reset-token', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, name, reset_token_expiry FROM users WHERE reset_token = $1',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'invalid_token', message: 'Invalid reset token' });
    }

    const user = result.rows[0];

    if (new Date() > new Date(user.reset_token_expiry)) {
      return res.status(410).json({ error: 'expired_token', message: 'Reset token has expired' });
    }

    res.json({
      valid: true,
      email: user.email,
      name: user.name,
    });
  } catch (error) {
    console.error('❌ Verify token error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset password
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, reset_token_expiry FROM users WHERE reset_token = $1',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'invalid_token', message: 'Invalid reset token' });
    }

    const user = result.rows[0];

    if (new Date() > new Date(user.reset_token_expiry)) {
      return res.status(410).json({ error: 'expired_token', message: 'Reset token has expired' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and clear reset token
    await pool.query(
      'UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2',
      [hashedPassword, user.id]
    );

    console.log('✅ Password reset successfully for:', user.email);

    // Send confirmation email if service available
    if (emailService) {
      try {
        await emailService.sendPasswordChangedEmail(user.email);
        console.log('✅ Password changed confirmation sent to:', user.email);
      } catch (emailError) {
        console.error('❌ Failed to send confirmation email:', emailError);
      }
    }

    res.json({
      success: true,
      message: 'Password reset successfully',
    });
  } catch (error) {
    console.error('❌ Reset password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// AUTH VERIFICATION & USER INFO
// ============================================================================

// Verify JWT token
app.get('/api/auth/verify', (req, res) => {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({
      authenticated: false,
      error: 'No token provided',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    res.json({
      authenticated: true,
      user: {
        id: decoded.userId,
        email: decoded.email,
        name: decoded.name,
      },
    });
  } catch (error) {
    console.error('❌ Token verification failed:', error.message);
    res.status(401).json({
      authenticated: false,
      error: 'Invalid or expired token',
    });
  }
});

// Get current user profile
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, profile_picture, timezone, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('❌ Error getting user profile:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully' });
});

// ============================================================================
// CALENDAR ENDPOINTS
// ============================================================================

// Get connected calendars
app.get('/api/calendars', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM calendar_integrations WHERE user_id = $1 AND is_active = true',
      [req.user.userId]
    );

    res.json({ calendars: result.rows });
  } catch (error) {
    console.error('❌ Error fetching calendars:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Sync Google Calendar
app.post('/api/calendars/google/sync', authenticateToken, async (req, res) => {
  if (!googleAuth) {
    return res.status(501).json({ error: 'Google integration not available' });
  }

  try {
    const userResult = await pool.query(
      'SELECT google_access_token, google_refresh_token FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].google_access_token) {
      return res.status(401).json({ error: 'Google account not connected' });
    }

    const user = userResult.rows[0];
    const calendars = await googleAuth.getCalendarList(
      user.google_access_token,
      user.google_refresh_token
    );

    // Save calendars to database
    for (const cal of calendars) {
      await pool.query(
        `INSERT INTO calendar_integrations (user_id, provider, calendar_id, calendar_name, is_primary)
         VALUES ($1, 'google', $2, $3, $4)
         ON CONFLICT (user_id, provider, calendar_id) DO UPDATE
         SET calendar_name = $3, is_primary = $4`,
        [req.user.userId, cal.id, cal.name, cal.primary]
      );
    }

    res.json({ success: true, calendars });
  } catch (error) {
    console.error('❌ Error syncing Google calendars:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Sync Microsoft Calendar
app.post('/api/calendars/microsoft/sync', authenticateToken, async (req, res) => {
  if (!microsoftAuth) {
    return res.status(501).json({ error: 'Microsoft integration not available' });
  }

  try {
    const userResult = await pool.query(
      'SELECT microsoft_access_token FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].microsoft_access_token) {
      return res.status(401).json({ error: 'Microsoft account not connected' });
    }

    const user = userResult.rows[0];
    const calendars = await microsoftAuth.getCalendarList(user.microsoft_access_token);

    // Save calendars to database
    for (const cal of calendars) {
      await pool.query(
        `INSERT INTO calendar_integrations (user_id, provider, calendar_id, calendar_name, is_primary)
         VALUES ($1, 'microsoft', $2, $3, $4)
         ON CONFLICT (user_id, provider, calendar_id) DO UPDATE
         SET calendar_name = $3, is_primary = $4`,
        [req.user.userId, cal.id, cal.name, cal.primary]
      );
    }

    res.json({ success: true, calendars });
  } catch (error) {
    console.error('❌ Error syncing Microsoft calendars:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// BOOKING ENDPOINTS
// ============================================================================

// Get user's bookings
app.get('/api/bookings', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM bookings WHERE user_id = $1 ORDER BY start_time DESC',
      [req.user.userId]
    );

    res.json({ bookings: result.rows });
  } catch (error) {
    console.error('❌ Error fetching bookings:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create booking
app.post('/api/bookings', authenticateToken, async (req, res) => {
  const { title, description, start_time, end_time, attendee_email, attendee_name } = req.body;

  if (!title || !start_time || !end_time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO bookings (user_id, title, description, start_time, end_time, attendee_email, attendee_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.userId, title, description, start_time, end_time, attendee_email, attendee_name]
    );

    console.log('✅ Booking created:', result.rows[0].id);
    res.json({ success: true, booking: result.rows[0] });
  } catch (error) {
    console.error('❌ Error creating booking:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PROTECTED ROUTES MIDDLEWARE
// ============================================================================

// Protect dashboard
app.get('/dashboard.html', (req, res, next) => {
  const token = req.cookies.token;

  if (!token) {
    console.log('⛔ Unauthorized access to dashboard');
    return res.redirect('/login?error=not_authenticated');
  }

  try {
    jwt.verify(token, JWT_SECRET);
    console.log('✅ Dashboard access granted');
    next();
  } catch (error) {
    console.log('⛔ Invalid token');
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
      database: 'connected',
      googleAuth: !!googleAuth,
      microsoftAuth: !!microsoftAuth,
      emailService: !!emailService,
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message,
    });
  }
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 ScheduleSync API Server`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`✅ Database: Connected`);
  console.log(`✅ Cookie Parser: Enabled`);
  console.log(`${googleAuth ? '✅' : '❌'} Google OAuth: ${googleAuth ? 'Enabled' : 'Disabled'}`);
  console.log(`${microsoftAuth ? '✅' : '❌'} Microsoft OAuth: ${microsoftAuth ? 'Enabled' : 'Disabled'}`);
  console.log(`${emailService ? '✅' : '❌'} Email Service: ${emailService ? 'Enabled' : 'Disabled'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  pool.end();
  process.exit(0);
});