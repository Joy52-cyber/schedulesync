// google-oauth-routes.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const googleAuthService = require('./google-auth-service');

// GET /api/auth/google  →  Returns the Google OAuth URL to the frontend
router.get('/google', async (req, res) => {
  try {
    const { token, state } = req.query;
    const authUrl = require('./google-auth-service').getAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      state: state || (token ? `guest-${token}` : undefined)
    });
    res.json({ authUrl });
  } catch (err) {
    console.error('Error generating Google auth URL:', err);
    res.status(500).json({ error: 'Failed to generate Google auth URL' });
  }
});


// GET /api/auth/google/callback
router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const PUBLIC_BASE_URL = (process.env.APP_URL || 'https://schedulesync-production.up.railway.app').replace(/\/+$/,'');
  const JWT_SECRET = (process.env.JWT_SECRET || 'schedulesync-secret-2025').trim();

  try {
    if (error) {
      if (state && String(state).startsWith('guest-')) {
        const token = String(state).replace('guest-','');
        return res.redirect(`${PUBLIC_BASE_URL}/availability-request/${token}?error=oauth_failed`);
      }
      return res.redirect('/login?error=' + encodeURIComponent('Google authentication failed'));
    }

    if (!code) {
      if (state && String(state).startsWith('guest-')) {
        const token = String(state).replace('guest-','');
        return res.redirect(`${PUBLIC_BASE_URL}/availability-request/${token}?error=no_code`);
      }
      return res.redirect('/login?error=' + encodeURIComponent('No authorization code received'));
    }

    // 1) Exchange code for tokens
    const tokens = await googleAuthService.getTokensFromCode(code);
    const { access_token, refresh_token } = tokens || {};
    if (!access_token) throw new Error('No access token received');

    // 2) Fetch Google profile
    const userInfo = await googleAuthService.getUserInfo(access_token); // {email,name,picture,google_id}

    // ---------------- Guest flow ----------------
    if (state && String(state).startsWith('guest-')) {
      const token = String(state).replace('guest-','');

      // Ensure request exists
      const found = await req.db.query('SELECT id FROM availability_requests WHERE token=$1', [token]);
      if (!found.rowCount) {
        return res.redirect(`${PUBLIC_BASE_URL}/availability-request/${token}?error=not_found`);
      }

      // Save guest tokens on the availability request
      await req.db.query(
        `UPDATE availability_requests
           SET guest_google_access_token=$1,
               guest_google_refresh_token=$2,
               guest_google_email=$3
         WHERE token=$4`,
        [access_token, refresh_token || null, userInfo.email || null, token]
      );

      return res.redirect(`${PUBLIC_BASE_URL}/availability-request/${token}?google_connected=true`);
    }

    // ---------------- Owner/User flow ----------------
    // Try by google_id first
    let user = await req.db
      .query('SELECT * FROM users WHERE google_id=$1', [userInfo.google_id])
      .then(r => r.rows[0]);

    let hasCalendarConnected = false;

    if (user) {
      await req.db.query(
        `UPDATE users
            SET google_access_token=$1,
                google_refresh_token=$2,
                name=$3,
                picture=$4
          WHERE id=$5`,
        [access_token, refresh_token || user.google_refresh_token, userInfo.name, userInfo.picture, user.id]
      );
      hasCalendarConnected = Boolean(user.default_calendar_id);
    } else {
      // Link by email, or create
      user = await req.db
        .query('SELECT * FROM users WHERE email=$1', [userInfo.email])
        .then(r => r.rows[0]);

      if (user) {
        await req.db.query(
          `UPDATE users
              SET google_id=$1,
                  google_access_token=$2,
                  google_refresh_token=$3,
                  name=$4,
                  picture=$5
            WHERE id=$6`,
          [userInfo.google_id, access_token, refresh_token || user.google_refresh_token, userInfo.name, userInfo.picture, user.id]
        );
        hasCalendarConnected = Boolean(user.default_calendar_id);
      } else {
        const inserted = await req.db.query(
          `INSERT INTO users (email, name, google_id, google_access_token, google_refresh_token, picture, timezone)
           VALUES ($1,$2,$3,$4,$5,$6,'UTC')
           RETURNING id,email,name,picture,google_id,google_refresh_token,default_calendar_id`,
          [userInfo.email, userInfo.name, userInfo.google_id, access_token, refresh_token || null, userInfo.picture]
        );
        user = inserted.rows[0];
        hasCalendarConnected = Boolean(user.default_calendar_id);
      }
    }

    // 3) Issue a JWT for your app
    const jwtToken = jwt.sign(
      { id: user.id, email: user.email || userInfo.email, name: user.name || userInfo.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const qp = new URLSearchParams({
      token: jwtToken,
      user: JSON.stringify({
        id: user.id,
        email: user.email || userInfo.email,
        name: user.name || userInfo.name,
        picture: user.picture || userInfo.picture
      })
    });

    // 4) Smart redirect
    if (hasCalendarConnected) {
      return res.redirect(`/dashboard?${qp.toString()}`);
    } else {
      return res.redirect(`/calendar-setup?connected=true&${qp.toString()}`);
    }
  } catch (err) {
    console.error('Error in Google callback:', err?.stack || err?.message || err);
    if (state && String(state).startsWith('guest-')) {
      const token = String(state).replace('guest-','');
      return res.redirect(`${PUBLIC_BASE_URL}/availability-request/${token}?error=oauth_failed`);
    }
    return res.redirect('/login?error=' + encodeURIComponent('Authentication failed. Please try again.'));
  }
});

module.exports = router;
