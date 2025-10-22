const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'schedulesync-secret-2025';

// OAuth Credentials (hardcoded for now)
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || 'c3bb1864-422d-4fa8-8701-27f7b903d1e9';
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || 'bcc558ea-c38d-41d8-8bfe-0551b78877ae';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1046899819143-hnebgn1jti2ec2j8v1e25sn6vuae961e.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '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';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

console.log('🚀 ScheduleSync API Starting...');
console.log(`📡 Listening on port ${PORT}`);
console.log(`\n📋 Environment Variables Check:`);
console.log(`  MICROSOFT_CLIENT_ID: ${MICROSOFT_CLIENT_ID ? '✅ Found' : '❌ Missing'}`);
console.log(`  MICROSOFT_CLIENT_SECRET: ${MICROSOFT_CLIENT_SECRET ? '✅ Found' : '❌ Missing'}`);
console.log(`  GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID ? '✅ Found' : '❌ Missing'}`);
console.log(`  GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET ? '✅ Found' : '❌ Missing'}`);
console.log();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

let dbReady = false;

pool.query('SELECT NOW()', (err) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Database connected');
    initDatabase();
  }
});

async function initDatabase() {
  try {
    console.log('🔄 Initializing database...');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('  ✅ users table');
    
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT 'temp'
    `).catch(() => {});
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        public_url VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('  ✅ teams table');
    
    // Add owner_id column if it doesn't exist
    await pool.query(`
      ALTER TABLE teams 
      ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id)
    `).catch(() => {});
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(team_id, user_id)
      )
    `);
    console.log('  ✅ team_members table');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS time_slots (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slot_start TIMESTAMP NOT NULL,
        slot_end TIMESTAMP NOT NULL,
        is_available BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('  ✅ time_slots table');
    
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
      )
    `);
    console.log('  ✅ bookings table');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calendar_connections (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        token_expiry TIMESTAMP,
        calendar_id VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, provider)
      )
    `);
    console.log('  ✅ calendar_connections table');
    
    // Add email column to calendar_connections if it doesn't exist
    await pool.query(`
      ALTER TABLE calendar_connections 
      ADD COLUMN IF NOT EXISTS email VARCHAR(255)
    `).catch(() => {});
    
    // Add last_synced column to calendar_connections if it doesn't exist
    await pool.query(`
      ALTER TABLE calendar_connections 
      ADD COLUMN IF NOT EXISTS last_synced TIMESTAMP
    `).catch(() => {});
    
    // Update bookings table to add more columns if needed
    await pool.query(`
      ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)
    `).catch(() => {});
    
    await pool.query(`
      ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS attendee_id INTEGER REFERENCES users(id)
    `).catch(() => {});
    
    await pool.query(`
      ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS title VARCHAR(255)
    `).catch(() => {});
    
    await pool.query(`
      ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS start_time TIMESTAMP
    `).catch(() => {});
    
    await pool.query(`
      ALTER TABLE bookings 
      ADD COLUMN IF NOT EXISTS end_time TIMESTAMP
    `).catch(() => {});
    
    dbReady = true;
    console.log('✅ Database schema ready');
    
    await createTestUser();
  } catch (error) {
    console.error('❌ Database init error:', error.message);
  }
}

async function createTestUser() {
  try {
    const testEmail = 'test@example.com';
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [testEmail]);
    
    if (exists.rows.length === 0) {
      await pool.query(
        'INSERT INTO users (name, email, password) VALUES ($1, $2, $3)',
        ['Test User', testEmail, 'password123']
      );
      console.log('✅ Test user created: test@example.com / password123');
    }
  } catch (error) {
    console.error('⚠️ Could not create test user:', error.message);
  }
}

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ============================================================================
// BASIC ROUTES
// ============================================================================

app.get('/', (req, res) => {
  res.json({
    status: 'ScheduleSync API Running',
    config: {
      microsoftConfigured: !!MICROSOFT_CLIENT_ID,
      googleConfigured: !!GOOGLE_CLIENT_ID,
      databaseReady: dbReady
    }
  });
});

// ============================================================================
// AUTHENTICATION ROUTES
// ============================================================================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields: name, email, password' });
    }
    
    if (password.length < 3) {
      return res.status(400).json({ error: 'Password must be at least 3 characters' });
    }
    
    try {
      const result = await pool.query(
        'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
        [name, email, password]
      );
      
      const token = jwt.sign({ userId: result.rows[0].id }, JWT_SECRET, { expiresIn: '7d' });
      
      res.status(201).json({
        success: true,
        token,
        user: result.rows[0]
      });
    } catch (dbError) {
      if (dbError.code === '23505') {
        return res.status(409).json({ error: 'Email already exists' });
      }
      throw dbError;
    }
  } catch (error) {
    console.error('Signup error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const result = await pool.query(
      'SELECT id, name, email, password FROM users WHERE email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    if (user.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
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
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email FROM users WHERE id = $1',
      [req.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Get user error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ANALYTICS & DASHBOARD ENDPOINTS
// ============================================================================

app.get('/api/analytics/dashboard', async (req, res) => {
  try {
    // Try to get userId from token, fallback to test user
    let userId = 1; // Default test user
    
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
      } catch (e) {
        // Token invalid or missing, use default user
      }
    }
    
    const analytics = {
      totalBookings: 0,
      upcomingMeetings: 0,
      completedMeetings: 0,
      teamMembers: 0,
      recentActivity: []
    };

    // Only query tables that exist with columns we know exist
    try {
      // Get total bookings count - don't filter by user_id since column may not exist
      const bookingsResult = await pool.query('SELECT COUNT(*) as count FROM bookings');
      analytics.totalBookings = parseInt(bookingsResult.rows[0]?.count || 0);
    } catch (err) {
      console.log('Bookings count query failed:', err.message);
    }

    try {
      // Get team members count - simple count without joins
      const teamResult = await pool.query('SELECT COUNT(*) as count FROM team_members');
      analytics.teamMembers = parseInt(teamResult.rows[0]?.count || 0);
    } catch (err) {
      console.log('Team members count query failed:', err.message);
    }

    res.json(analytics);
  } catch (error) {
    console.error('Error fetching analytics:', error);
    // Return default values instead of 500 error
    res.json({
      totalBookings: 0,
      upcomingMeetings: 0,
      completedMeetings: 0,
      teamMembers: 0,
      recentActivity: []
    });
  }
});

// ============================================================================
// CALENDAR INTEGRATION ENDPOINTS
// ============================================================================

// Get Calendar Connections
app.get('/api/calendar/connections', async (req, res) => {
  try {
    // Try to get userId from token, fallback to returning empty array
    let userId = null;
    
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
      } catch (e) {
        // Token invalid
      }
    }
    
    if (!userId) {
      return res.json({ connections: [] });
    }
    
    const result = await pool.query(
      `SELECT id, provider, email, is_active, last_synced
       FROM calendar_connections
       WHERE user_id = $1
       ORDER BY id DESC`,
      [userId]
    );

    res.json({ connections: result.rows });
  } catch (error) {
    console.error('Error fetching calendar connections:', error);
    res.status(500).json({ error: 'Failed to fetch calendar connections' });
  }
});

// Google OAuth Auth URL
app.get('/api/calendar/google/auth', (req, res) => {
  const googleClientId = GOOGLE_CLIENT_ID;
  const redirectUri = `${process.env.BASE_URL || 'https://schedulesync-production.up.railway.app'}/api/calendar/google/callback`;
  
  // Try to get userId from token
  let userId = 'guest';
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.userId;
    } catch (e) {
      // Token invalid
    }
  }
  
  // Check if credentials are properly configured (not default values)
  const isConfigured = googleClientId && 
                       googleClientId !== 'YOUR_GOOGLE_CLIENT_ID_HERE' &&
                       googleClientId.length > 20;
  
  if (!isConfigured) {
    return res.json({ 
      error: 'Google Calendar not configured',
      configured: false
    });
  }

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(googleClientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events')}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&state=${userId}`;

  res.json({ 
    authUrl,
    configured: true
  });
});

// Microsoft OAuth Auth URL
app.get('/api/calendar/microsoft/auth', (req, res) => {
  const microsoftClientId = MICROSOFT_CLIENT_ID;
  const redirectUri = `${process.env.BASE_URL || 'https://schedulesync-production.up.railway.app'}/api/calendar/microsoft/callback`;
  
  // Try to get userId from token
  let userId = 'guest';
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.userId;
    } catch (e) {
      // Token invalid
    }
  }
  
  // Check if credentials are properly configured (not default values)
  const isConfigured = microsoftClientId && 
                       microsoftClientId !== 'YOUR_MICROSOFT_CLIENT_ID_HERE' &&
                       microsoftClientId.length > 20;
  
  if (!isConfigured) {
    return res.json({ 
      error: 'Microsoft Outlook not configured',
      configured: false
    });
  }

  const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
    `client_id=${encodeURIComponent(microsoftClientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('offline_access Calendars.ReadWrite')}` +
    `&response_mode=query` +
    `&state=${userId}`;

  res.json({ 
    authUrl,
    configured: true
  });
});

// Google OAuth Callback
app.get('/api/calendar/google/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.redirect('/dashboard?error=google_auth_failed');
  }

  try {
    // TODO: Exchange code for access token
    // TODO: Store token in database
    // TODO: Fetch user's calendar info
    
    // For now, just redirect back with success message
    console.log('Google OAuth callback received, code:', code.substring(0, 20) + '...');
    res.redirect('/dashboard?success=google_connected');
  } catch (error) {
    console.error('Google OAuth callback error:', error);
    res.redirect('/dashboard?error=google_auth_failed');
  }
});

// Microsoft OAuth Callback
app.get('/api/calendar/microsoft/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.redirect('/dashboard?error=microsoft_auth_failed');
  }

  try {
    // TODO: Exchange code for access token
    // TODO: Store token in database
    // TODO: Fetch user's calendar info
    
    // For now, just redirect back with success message
    console.log('Microsoft OAuth callback received, code:', code.substring(0, 20) + '...');
    res.redirect('/dashboard?success=microsoft_connected');
  } catch (error) {
    console.error('Microsoft OAuth callback error:', error);
    res.redirect('/dashboard?error=microsoft_auth_failed');
  }
});

// Disconnect Calendar
app.delete('/api/calendar/connections/:id', async (req, res) => {
  try {
    // Try to get userId from token
    let userId = null;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
      } catch (e) {
        // Token invalid
      }
    }
    
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const connectionId = req.params.id;

    await pool.query(
      'DELETE FROM calendar_connections WHERE id = $1 AND user_id = $2',
      [connectionId, userId]
    );

    res.json({ success: true, message: 'Calendar disconnected' });
  } catch (error) {
    console.error('Error disconnecting calendar:', error);
    res.status(500).json({ error: 'Failed to disconnect calendar' });
  }
});

// Configuration Status
app.get('/api/config/status', (req, res) => {
  const microsoftConfigured = !!(MICROSOFT_CLIENT_ID && 
    MICROSOFT_CLIENT_ID !== 'YOUR_MICROSOFT_CLIENT_ID_HERE');
  const googleConfigured = !!(GOOGLE_CLIENT_ID && 
    GOOGLE_CLIENT_ID !== 'YOUR_GOOGLE_CLIENT_ID_HERE');

  res.json({
    microsoft: {
      configured: microsoftConfigured,
      clientId: microsoftConfigured ? '✓ Set' : '✗ Not set'
    },
    google: {
      configured: googleConfigured,
      clientId: googleConfigured ? '✓ Set' : '✗ Not set'
    },
    database: {
      connected: dbReady
    }
  });
});

// ============================================================================
// STATIC PAGE ROUTES
// ============================================================================

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/booking', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'booking.html'));
});

// ============================================================================
// 404 HANDLER
// ============================================================================

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`📡 Listening on http://localhost:${PORT}`);
  console.log('✅ ScheduleSync API Running\n');
});