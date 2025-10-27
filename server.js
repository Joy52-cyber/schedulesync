// calendar-booking-routes.js
// Router for guest Google connection, mutual free slots, and booking

const express = require('express');
const router = express.Router();
const googleAuthService = require('./google-auth-service');

// Helper: parse "YYYY-MM-DD" + "h:mm AM/PM" to ISO
function parseDateTimeToISO(dateStr, timeStr) {
  const date = new Date(dateStr);
  const [time, period] = timeStr.split(' ');
  let [hours, minutes] = time.split(':').map(Number);

  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;

  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

// -----------------------------------------------------------------------------
// Guest initiates Google Calendar connection
// GET /api/availability-requests/:token/connect-google
// -----------------------------------------------------------------------------
router.get('/availability-requests/:token/connect-google', async (req, res) => {
  try {
    const { token } = req.params;

    // Verify request exists
    const request = await req.db
      .query('SELECT * FROM availability_requests WHERE token = $1', [token])
      .then(r => r.rows[0]);

    if (!request) {
      return res.status(404).json({ error: 'Availability request not found' });
    }

    // OAuth URL with state so we know it’s a guest flow
    const authUrl = googleAuthService.getAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      state: `guest-${token}`
    });

    res.json({ authUrl });
  } catch (error) {
    console.error('Error initiating guest Google OAuth:', error);
    res.status(500).json({ error: 'Failed to initiate Google Calendar connection' });
  }
});

// -----------------------------------------------------------------------------
// Google OAuth callback (handles both user + guest)
// GET /api/auth/google/callback
// -----------------------------------------------------------------------------
router.get('/auth/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const PUBLIC_BASE_URL = (process.env.APP_URL || 'https://schedulesync-production.up.railway.app').replace(/\/+$/,'');

  if (error) {
    console.error('OAuth error:', error);
    if (state && state.startsWith('guest-')) {
      const token = state.replace('guest-', '');
      return res.redirect(`${PUBLIC_BASE_URL}/availability-request/${token}?error=oauth_failed`);
    }
    return res.redirect('/login?error=' + encodeURIComponent('Google authentication failed'));
  }

  if (!code) {
    if (state && state.startsWith('guest-')) {
      const token = state.replace('guest-', '');
      return res.redirect(`${PUBLIC_BASE_URL}/availability-request/${token}?error=no_code`);
    }
    return res.redirect('/login?error=' + encodeURIComponent('No authorization code received'));
  }

  try {
    // Exchange authorization code for tokens
    const tokens = await googleAuthService.getTokensFromCode(code);
    const { access_token, refresh_token } = tokens || {};
    if (!access_token) throw new Error('No access token received');

    // Fetch Google profile
    const userInfo = await googleAuthService.getUserInfo(access_token);

    // ----- Guest flow (state=guest-<token>) -----
    if (state && state.startsWith('guest-')) {
      const token = state.replace('guest-', '');

      await req.db.query(
        `UPDATE availability_requests
           SET guest_google_access_token = $1,
               guest_google_refresh_token = $2,
               guest_google_email = $3
         WHERE token = $4`,
        [access_token, refresh_token || null, userInfo.email, token]
      );

      return res.redirect(`${PUBLIC_BASE_URL}/availability-request/${token}?google_connected=true`);
    }

    // ----- User flow (owner/admin) -----
    // Check existing by google_id
    let user = await req.db
      .query('SELECT * FROM users WHERE google_id = $1', [userInfo.google_id])
      .then(r => r.rows[0]);

    let hasCalendarConnected = false;

    if (user) {
      // Update tokens & profile
      await req.db.query(
        `UPDATE users
            SET google_access_token = $1,
                google_refresh_token = $2,
                name = $3,
                picture = $4,
                updated_at = NOW()
          WHERE id = $5`,
        [access_token, refresh_token || null, userInfo.name, userInfo.picture || null, user.id]
      );
      hasCalendarConnected = !!user.default_calendar_id;
    } else {
      // Check by email and link
      user = await req.db
        .query('SELECT * FROM users WHERE email = $1', [userInfo.email])
        .then(r => r.rows[0]);

      if (user) {
        await req.db.query(
          `UPDATE users
              SET google_id = $1,
                  google_access_token = $2,
                  google_refresh_token = $3,
                  name = $4,
                  picture = $5,
                  updated_at = NOW()
            WHERE id = $6`,
          [userInfo.google_id, access_token, refresh_token || null, userInfo.name, userInfo.picture || null, user.id]
        );
        hasCalendarConnected = !!user.default_calendar_id;
      } else {
        // New user
        const inserted = await req.db.query(
          `INSERT INTO users (email, name, google_id, google_access_token, google_refresh_token, picture)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, email, name, picture`,
          [userInfo.email, userInfo.name, userInfo.google_id, access_token, refresh_token || null, userInfo.picture || null]
        );
        user = inserted.rows[0];
        hasCalendarConnected = false;
      }
    }

    // Issue JWT
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = (process.env.JWT_SECRET || 'schedulesync-secret-2025').trim();
    const jwtToken = jwt.sign(
      { id: user.id, email: user.email || userInfo.email, name: user.name || userInfo.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Smart redirect
    const redirectParams = new URLSearchParams({
      token: jwtToken,
      user: JSON.stringify({
        id: user.id,
        email: user.email || userInfo.email,
        name: user.name || userInfo.name,
        picture: user.picture || userInfo.picture || null
      })
    });

    if (hasCalendarConnected) {
      return res.redirect(`/dashboard?${redirectParams.toString()}`);
    } else {
      return res.redirect(`/calendar-setup?connected=true&${redirectParams.toString()}`);
    }
  } catch (err) {
    console.error('Error in Google callback:', err);
    if (state && state.startsWith('guest-')) {
      const token = state.replace('guest-', '');
      return res.redirect(`${(process.env.APP_URL || '').replace(/\/+$/,'') || 'https://schedulesync-production.up.railway.app'}/availability-request/${token}?error=oauth_failed`);
    }
    return res.redirect('/login?error=' + encodeURIComponent('Authentication failed. Please try again.'));
  }
});

// -----------------------------------------------------------------------------
// Check Google connection status for a given request
// GET /api/availability-requests/:token/google-status
// -----------------------------------------------------------------------------
router.get('/availability-requests/:token/google-status', async (req, res) => {
  try {
    const { token } = req.params;

    const request = await req.db.query(
      `SELECT ar.guest_google_access_token,
              ar.guest_google_email,
              u.google_access_token AS owner_access_token
         FROM availability_requests ar
         JOIN teams t ON ar.team_id = t.id
         JOIN users u ON t.owner_id = u.id
        WHERE ar.token = $1`,
      [token]
    ).then(r => r.rows[0]);

    if (!request) {
      return res.status(404).json({ error: 'Availability request not found' });
    }

    res.json({
      guestConnected: !!request.guest_google_access_token,
      guestEmail: request.guest_google_email,
      ownerConnected: !!request.owner_access_token
    });
  } catch (error) {
    console.error('Error checking Google status:', error);
    res.status(500).json({ error: 'Failed to check connection status' });
  }
});

// -----------------------------------------------------------------------------
// Mutual free slots using both calendars
// GET /api/availability-requests/:token/calendar-slots?days=14&duration=60
// -----------------------------------------------------------------------------
router.get('/availability-requests/:token/calendar-slots', async (req, res) => {
  try {
    const { token } = req.params;
    const { days = 14, duration = 60 } = req.query;

    const request = await req.db.query(
      `SELECT ar.*,
              t.owner_id,
              u.google_access_token  AS owner_access_token,
              u.google_refresh_token AS owner_refresh_token
         FROM availability_requests ar
         JOIN teams t ON ar.team_id = t.id
         JOIN users u ON t.owner_id = u.id
        WHERE ar.token = $1`,
      [token]
    ).then(r => r.rows[0]);

    if (!request) {
      return res.status(404).json({ error: 'Availability request not found' });
    }
    if (!request.guest_google_access_token) {
      return res.status(400).json({ error: 'Google Calendar not connected', needsGoogleAuth: true });
    }
    if (!request.owner_access_token) {
      return res.status(400).json({ error: 'Team owner has not connected Google Calendar', ownerNeedsAuth: true });
    }

    // Range
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + parseInt(days, 10));
    endDate.setHours(23, 59, 59, 999);

    // Busy times (owner + guest)
    const [guestBusy, ownerBusy] = await Promise.all([
      googleAuthService.getBusyTimes(request.guest_google_access_token, startDate, endDate),
      googleAuthService.getBusyTimes(request.owner_access_token, startDate, endDate)
    ]);

    const allBusyTimes = [...guestBusy, ...ownerBusy].map(b => ({
      start: new Date(b.start),
      end: new Date(b.end)
    }));

    const freeSlots = calculateFreeSlots(startDate, endDate, allBusyTimes, parseInt(duration, 10));
    const formattedSlots = freeSlots.map(formatTimeSlot);

    // Group by friendly date label for UI
    const groupedByDate = formattedSlots.reduce((acc, s) => {
      (acc[s.date] ||= []).push(s);
      return acc;
    }, {});

    res.json({
      success: true,
      totalSlots: freeSlots.length,
      slots: formattedSlots,
      groupedByDate,
      searchRange: { start: startDate.toISOString(), end: endDate.toISOString() }
    });
  } catch (error) {
    console.error('Error getting calendar slots:', error);
    res.status(500).json({ error: 'Failed to find available time slots' });
  }
});

// -----------------------------------------------------------------------------
// Book a slot and create calendar events (with Google Meet)
// POST /api/availability-requests/:token/book-calendar { startTime, endTime }
// -----------------------------------------------------------------------------
router.post('/availability-requests/:token/book-calendar', async (req, res) => {
  try {
    const { token } = req.params;
    const { startTime, endTime } = req.body || {};

    if (!startTime || !endTime) {
      return res.status(400).json({ error: 'Start time and end time are required' });
    }

    const request = await req.db.query(
      `SELECT ar.*,
              t.name AS team_name,
              t.description AS team_description,
              t.owner_id,
              u.name  AS owner_name,
              u.email AS owner_email,
              u.google_access_token  AS owner_access_token,
              u.google_refresh_token AS owner_refresh_token
         FROM availability_requests ar
         JOIN teams t ON ar.team_id = t.id
         JOIN users u ON t.owner_id = u.id
        WHERE ar.token = $1`,
      [token]
    ).then(r => r.rows[0]);

    if (!request) {
      return res.status(404).json({ error: 'Availability request not found' });
    }
    if (!['pending','submitted'].includes(request.status)) {
      return res.status(400).json({ error: 'This request has already been processed' });
    }
    if (!request.guest_google_access_token || !request.owner_access_token) {
      return res.status(400).json({ error: 'Both parties must have Google Calendar connected' });
    }

    const eventData = {
      summary: `Meeting: ${request.guest_name} & ${request.owner_name}`,
      description:
        `${request.team_name}` +
        (request.team_description ? `\n\n${request.team_description}` : '') +
        (request.guest_notes ? `\n\nNotes: ${request.guest_notes}` : ''),
      start: { dateTime: startTime, timeZone: 'UTC' },
      end:   { dateTime: endTime,   timeZone: 'UTC' },
      attendees: [
        { email: request.owner_email },
        { email: request.guest_google_email || request.guest_email }
      ],
      conferenceData: {
        createRequest: {
          requestId: `meet-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 },
          { method: 'popup', minutes: 30 }
        ]
      }
    };

    const createdEvent = await googleAuthService.createCalendarEvent(
      request.owner_access_token,
      eventData
    );

    const meetLink =
      createdEvent.hangoutLink ||
      createdEvent.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri ||
      null;

    const bookingDate = new Date(startTime).toISOString().split('T')[0];
    const bookingTime = new Date(startTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    const inserted = await req.db.query(
      `INSERT INTO bookings(
         team_id, guest_name, guest_email, guest_notes,
         booking_date, booking_time, slot_start, slot_end,
         calendar_event_id, meet_link, status
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed')
       RETURNING id`,
      [
        request.team_id,
        request.guest_name,
        request.guest_email,
        request.guest_notes || '',
        bookingDate,
        bookingTime,
        startTime,
        endTime,
        createdEvent.id,
        meetLink
      ]
    );
    const bookingId = inserted.rows[0].id;

    await req.db.query(
      `UPDATE availability_requests
          SET status = 'booked',
              booked_date = $1,
              booked_time = $2,
              booking_id = $3
        WHERE id = $4`,
      [bookingDate, bookingTime, bookingId, request.id]
    );

    res.status(201).json({
      success: true,
      booking: {
        id: bookingId,
        date: bookingDate,
        time: bookingTime,
        meetLink,
        calendarLink: createdEvent.htmlLink,
        status: 'confirmed'
      },
      message: 'Meeting booked successfully! Calendar invites have been sent.'
    });
  } catch (error) {
    console.error('Error booking calendar event:', error);
    res.status(500).json({ error: 'Failed to book the meeting' });
  }
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function calculateFreeSlots(startDate, endDate, busyTimes, duration) {
  const freeSlots = [];
  let currentTime = new Date(startDate);

  const workStart = 9;  // 9 AM
  const workEnd = 17;   // 5 PM

  const sortedBusy = [...busyTimes].sort((a, b) => a.start - b.start);

  while (currentTime < endDate) {
    const currentHour = currentTime.getHours();
    const currentDay = currentTime.getDay();

    // Skip weekends
    if (currentDay === 0 || currentDay === 6) {
      currentTime.setDate(currentTime.getDate() + 1);
      currentTime.setHours(workStart, 0, 0, 0);
      continue;
    }

    // Clamp to working hours
    if (currentHour < workStart) {
      currentTime.setHours(workStart, 0, 0, 0);
      continue;
    }
    if (currentHour >= workEnd) {
      currentTime.setDate(currentTime.getDate() + 1);
      currentTime.setHours(workStart, 0, 0, 0);
      continue;
    }

    const slotEnd = new Date(currentTime.getTime() + duration * 60000);

    const isBusy = sortedBusy.some(busy =>
      (currentTime >= busy.start && currentTime < busy.end) ||
      (slotEnd > busy.start && slotEnd <= busy.end) ||
      (currentTime <= busy.start && slotEnd >= busy.end)
    );

    if (!isBusy && slotEnd.getHours() <= workEnd) {
      freeSlots.push({
        start: new Date(currentTime),
        end: new Date(slotEnd),
        duration
      });
    }

    // Advance by 30 minutes
    currentTime = new Date(currentTime.getTime() + 30 * 60000);
  }

  return freeSlots;
}

function formatTimeSlot(slot) {
  const fmtTime = (date) => {
    const h = date.getHours();
    const m = date.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hh = (h % 12) || 12;
    return `${hh}:${String(m).padStart(2,'0')} ${ampm}`;
  };
  const fmtDate = (date) => {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}`;
  };
  return {
    date: fmtDate(slot.start),
    time: fmtTime(slot.start),
    endTime: fmtTime(slot.end),
    startISO: slot.start.toISOString(),
    endISO: slot.end.toISOString(),
    duration: slot.duration
  };
}

module.exports = router;
