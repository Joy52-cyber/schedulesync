// auth-routes.js - Updated authentication routes with calendar status

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./database'); // Your database connection

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

/**
 * POST /api/auth/register
 * Register new user with email/password
 */
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // Check if user already exists
    const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    
    if (existingUser) {
      return res.status(409).json({ 
        error: 'An account with this email already exists',
        type: 'email_exists'
      });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Create user
    const result = await db.run(
      'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)',
      [email, password_hash, name || null]
    );

    // Generate JWT
    const token = jwt.sign(
      { id: result.lastID, email, name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      token,
      user: {
        id: result.lastID,
        email,
        name,
        has_calendar_connected: false // New users don't have calendar yet
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

/**
 * POST /api/auth/login
 * Login with email/password
 * UPDATED: Returns calendar connection status
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // Get user from database
    const user = await db.get(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );

    // Check if user exists
    if (!user) {
      return res.status(401).json({ 
        error: 'No account found with this email',
        type: 'email_not_found'
      });
    }

    // Check if user has a password (they might have only signed up with Google)
    if (!user.password_hash) {
      return res.status(401).json({ 
        error: 'Please sign in with Google or Microsoft',
        type: 'no_password'
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!isValidPassword) {
      return res.status(401).json({ 
        error: 'Incorrect password',
        type: 'wrong_password'
      });
    }

    // UPDATED: Check if user has calendar connected
    const hasCalendarConnected = !!(user.default_calendar_id && 
      (user.google_access_token || user.microsoft_access_token));

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        has_calendar_connected: hasCalendarConnected // ✅ NEW: Include calendar status
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /api/users/me
 * Get current user info
 * UPDATED: Includes calendar connection status
 */
router.get('/users/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, email, name, picture, default_calendar_id, google_access_token, microsoft_access_token FROM users WHERE id = ?',
      [req.user.id]
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if calendar is connected
    const hasCalendarConnected = !!(user.default_calendar_id && 
      (user.google_access_token || user.microsoft_access_token));

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        default_calendar_id: user.default_calendar_id,
        has_calendar_connected: hasCalendarConnected
      }
    });

  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * Middleware: Authenticate JWT token
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

module.exports = router;