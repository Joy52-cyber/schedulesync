// google-oauth-routes.js - Updated Google OAuth routes with smart redirect

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const googleAuthService = require('./google-auth-service');
const db = require('./database'); // Your database connection

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

/**
 * GET /api/auth/google
 * Initiates Google OAuth flow
 */
router.get('/google', (req, res) => {
  try {
    const authUrl = googleAuthService.getAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    console.error('Error initiating Google OAuth:', error);
    res.status(500).json({ error: 'Failed to initiate Google authentication' });
  }
});

/**
 * GET /api/auth/google/callback
 * Handles Google OAuth callback
 * UPDATED: Redirects to dashboard if calendar already connected, otherwise to calendar setup
 */
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error('OAuth error:', error);
    return res.redirect('/login?error=' + encodeURIComponent('Google authentication failed'));
  }

  if (!code) {
    return res.redirect('/login?error=' + encodeURIComponent('No authorization code received'));
  }

  try {
    // 1. Exchange code for tokens
    const tokens = await googleAuthService.getTokensFromCode(code);
    const { access_token, refresh_token } = tokens;

    if (!access_token) {
      throw new Error('No access token received');
    }

    // 2. Get user info from Google
    const userInfo = await googleAuthService.getUserInfo(access_token);

    // 3. Check if user exists in database
    let user = await db.get(
      'SELECT * FROM users WHERE google_id = ?',
      [userInfo.google_id]
    );

    let isNewUser = false;
    let hasCalendarConnected = false;

    if (user) {
      // Existing user - update tokens
      await db.run(
        `UPDATE users 
         SET google_access_token = ?,
             google_refresh_token = ?,
             name = ?,
             picture = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [access_token, refresh_token, userInfo.name, userInfo.picture, user.id]
      );

      // Check if they already have a calendar connected
      hasCalendarConnected = !!user.default_calendar_id;

    } else {
      // New user - check if email exists (they might have registered with email/password first)
      user = await db.get(
        'SELECT * FROM users WHERE email = ?',
        [userInfo.email]
      );

      if (user) {
        // Link Google account to existing email account
        await db.run(
          `UPDATE users 
           SET google_id = ?,
               google_access_token = ?,
               google_refresh_token = ?,
               name = ?,
               picture = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [userInfo.google_id, access_token, refresh_token, userInfo.name, userInfo.picture, user.id]
        );

        hasCalendarConnected = !!user.default_calendar_id;

      } else {
        // Brand new user - create account
        const result = await db.run(
          `INSERT INTO users (email, name, google_id, google_access_token, google_refresh_token, picture)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [userInfo.email, userInfo.name, userInfo.google_id, access_token, refresh_token, userInfo.picture]
        );

        user = {
          id: result.lastID,
          email: userInfo.email,
          name: userInfo.name,
          google_id: userInfo.google_id,
          picture: userInfo.picture
        };

        isNewUser = true;
        hasCalendarConnected = false;
      }
    }

    // 4. Generate JWT token
    const jwtToken = jwt.sign(
      {
        id: user.id,
        email: user.email || userInfo.email,
        name: user.name || userInfo.name
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // 5. Smart redirect based on calendar connection status
    const redirectParams = new URLSearchParams({
      token: jwtToken,
      user: JSON.stringify({
        id: user.id,
        email: user.email || userInfo.email,
        name: user.name || userInfo.name,
        picture: user.picture || userInfo.picture
      })
    });

    // UPDATED LOGIC: Smart redirect
    if (hasCalendarConnected) {
      // User already has calendar connected - go directly to dashboard
      console.log(`✅ User ${user.id} has calendar connected, redirecting to dashboard`);
      return res.redirect(`/dashboard?${redirectParams.toString()}`);
    } else {
      // User needs to select a calendar - go to calendar setup
      console.log(`📅 User ${user.id} needs to select calendar, redirecting to setup`);
      return res.redirect(`/calendar-setup?connected=true&${redirectParams.toString()}`);
    }

  } catch (error) {
    console.error('Error in Google callback:', error);
    return res.redirect('/login?error=' + encodeURIComponent('Authentication failed. Please try again.'));
  }
});

/**
 * GET /api/auth/logout
 * Logout user (optional - can clear server-side sessions if needed)
 */
router.post('/logout', (req, res) => {
  // If you're using sessions, clear them here
  // For JWT-only auth, client handles logout by removing token
  res.json({ success: true, message: 'Logged out successfully' });
});

module.exports = router;