// calendar-booking-routes.js
const express = require('express');
const router = express.Router();

// Check Google connection status
router.get('/availability-requests/:token/google-status', async (req, res) => {
  const { token } = req.params;

  try {
    const request = await req.db
      .query('SELECT * FROM availability_requests WHERE token=$1', [token])
      .then(r => r.rows[0]);

    if (!request)
      return res.status(404).json({ error: 'Availability request not found' });

    res.json({
      connected: !!request.guest_google_access_token,
      email: request.guest_google_email || null
    });
  } catch (err) {
    console.error('google-status error:', err.message);
    res.status(500).json({ error: 'Failed to check Google status' });
  }
});

// Start Google OAuth flow for guests
router.get('/availability-requests/:token/connect-google', async (req, res) => {
  const { token } = req.params;

  try {
    const request = await req.db
      .query('SELECT * FROM availability_requests WHERE token=$1', [token])
      .then(r => r.rows[0]);

    if (!request)
      return res.status(404).json({ error: 'Availability request not found' });

    const redirect = encodeURIComponent(
      `${process.env.APP_URL}/api/auth/google/callback?token=${token}`
    );
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const scope = encodeURIComponent('https://www.googleapis.com/auth/calendar.events');

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirect}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;

    res.json({ authUrl });
  } catch (err) {
    console.error('connect-google error:', err.message);
    res.status(500).json({ error: 'Failed to initiate Google connect' });
  }
});

module.exports = router;
