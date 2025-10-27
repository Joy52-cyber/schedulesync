// At the top, REMOVE lines 15-17 and ADD:
const googleAuthService = require('./google-auth-service');

// DELETE duplicate health routes (lines 127-131)

// REMOVE lines 570-571:
// app.use('/api/auth', googleOAuthRoutes);
// app.use('/api', calendarBookingRoutes);

// INSTEAD, add these routes AFTER line 567:

// ============================================================================
// GUEST GOOGLE CALENDAR INTEGRATION
// ============================================================================

// Guest initiates Google Calendar connection
app.get('/api/availability-requests/:token/connect-google', async (req, res) => {
  try {
    const { token } = req.params;
    
    const request = await pool.query(
      'SELECT * FROM availability_requests WHERE token=$1 AND status IN ($2, $3)',
      [token, 'pending', 'submitted']
    ).then(r => r.rows[0]);

    if (!request) {
      return res.status(404).json({ error: 'Availability request not found' });
    }

    const authUrl = googleAuthService.getAuthUrl({ 
      state: `guest:${token}`,
      prompt: 'consent'
    });
    
    res.json({ authUrl });
  } catch (error) {
    console.error('Error initiating guest Google OAuth:', error);
    res.status(500).json({ error: 'Failed to initiate Google Calendar connection' });
  }
});

// Updated OAuth callback (handles both user and guest)
app.get('/api/auth/google/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    return res.redirect(`${PUBLIC_BASE_URL}/login?error=` + encodeURIComponent('Authentication failed'));
  }

  if (!code) {
    return res.redirect(`${PUBLIC_BASE_URL}/login?error=` + encodeURIComponent('No code received'));
  }

  try {
    const tokens = await googleAuthService.getTokensFromCode(code);
    const { access_token, refresh_token } = tokens;
    const userInfo = await googleAuthService.getUserInfo(access_token);

    // GUEST connection?
    if (state && state.startsWith('guest:')) {
      const requestToken = state.substring(6);
      
      await pool.query(
        `UPDATE availability_requests 
         SET guest_google_access_token=$1, 
             guest_google_refresh_token=$2,
             guest_google_email=$3
         WHERE token=$4`,
        [access_token, refresh_token, userInfo.email, requestToken]
      );

      return res.redirect(`${PUBLIC_BASE_URL}/availability-request/${requestToken}?google_connected=true`);
    }

    // USER login/signup
    let user = await pool.query('SELECT * FROM users WHERE google_id = $1', [userInfo.google_id]).then(r => r.rows[0]);

    if (user) {
      await pool.query(
        `UPDATE users SET google_access_token=$1, google_refresh_token=$2, name=$3, picture=$4 WHERE id=$5`,
        [access_token, refresh_token, userInfo.name, userInfo.picture, user.id]
      );
    } else {
      user = await pool.query('SELECT * FROM users WHERE email = $1', [userInfo.email]).then(r => r.rows[0]);

      if (user) {
        await pool.query(
          `UPDATE users SET google_id=$1, google_access_token=$2, google_refresh_token=$3, name=$4, picture=$5 WHERE id=$6`,
          [userInfo.google_id, access_token, refresh_token, userInfo.name, userInfo.picture, user.id]
        );
      } else {
        const result = await pool.query(
          `INSERT INTO users (email, name, google_id, google_access_token, google_refresh_token, picture, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
          [userInfo.email, userInfo.name, userInfo.google_id, access_token, refresh_token, userInfo.picture]
        );
        user = result.rows[0];
      }
    }

    const jwtToken = jwt.sign({ userId: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    const redirectParams = new URLSearchParams({
      token: jwtToken,
      user: JSON.stringify({ id: user.id, email: user.email, name: user.name, picture: user.picture })
    });

    return res.redirect(`${PUBLIC_BASE_URL}/dashboard?${redirectParams.toString()}`);

  } catch (error) {
    console.error('OAuth error:', error);
    return res.redirect(`${PUBLIC_BASE_URL}/login?error=auth_failed`);
  }
});

// Get calendar slots
app.get('/api/availability-requests/:token/calendar-slots', async (req, res) => {
  try {
    const { token } = req.params;
    const { days = 14, duration = 60 } = req.query;

    const request = await pool.query(
      `SELECT ar.*, t.owner_id, u.google_access_token as owner_access_token,
              u.google_refresh_token as owner_refresh_token
       FROM availability_requests ar
       JOIN teams t ON ar.team_id = t.id
       JOIN users u ON t.owner_id = u.id
       WHERE ar.token = $1`,
      [token]
    ).then(r => r.rows[0]);

    if (!request) return res.status(404).json({ error: 'Not found' });
    if (!request.guest_google_access_token) return res.status(400).json({ error: 'Connect calendar first', needsGoogleAuth: true });
    if (!request.owner_access_token) return res.status(400).json({ error: 'Owner calendar not connected', ownerNeedsAuth: true });

    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + parseInt(days));

    const [guestBusy, ownerBusy] = await Promise.all([
      googleAuthService.getBusyTimes(request.guest_google_access_token, startDate, endDate).catch(() => []),
      googleAuthService.getBusyTimes(request.owner_access_token, startDate, endDate).catch(() => [])
    ]);

    const allBusy = [...guestBusy, ...ownerBusy];
    const freeSlots = findFreeSlots(startDate, endDate, allBusy, parseInt(duration));
    const formattedSlots = freeSlots.map(slot => formatTimeSlot(slot));

    const groupedSlots = formattedSlots.reduce((acc, slot) => {
      if (!acc[slot.date]) acc[slot.date] = [];
      acc[slot.date].push(slot);
      return acc;
    }, {});

    res.json({ success: true, totalSlots: freeSlots.length, slots: formattedSlots, groupedByDate: groupedSlots });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to find slots' });
  }
});

// Book calendar event
app.post('/api/availability-requests/:token/book-calendar', async (req, res) => {
  try {
    const { token } = req.params;
    const { startTime, endTime } = req.body;

    const request = await pool.query(
      `SELECT ar.*, t.name as team_name, t.owner_id, u.name as owner_name, u.email as owner_email,
              u.google_access_token as owner_access_token
       FROM availability_requests ar
       JOIN teams t ON ar.team_id = t.id
       JOIN users u ON t.owner_id = u.id
       WHERE ar.token = $1`,
      [token]
    ).then(r => r.rows[0]);

    if (!request) return res.status(404).json({ error: 'Not found' });
    if (request.status === 'booked') return res.status(400).json({ error: 'Already booked' });

    const eventData = {
      summary: `Meeting: ${request.guest_name} & ${request.owner_name}`,
      description: request.team_name,
      start: { dateTime: startTime, timeZone: 'UTC' },
      end: { dateTime: endTime, timeZone: 'UTC' },
      attendees: [{ email: request.owner_email }, { email: request.guest_google_email }],
      conferenceData: {
        createRequest: { requestId: `meet-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } }
      }
    };

    const createdEvent = await googleAuthService.createCalendarEvent(request.owner_access_token, eventData);
    const meetLink = createdEvent.hangoutLink || createdEvent.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri;

    const startDate = new Date(startTime);
    const booking = await pool.query(
      `INSERT INTO bookings(team_id, guest_name, guest_email, booking_date, booking_time, slot_start, slot_end, meet_link, status, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',NOW()) RETURNING *`,
      [request.team_id, request.guest_name, request.guest_google_email, startDate.toISOString().split('T')[0],
       startDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }), startTime, endTime, meetLink]
    ).then(r => r.rows[0]);

    await pool.query(`UPDATE availability_requests SET status='booked', booking_id=$1 WHERE id=$2`, [booking.id, request.id]);

    res.status(201).json({ success: true, booking: { id: booking.id, date: booking.booking_date, time: booking.booking_time, meetLink }, message: 'Booked!' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Booking failed' });
  }
});

// Check Google status
app.get('/api/availability-requests/:token/google-status', async (req, res) => {
  try {
    const { token } = req.params;
    const request = await pool.query(
      `SELECT ar.guest_google_access_token, u.google_access_token as owner_connected
       FROM availability_requests ar
       JOIN teams t ON ar.team_id = t.id
       JOIN users u ON t.owner_id = u.id
       WHERE ar.token = $1`,
      [token]
    ).then(r => r.rows[0]);

    res.json({
      guestConnected: !!request?.guest_google_access_token,
      ownerConnected: !!request?.owner_connected,
      bothConnected: !!(request?.guest_google_access_token && request?.owner_connected)
    });
  } catch {
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// ADD HELPER FUNCTIONS before calculateOverlap():

function findFreeSlots(startDate, endDate, busyTimes, durationMinutes) {
  const freeSlots = [];
  let currentTime = new Date(startDate);
  const workStart = 9, workEnd = 17;

  const sortedBusy = busyTimes.map(b => ({ start: new Date(b.start), end: new Date(b.end) })).sort((a, b) => a.start - b.start);

  while (currentTime < endDate) {
    const currentHour = currentTime.getUTCHours();
    const dayOfWeek = currentTime.getUTCDay();

    if (dayOfWeek === 0 || dayOfWeek === 6) {
      currentTime.setUTCDate(currentTime.getUTCDate() + 1);
      currentTime.setUTCHours(workStart, 0, 0, 0);
      continue;
    }

    if (currentHour < workStart) {
      currentTime.setUTCHours(workStart, 0, 0, 0);
      continue;
    }
    if (currentHour >= workEnd) {
      currentTime.setUTCDate(currentTime.getUTCDate() + 1);
      currentTime.setUTCHours(workStart, 0, 0, 0);
      continue;
    }

    const slotEnd = new Date(currentTime.getTime() + durationMinutes * 60000);

    if (slotEnd.getUTCHours() > workEnd) {
      currentTime.setUTCDate(currentTime.getUTCDate() + 1);
      currentTime.setUTCHours(workStart, 0, 0, 0);
      continue;
    }

    const isBusy = sortedBusy.some(busy => 
      (currentTime >= busy.start && currentTime < busy.end) ||
      (slotEnd > busy.start && slotEnd <= busy.end) ||
      (currentTime <= busy.start && slotEnd >= busy.end)
    );

    if (!isBusy) {
      freeSlots.push({ start: new Date(currentTime), end: new Date(slotEnd), duration: durationMinutes });
    }

    currentTime = new Date(currentTime.getTime() + 30 * 60000);
  }

  return freeSlots;
}

function formatTimeSlot(slot) {
  const formatTime = (date) => {
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  };

  const formatDate = (date) => {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()}`;
  };

  return {
    date: formatDate(slot.start),
    time: formatTime(slot.start),
    endTime: formatTime(slot.end),
    startISO: slot.start.toISOString(),
    endISO: slot.end.toISOString(),
    duration: slot.duration
  };
}

// FIX line 575:
app.get('/availability-request/:token', (_req,res)=>{
  res.sendFile(path.join(__dirname,'public','availability-request-guest.html')); // FIXED filename
});