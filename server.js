console.log('================================');
console.log('🔍 SERVER.JS STARTING');
console.log('🔍 Current time:', new Date().toISOString());
console.log('================================');

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

console.log('🔍 All requires loaded successfully');

// Load services
let googleAuth, microsoftAuth, emailService;
try { 
  googleAuth = require('./google-auth-service'); 
  console.log('✅ Google Auth loaded'); 
} catch (e) { 
  console.log('ℹ️  Google Auth not found:', e.message); 
}
try { 
  microsoftAuth = require('./microsoft-auth-service'); 
  console.log('✅ Microsoft Auth loaded'); 
} catch (e) { 
  console.log('ℹ️  Microsoft Auth not found:', e.message); 
}
try { 
  emailService = require('./email-service'); 
  console.log('✅ Email service loaded'); 
} catch (e) { 
  console.log('ℹ️  Email service not found:', e.message); 
}

// Config
const PORT = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'schedulesync-secret-2025';
const NODE_ENV = process.env.NODE_ENV || 'development';

console.log('🔍 Config loaded - PORT:', PORT);

// Database
console.log('🔍 Creating database pool...');
const pool = new Pool({
  connectionString: process.env.DB_CONNECTION_STRING || process.env.DATABASE_URL,
  ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
console.log('🔍 Database pool created');

// Express app
console.log('🔍 Creating Express app...');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));
console.log('🔍 Express app configured');

// Init database
async function initDB() {
  console.log('🔍 initDB() called');
  try {
    console.log('🔍 Testing database connection...');
    await pool.query('SELECT 1');
    console.log('✅ Database connection test passed');
    
    // Users table
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
        default_calendar_id VARCHAR(255),
        reset_token VARCHAR(255),
        reset_token_expiry TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Users table ready');
    
    // Teams table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        slug VARCHAR(255) UNIQUE NOT NULL,
        owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        duration INTEGER DEFAULT 30,
        buffer_time INTEGER DEFAULT 0,
        max_bookings_per_day INTEGER DEFAULT 10,
        booking_notice INTEGER DEFAULT 60,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Teams table ready');
    
    // Team members table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(team_id, user_id)
      )
    `);
    console.log('✅ Team members table ready');
    
    // Availability table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS availability (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Availability table ready');
    
    // Bookings table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        guest_name VARCHAR(255) NOT NULL,
        guest_email VARCHAR(255) NOT NULL,
        guest_notes TEXT,
        booking_date DATE NOT NULL,
        booking_time TIME NOT NULL,
        duration INTEGER DEFAULT 30,
        meet_link TEXT,
        calendar_event_id TEXT,
        status VARCHAR(50) DEFAULT 'confirmed',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Bookings table ready');
    
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
    console.log('✅ Calendar integrations table ready');
    
    console.log('✅ Database ready');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  }
}

// Auth middleware
function auth(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Auth required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    req.userId = req.user.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/* ==================== AUTHENTICATION ROUTES ==================== */

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
    const userData = { id: user.id, name: user.name, email: user.email, picture: user.profile_picture };
    console.log('✅ Google OAuth:', user.email);
    res.redirect(`/dashboard.html?token=${token}&user=${encodeURIComponent(JSON.stringify(userData))}`);
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
    const userData = { id: user.id, name: user.name, email: user.email };
    console.log('✅ Microsoft OAuth:', user.email);
    res.redirect(`/dashboard.html?token=${token}&user=${encodeURIComponent(JSON.stringify(userData))}`);
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
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id, email, name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
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

// Password reset
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'If email exists, reset link sent' });
    }
    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 3600000); // 1 hour
    await pool.query('UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3', [resetToken, expiry, user.id]);
    
    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password.html?token=${resetToken}`;
    if (emailService) {
      await emailService.sendPasswordReset(email, user.name, resetLink);
    }
    res.json({ success: true, message: 'Reset link sent' });
  } catch (e) {
    console.error('Password reset error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()',
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }
    const user = result.rows[0];
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE id = $2',
      [hash, user.id]
    );
    if (emailService) {
      await emailService.sendPasswordChanged(user.email, user.name);
    }
    res.json({ success: true, message: 'Password reset successful' });
  } catch (e) {
    console.error('Reset password error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ==================== TEAMS ROUTES ==================== */

// Get all teams for user
app.get('/api/teams', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, u.name as owner_name, u.email as owner_email,
        (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
      FROM teams t
      LEFT JOIN users u ON t.owner_id = u.id
      WHERE t.owner_id = $1 OR t.id IN (SELECT team_id FROM team_members WHERE user_id = $1)
      ORDER BY t.created_at DESC
    `, [req.userId]);
    res.json({ teams: result.rows });
  } catch (e) {
    console.error('Get teams error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create team
app.post('/api/teams', auth, async (req, res) => {
  const { name, description, duration, buffer_time, max_bookings_per_day } = req.body;
  if (!name) return res.status(400).json({ error: 'Team name required' });
  try {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
    const result = await pool.query(
      `INSERT INTO teams (name, description, slug, owner_id, duration, buffer_time, max_bookings_per_day) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, description, slug, req.userId, duration || 30, buffer_time || 0, max_bookings_per_day || 10]
    );
    res.json({ success: true, team: result.rows[0] });
  } catch (e) {
    console.error('Create team error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get team by ID
app.get('/api/teams/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, u.name as owner_name, u.email as owner_email
      FROM teams t
      LEFT JOIN users u ON t.owner_id = u.id
      WHERE t.id = $1 AND (t.owner_id = $2 OR t.id IN (SELECT team_id FROM team_members WHERE user_id = $2))
    `, [req.params.id, req.userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    const members = await pool.query(`
      SELECT tm.*, u.name, u.email, u.profile_picture
      FROM team_members tm
      JOIN users u ON tm.user_id = u.id
      WHERE tm.team_id = $1
    `, [req.params.id]);
    
    res.json({ team: result.rows[0], members: members.rows });
  } catch (e) {
    console.error('Get team error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update team
app.put('/api/teams/:id', auth, async (req, res) => {
  const { name, description, duration, buffer_time, max_bookings_per_day, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE teams SET name = COALESCE($1, name), description = COALESCE($2, description),
       duration = COALESCE($3, duration), buffer_time = COALESCE($4, buffer_time),
       max_bookings_per_day = COALESCE($5, max_bookings_per_day), is_active = COALESCE($6, is_active)
       WHERE id = $7 AND owner_id = $8 RETURNING *`,
      [name, description, duration, buffer_time, max_bookings_per_day, is_active, req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found or unauthorized' });
    }
    res.json({ success: true, team: result.rows[0] });
  } catch (e) {
    console.error('Update team error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete team
app.delete('/api/teams/:id', auth, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM teams WHERE id = $1 AND owner_id = $2 RETURNING *', [req.params.id, req.userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found or unauthorized' });
    }
    res.json({ success: true, message: 'Team deleted' });
  } catch (e) {
    console.error('Delete team error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add team member
app.post('/api/teams/:id/members', auth, async (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const teamCheck = await pool.query('SELECT * FROM teams WHERE id = $1 AND owner_id = $2', [req.params.id, req.userId]);
    if (teamCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const result = await pool.query(
      'INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) RETURNING *',
      [req.params.id, userResult.rows[0].id, role || 'member']
    );
    res.json({ success: true, member: result.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'User already in team' });
    }
    console.error('Add member error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ==================== AVAILABILITY ROUTES ==================== */

// Get availability
app.get('/api/availability', auth, async (req, res) => {
  const { team_id } = req.query;
  try {
    let query = 'SELECT * FROM availability WHERE user_id = $1';
    let params = [req.userId];
    
    if (team_id) {
      query += ' AND team_id = $2';
      params.push(team_id);
    }
    
    const result = await pool.query(query + ' ORDER BY day_of_week, start_time', params);
    res.json({ availability: result.rows });
  } catch (e) {
    console.error('Get availability error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Set availability
app.post('/api/availability', auth, async (req, res) => {
  const { team_id, schedule } = req.body;
  if (!schedule || !Array.isArray(schedule)) {
    return res.status(400).json({ error: 'Schedule array required' });
  }
  try {
    if (team_id) {
      await pool.query('DELETE FROM availability WHERE user_id = $1 AND team_id = $2', [req.userId, team_id]);
    } else {
      await pool.query('DELETE FROM availability WHERE user_id = $1 AND team_id IS NULL', [req.userId]);
    }
    
    for (const slot of schedule) {
      await pool.query(
        'INSERT INTO availability (user_id, team_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, $4, $5)',
        [req.userId, team_id || null, slot.day_of_week, slot.start_time, slot.end_time]
      );
    }
    
    res.json({ success: true, message: 'Availability updated' });
  } catch (e) {
    console.error('Set availability error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ==================== BOOKINGS ROUTES ==================== */

// Get bookings
app.get('/api/bookings', auth, async (req, res) => {
  const { team_id, status } = req.query;
  try {
    let query = `
      SELECT b.*, t.name as team_name, t.slug as team_slug
      FROM bookings b
      JOIN teams t ON b.team_id = t.id
      WHERE (t.owner_id = $1 OR b.user_id = $1 OR t.id IN (SELECT team_id FROM team_members WHERE user_id = $1))
    `;
    let params = [req.userId];
    
    if (team_id) {
      query += ' AND b.team_id = $2';
      params.push(team_id);
    }
    if (status) {
      query += ` AND b.status = $${params.length + 1}`;
      params.push(status);
    }
    
    const result = await pool.query(query + ' ORDER BY b.booking_date DESC, b.booking_time DESC', params);
    res.json({ bookings: result.rows });
  } catch (e) {
    console.error('Get bookings error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create booking (public endpoint for booking page)
app.post('/api/bookings', async (req, res) => {
  const { team_slug, guest_name, guest_email, guest_notes, booking_date, booking_time } = req.body;
  
  if (!team_slug || !guest_name || !guest_email || !booking_date || !booking_time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    const teamResult = await pool.query('SELECT * FROM teams WHERE slug = $1 AND is_active = true', [team_slug]);
    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    const team = teamResult.rows[0];
    
    const result = await pool.query(
      `INSERT INTO bookings (team_id, guest_name, guest_email, guest_notes, booking_date, booking_time, duration)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [team.id, guest_name, guest_email, guest_notes, booking_date, booking_time, team.duration]
    );
    
    if (emailService) {
      await emailService.sendBookingConfirmation(result.rows[0], team);
    }
    
    res.json({ success: true, booking: result.rows[0] });
  } catch (e) {
    console.error('Create booking error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update booking status
app.patch('/api/bookings/:id', auth, async (req, res) => {
  const { status } = req.body;
  try {
    const result = await pool.query(
      `UPDATE bookings SET status = $1 WHERE id = $2 AND team_id IN (
        SELECT id FROM teams WHERE owner_id = $3 OR id IN (SELECT team_id FROM team_members WHERE user_id = $3)
      ) RETURNING *`,
      [status, req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found or unauthorized' });
    }
    res.json({ success: true, booking: result.rows[0] });
  } catch (e) {
    console.error('Update booking error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ==================== ANALYTICS ROUTES ==================== */

app.get('/api/analytics/dashboard', auth, async (req, res) => {
  try {
    const totalBookings = await pool.query(
      `SELECT COUNT(*) as count FROM bookings WHERE team_id IN (
        SELECT id FROM teams WHERE owner_id = $1 OR id IN (SELECT team_id FROM team_members WHERE user_id = $1)
      )`,
      [req.userId]
    );
    
    const upcomingMeetings = await pool.query(
      `SELECT COUNT(*) as count FROM bookings WHERE team_id IN (
        SELECT id FROM teams WHERE owner_id = $1 OR id IN (SELECT team_id FROM team_members WHERE user_id = $1)
      ) AND booking_date >= CURRENT_DATE AND status = 'confirmed'`,
      [req.userId]
    );
    
    const teamMembers = await pool.query(
      `SELECT COUNT(DISTINCT user_id) as count FROM team_members WHERE team_id IN (
        SELECT id FROM teams WHERE owner_id = $1
      )`,
      [req.userId]
    );
    
    res.json({
      totalBookings: parseInt(totalBookings.rows[0].count),
      upcomingMeetings: parseInt(upcomingMeetings.rows[0].count),
      teamMembers: parseInt(teamMembers.rows[0].count)
    });
  } catch (e) {
    console.error('Analytics error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ==================== CALENDAR ROUTES ==================== */

app.get('/api/calendars', auth, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT google_access_token, google_refresh_token FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows.length === 0 || !userResult.rows[0].google_access_token) {
      return res.status(401).json({ error: 'Google Calendar not connected' });
    }
    
    const user = userResult.rows[0];
    if (googleAuth) {
      const calendars = await googleAuth.getCalendarList(user.google_access_token, user.google_refresh_token);
      res.json(calendars);
    } else {
      res.status(503).json({ error: 'Google Calendar not configured' });
    }
  } catch (e) {
    console.error('Get calendars error:', e);
    res.status(500).json({ error: 'Failed to fetch calendars' });
  }
});

app.put('/api/user/calendar', auth, async (req, res) => {
  const { calendar_id } = req.body;
  if (!calendar_id) return res.status(400).json({ error: 'Calendar ID required' });
  try {
    const result = await pool.query(
      'UPDATE users SET default_calendar_id = $1 WHERE id = $2 RETURNING id, default_calendar_id',
      [calendar_id, req.userId]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (e) {
    console.error('Update calendar error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/calendar/disconnect', auth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET google_access_token = NULL, google_refresh_token = NULL, google_id = NULL, default_calendar_id = NULL WHERE id = $1',
      [req.userId]
    );
    res.json({ success: true, message: 'Calendar disconnected' });
  } catch (e) {
    console.error('Disconnect calendar error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ==================== PROTECTED ROUTES ==================== */

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

/* ==================== HEALTH CHECK ==================== */

app.get('/health', async (req, res) => {
  console.log('🔍 Health check called');
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'ok', 
      google: !!googleAuth, 
      microsoft: !!microsoftAuth,
      email: !!emailService,
      database: true
    });
  } catch (e) {
    res.status(503).json({ status: 'error', database: false });
  }
});

/* ==================== START SERVER ==================== */

console.log('🔍 About to call initDB()...');
initDB().then(() => {
  console.log('🔍 initDB() completed successfully!');
  console.log('🔍 About to call app.listen()...');
  app.listen(PORT, '0.0.0.0', () => {
    console.log('🔍 app.listen() callback fired!');
    console.log('================================');
    console.log('🚀 ScheduleSync API');
    console.log(`📍 Port: ${PORT}`);
    console.log(`✅ All API endpoints loaded`);
    console.log(`${googleAuth ? '✅' : '❌'} Google OAuth`);
    console.log(`${microsoftAuth ? '✅' : '❌'} Microsoft OAuth`);
    console.log(`${emailService ? '✅' : '❌'} Email Service`);
    console.log('================================');
  });
}).catch(e => {
  console.error('❌ Failed to start:', e);
  process.exit(1);
});

process.on('SIGTERM', () => { 
  console.log('🔍 SIGTERM received');
  pool.end(); 
  process.exit(0); 
});

process.on('SIGINT', () => { 
  console.log('🔍 SIGINT received');
  pool.end(); 
  process.exit(0); 
});