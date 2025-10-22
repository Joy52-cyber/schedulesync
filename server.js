// ScheduleSync - Minimal Working Version
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'schedulesync-secret';
const DATABASE_URL = process.env.DATABASE_URL;

console.log('Starting ScheduleSync...');
console.log('DATABASE_URL exists:', !!DATABASE_URL);
console.log('PORT:', PORT);

// Database connection
let pool = null;
if (DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    pool.query('SELECT NOW()', (err) => {
      if (err) {
        console.error('❌ DB Error:', err.message);
      } else {
        console.log('✅ Database connected');
      }
    });
  } catch (e) {
    console.error('Failed to create pool:', e.message);
  }
} else {
  console.warn('⚠️ No DATABASE_URL - using mock mode');
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbStatus = 'connected';
    } catch (e) {
      dbStatus = 'error';
    }
  }
  
  res.json({
    status: 'ok',
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
});

// Auth register
app.post('/api/auth/register', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database not available' });
    
    const { email, name, extensionId } = req.body;
    
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    let user;
    if (existing.rows.length > 0) {
      user = existing.rows[0];
      await pool.query('UPDATE users SET extension_id = $1 WHERE id = $2', [extensionId, user.id]);
    } else {
      const result = await pool.query(
        'INSERT INTO users (email, name, extension_id) VALUES ($1, $2, $3) RETURNING *',
        [email, name, extensionId]
      );
      user = result.rows[0];
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get teams
app.get('/api/teams', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database not available' });
    
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    
    const decoded = jwt.verify(token, JWT_SECRET);
    
    const result = await pool.query(
      `SELECT t.*, tm.role, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
       FROM teams t
       JOIN team_members tm ON t.id = tm.team_id
       WHERE tm.user_id = $1
       ORDER BY t.created_at DESC`,
      [decoded.userId]
    );
    
    res.json({ teams: result.rows });
  } catch (e) {
    console.error('Get teams error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Create team
app.post('/api/teams', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database not available' });
    
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const { name, schedulingMode } = req.body;
    
    const result = await pool.query(
      `INSERT INTO teams (name, created_by, public_url, scheduling_mode, is_active, created_at)
       VALUES ($1, $2, $3, $4, true, NOW())
       RETURNING *`,
      [name, decoded.userId, name.toLowerCase().replace(/\s+/g, '-'), schedulingMode || 'round_robin']
    );
    
    const team = result.rows[0];
    
    await pool.query(
      `INSERT INTO team_members (team_id, user_id, role, joined_at)
       VALUES ($1, $2, $3, NOW())`,
      [team.id, decoded.userId, 'admin']
    );
    
    res.json({ success: true, team });
  } catch (e) {
    console.error('Create team error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get team details
app.get('/api/teams/:teamId', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database not available' });
    
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const { teamId } = req.params;
    
    const teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [teamId]);
    if (teamResult.rows.length === 0) return res.status(404).json({ error: 'Team not found' });
    
    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email, tm.role
       FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1`,
      [teamId]
    );
    
    res.json({ team: teamResult.rows[0], members: membersResult.rows });
  } catch (e) {
    console.error('Get team error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Add team member
app.post('/api/teams/:teamId/members', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database not available' });
    
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const { teamId } = req.params;
    const { userId, role } = req.body;
    
    await pool.query(
      `INSERT INTO team_members (team_id, user_id, role, joined_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [teamId, userId, role || 'member']
    );
    
    res.json({ success: true });
  } catch (e) {
    console.error('Add member error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Booking endpoints
app.get('/api/booking/team/:publicUrl', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database not available' });
    
    const { publicUrl } = req.params;
    
    const teamResult = await pool.query(
      'SELECT id, name, description, scheduling_mode FROM teams WHERE public_url = $1 AND is_active = true',
      [publicUrl]
    );
    
    if (teamResult.rows.length === 0) return res.status(404).json({ error: 'Team not found' });
    
    const team = teamResult.rows[0];
    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email
       FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1`,
      [team.id]
    );
    
    res.json({
      team: {
        id: team.id,
        name: team.name,
        description: team.description,
        schedulingMode: team.scheduling_mode,
        members: membersResult.rows
      }
    });
  } catch (e) {
    console.error('Get booking team error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/booking/availability/:teamId', async (req, res) => {
  res.json({ availableSlots: generateSlots() });
});

app.post('/api/booking/create', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database not available' });
    
    const { teamId, slotStart, slotEnd, guestEmail, guestName } = req.body;
    
    const result = await pool.query(
      `INSERT INTO bookings (team_id, slot_start, slot_end, guest_email, guest_name, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
       RETURNING *`,
      [teamId, slotStart, slotEnd, guestEmail, guestName]
    );
    
    res.json({ success: true, booking: result.rows[0] });
  } catch (e) {
    console.error('Create booking error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/analytics/dashboard', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database not available' });
    
    const users = await pool.query('SELECT COUNT(*) as count FROM users');
    const bookings = await pool.query('SELECT COUNT(*) as count FROM bookings');
    
    res.json({
      stats: {
        totalUsers: parseInt(users.rows[0].count),
        totalBookings: parseInt(bookings.rows[0].count),
        activeConnections: 0,
        cacheHitRate: 85
      }
    });
  } catch (e) {
    console.error('Analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Helper function
function generateSlots() {
  const slots = [];
  const now = new Date();
  for (let i = 1; i <= 10; i++) {
    const start = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    start.setHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    slots.push({ start: start.toISOString(), end: end.toISOString() });
  }
  return slots;
}

// Serve HTML pages
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/team-management', (req, res) => res.sendFile(path.join(__dirname, 'public', 'team-management.html')));
app.get('/booking.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'booking.html')));

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});