/* ======================== CALENDAR API ENDPOINTS ======================== */
// Add these to your server.js file

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