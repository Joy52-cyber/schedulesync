// ==================== 2-WAY AVAILABILITY API ENDPOINTS ====================
// Add these to server.js after the existing booking endpoints

const crypto = require('crypto');

// ============================================================================
// 1. CREATE AVAILABILITY REQUEST (Owner generates link for guest)
// ============================================================================
app.post('/api/availability-requests', authenticateToken, async (req, res) => {
  try {
    const { team_id, guest_name, guest_email, guest_notes } = req.body;
    
    console.log('📬 Creating availability request for team:', team_id);
    
    // Verify team ownership
    const teamResult = await pool.query(
      'SELECT * FROM teams WHERE id = $1 AND owner_id = $2',
      [team_id, req.userId]
    );
    
    if (teamResult.rows.length === 0) {
      return res.status(403).json({ error: 'Team not found or access denied' });
    }
    
    const team = teamResult.rows[0];
    
    // Generate unique token
    const token = crypto.randomBytes(32).toString('hex');
    
    // Create request
    const result = await pool.query(
      `INSERT INTO availability_requests 
       (team_id, guest_name, guest_email, guest_notes, token) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [team_id, guest_name, guest_email, guest_notes || '', token]
    );
    
    const request = result.rows[0];
    const bookingUrl = `${req.protocol}://${req.get('host')}/availability-request/${token}`;
    
    console.log('✅ Availability request created:', request.id);
    console.log('🔗 Booking URL:', bookingUrl);
    
    // Send email to guest (if email service available)
    if (emailService) {
      emailService.sendAvailabilityRequestEmail(guest_email, guest_name, team.name, bookingUrl)
        .catch(err => console.error('Email error:', err));
    }
    
    res.status(201).json({
      success: true,
      request: request,
      url: bookingUrl
    });
  } catch (error) {
    console.error('❌ Error creating availability request:', error);
    res.status(500).json({ error: 'Failed to create availability request' });
  }
});

// ============================================================================
// 2. GET AVAILABILITY REQUEST (Guest views - public, no auth)
// ============================================================================
app.get('/api/availability-requests/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    console.log('🔍 Looking up availability request:', token);
    
    // Get request with team info
    const result = await pool.query(
      `SELECT ar.*, t.name as team_name, t.description as team_description,
              u.name as owner_name
       FROM availability_requests ar
       JOIN teams t ON ar.team_id = t.id
       JOIN users u ON t.owner_id = u.id
       WHERE ar.token = $1 AND ar.status != 'expired'`,
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Availability request not found or expired' });
    }
    
    const request = result.rows[0];
    
    // Check if expired
    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      await pool.query(
        'UPDATE availability_requests SET status = $1 WHERE id = $2',
        ['expired', request.id]
      );
      return res.status(410).json({ error: 'This availability request has expired' });
    }
    
    // Get owner's availability
    const teamResult = await pool.query('SELECT owner_id FROM teams WHERE id = $1', [request.team_id]);
    const ownerId = teamResult.rows[0].owner_id;
    
    const availabilityResult = await pool.query(
      'SELECT * FROM time_slots WHERE user_id = $1 ORDER BY day_of_week, start_time',
      [ownerId]
    );
    
    console.log('✅ Found availability request:', request.id);
    
    res.json({
      request: {
        id: request.id,
        team_name: request.team_name,
        team_description: request.team_description,
        owner_name: request.owner_name,
        guest_name: request.guest_name,
        status: request.status,
        created_at: request.created_at,
        expires_at: request.expires_at
      },
      owner_availability: availabilityResult.rows
    });
  } catch (error) {
    console.error('❌ Error fetching availability request:', error);
    res.status(500).json({ error: 'Failed to fetch availability request' });
  }
});

// ============================================================================
// 3. SUBMIT GUEST AVAILABILITY (Guest submits their availability)
// ============================================================================
app.post('/api/availability-requests/:token/submit', async (req, res) => {
  try {
    const { token } = req.params;
    const { slots } = req.body;
    
    console.log('📝 Guest submitting availability for token:', token);
    console.log('📅 Slots received:', slots.length);
    
    // Get request
    const requestResult = await pool.query(
      'SELECT * FROM availability_requests WHERE token = $1',
      [token]
    );
    
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Availability request not found' });
    }
    
    const request = requestResult.rows[0];
    
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Availability already submitted' });
    }
    
    // Delete any existing slots (in case of resubmission)
    await pool.query('DELETE FROM guest_availability_slots WHERE request_id = $1', [request.id]);
    
    // Insert new slots
    if (slots && slots.length > 0) {
      const insertPromises = slots.map(slot =>
        pool.query(
          `INSERT INTO guest_availability_slots (request_id, day_of_week, start_time, end_time)
           VALUES ($1, $2, $3, $4)`,
          [request.id, slot.day_of_week, slot.start_time, slot.end_time]
        )
      );
      await Promise.all(insertPromises);
    }
    
    // Update request status
    await pool.query(
      'UPDATE availability_requests SET status = $1 WHERE id = $2',
      ['submitted', request.id]
    );
    
    console.log('✅ Guest availability submitted successfully');
    
    // Calculate overlap
    const overlap = await calculateOverlap(request.team_id, request.id);
    
    // Send email to owner (if email service available)
    if (emailService) {
      const teamResult = await pool.query(
        'SELECT t.*, u.email as owner_email FROM teams t JOIN users u ON t.owner_id = u.id WHERE t.id = $1',
        [request.team_id]
      );
      if (teamResult.rows.length > 0) {
        const team = teamResult.rows[0];
        emailService.sendAvailabilitySubmittedEmail(
          team.owner_email,
          request.guest_name,
          team.name,
          overlap.length
        ).catch(err => console.error('Email error:', err));
      }
    }
    
    res.json({
      success: true,
      message: 'Availability submitted successfully',
      overlap: overlap,
      overlap_count: overlap.length
    });
  } catch (error) {
    console.error('❌ Error submitting guest availability:', error);
    res.status(500).json({ error: 'Failed to submit availability' });
  }
});

// ============================================================================
// 4. GET OVERLAP (View times when both are available)
// ============================================================================
app.get('/api/availability-requests/:token/overlap', async (req, res) => {
  try {
    const { token } = req.params;
    
    console.log('🔍 Calculating overlap for token:', token);
    
    // Get request
    const requestResult = await pool.query(
      'SELECT * FROM availability_requests WHERE token = $1',
      [token]
    );
    
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Availability request not found' });
    }
    
    const request = requestResult.rows[0];
    
    if (request.status === 'pending') {
      return res.status(400).json({ error: 'Guest has not submitted availability yet' });
    }
    
    const overlap = await calculateOverlap(request.team_id, request.id);
    
    console.log('✅ Found', overlap.length, 'overlap slots');
    
    res.json({
      overlap: overlap,
      count: overlap.length
    });
  } catch (error) {
    console.error('❌ Error calculating overlap:', error);
    res.status(500).json({ error: 'Failed to calculate overlap' });
  }
});

// ============================================================================
// 5. FINALIZE BOOKING (Owner or guest books final time from overlap)
// ============================================================================
app.post('/api/availability-requests/:token/book', async (req, res) => {
  try {
    const { token } = req.params;
    const { date, time } = req.body;
    
    console.log('📅 Finalizing booking for token:', token);
    console.log('📅 Date:', date, 'Time:', time);
    
    // Get request
    const requestResult = await pool.query(
      'SELECT ar.*, t.owner_id FROM availability_requests ar JOIN teams t ON ar.team_id = t.id WHERE ar.token = $1',
      [token]
    );
    
    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'Availability request not found' });
    }
    
    const request = requestResult.rows[0];
    
    if (request.status !== 'submitted') {
      return res.status(400).json({ error: 'Cannot book: availability not submitted or already booked' });
    }
    
    // Verify the time is in the overlap
    const overlap = await calculateOverlap(request.team_id, request.id);
    const selectedSlot = overlap.find(slot => 
      slot.date === date && slot.time === time
    );
    
    if (!selectedSlot) {
      return res.status(400).json({ error: 'Selected time is not in the available overlap' });
    }
    
    // Create the booking (reuse existing booking logic)
    const ts = parseDateAndTimeToTimestamp(date, time);
    if (!ts) {
      return res.status(400).json({ error: 'Invalid date/time format' });
    }
    
    const bookingResult = await pool.query(
      `INSERT INTO bookings 
       (team_id, guest_name, guest_email, guest_notes, status, booking_date, booking_time, slot_start, slot_end)
       VALUES ($1, $2, $3, $4, 'confirmed', $5, $6, $7, $8)
       RETURNING *`,
      [
        request.team_id,
        request.guest_name,
        request.guest_email,
        request.guest_notes || '',
        date,
        time,
        ts.start,
        ts.end
      ]
    );
    
    const booking = bookingResult.rows[0];
    
    // Update availability request
    await pool.query(
      `UPDATE availability_requests 
       SET status = 'booked', booked_date = $1, booked_time = $2, booking_id = $3 
       WHERE id = $4`,
      [date, time, booking.id, request.id]
    );
    
    console.log('✅ Booking created:', booking.id);
    
    // Send confirmation emails
    if (emailService) {
      const teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [request.team_id]);
      if (teamResult.rows.length > 0) {
        const team = teamResult.rows[0];
        
        // Email to guest
        emailService.sendBookingConfirmation(booking, team)
          .catch(err => console.error('Email error:', err));
        
        // Email to owner
        const ownerResult = await pool.query('SELECT email FROM users WHERE id = $1', [request.owner_id]);
        if (ownerResult.rows.length > 0) {
          emailService.sendBookingNotificationToOwner(booking, team, ownerResult.rows[0].email)
            .catch(err => console.error('Email error:', err));
        }
      }
    }
    
    res.status(201).json({
      success: true,
      booking: booking,
      message: 'Booking confirmed successfully'
    });
  } catch (error) {
    console.error('❌ Error finalizing booking:', error);
    res.status(500).json({ error: 'Failed to finalize booking' });
  }
});

// ============================================================================
// HELPER FUNCTION: Calculate Overlap
// ============================================================================
async function calculateOverlap(teamId, requestId) {
  try {
    // Get owner's availability
    const teamResult = await pool.query('SELECT owner_id FROM teams WHERE id = $1', [teamId]);
    const ownerId = teamResult.rows[0].owner_id;
    
    const ownerAvailability = await pool.query(
      'SELECT * FROM time_slots WHERE user_id = $1',
      [ownerId]
    );
    
    // Get guest's availability
    const guestAvailability = await pool.query(
      'SELECT * FROM guest_availability_slots WHERE request_id = $1',
      [requestId]
    );
    
    const overlap = [];
    
    // For each day, find overlapping time ranges
    for (let day = 1; day <= 7; day++) {
      const ownerSlots = ownerAvailability.rows.filter(s => s.day_of_week === day);
      const guestSlots = guestAvailability.rows.filter(s => s.day_of_week === day);
      
      if (ownerSlots.length === 0 || guestSlots.length === 0) continue;
      
      // For simplicity, take the first slot of each (can be enhanced for multiple slots per day)
      const ownerSlot = ownerSlots[0];
      const guestSlot = guestSlots[0];
      
      // Convert times to minutes for comparison
      const ownerStart = timeToMinutes(ownerSlot.start_time);
      const ownerEnd = timeToMinutes(ownerSlot.end_time);
      const guestStart = timeToMinutes(guestSlot.start_time);
      const guestEnd = timeToMinutes(guestSlot.end_time);
      
      // Find overlap
      const overlapStart = Math.max(ownerStart, guestStart);
      const overlapEnd = Math.min(ownerEnd, guestEnd);
      
      if (overlapStart < overlapEnd) {
        // Generate 1-hour slots in the overlap
        const dayName = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][day];
        
        for (let minutes = overlapStart; minutes + 60 <= overlapEnd; minutes += 60) {
          const hour = Math.floor(minutes / 60);
          const min = minutes % 60;
          const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
          
          // Get next occurrence of this day
          const nextDate = getNextDateForDay(day);
          
          overlap.push({
            day_of_week: day,
            day_name: dayName,
            date: nextDate,
            time: timeStr,
            time_display: formatTime12Hour(timeStr)
          });
        }
      }
    }
    
    return overlap;
  } catch (error) {
    console.error('Error calculating overlap:', error);
    return [];
  }
}

// Helper: Convert time string to minutes
function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

// Helper: Get next occurrence of a day of week
function getNextDateForDay(dayOfWeek) {
  const today = new Date();
  const currentDay = today.getDay(); // 0-6
  const targetDay = dayOfWeek === 7 ? 0 : dayOfWeek; // Convert 7 (Sunday) to 0
  
  let daysUntilTarget = targetDay - currentDay;
  if (daysUntilTarget <= 0) {
    daysUntilTarget += 7; // Next week
  }
  
  const targetDate = new Date(today);
  targetDate.setDate(today.getDate() + daysUntilTarget);
  
  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, '0');
  const day = String(targetDate.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

// Helper: Format time to 12-hour
function formatTime12Hour(time24) {
  const [hour, minute] = time24.split(':');
  const hourNum = parseInt(hour);
  const hour12 = hourNum % 12 || 12;
  const period = hourNum >= 12 ? 'PM' : 'AM';
  return `${hour12}:${minute} ${period}`;
}

// ============================================================================
// 6. OWNER DASHBOARD: Get all availability requests
// ============================================================================
app.get('/api/availability-requests', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    
    const result = await pool.query(
      `SELECT ar.*, t.name as team_name
       FROM availability_requests ar
       JOIN teams t ON ar.team_id = t.id
       WHERE t.owner_id = $1
       ORDER BY ar.created_at DESC`,
      [userId]
    );
    
    res.json({ requests: result.rows });
  } catch (error) {
    console.error('Error fetching availability requests:', error);
    res.status(500).json({ error: 'Failed to fetch availability requests' });
  }
});