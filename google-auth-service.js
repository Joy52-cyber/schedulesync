// google-auth-service.js - Google OAuth and Calendar API integration

const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

// Initialize OAuth2 client
const getOAuth2Client = () => {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || process.env.GOOGLE_CALLBACK_URL;
  
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !redirectUri) {
    throw new Error('Missing Google OAuth credentials. Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI environment variables.');
  }
  
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
};

// Scopes we need
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events'
];

/**
 * Generate Google OAuth URL
 */
function getAuthUrl() {
  const oauth2Client = getOAuth2Client();
  
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Force consent to get refresh token
  });
  
  return url;
}

/**
 * Exchange authorization code for tokens
 */
async function getTokensFromCode(code) {
  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    
    return tokens;
  } catch (error) {
    console.error('Error getting tokens:', error);
    throw error;
  }
}

/**
 * Get user info from Google
 */
async function getUserInfo(accessToken) {
  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ access_token: accessToken });
    
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    
    return {
      google_id: data.id,
      email: data.email,
      name: data.name,
      picture: data.picture
    };
  } catch (error) {
    console.error('Error getting user info:', error);
    throw error;
  }
}

/**
 * Get user's Google Calendars
 */
async function getCalendarList(accessToken, refreshToken) {
  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const { data } = await calendar.calendarList.list();
    
    return data.items.map(cal => ({
      id: cal.id,
      name: cal.summary,
      primary: cal.primary || false,
      timezone: cal.timeZone,
      backgroundColor: cal.backgroundColor,
      accessRole: cal.accessRole
    }));
  } catch (error) {
    console.error('Error fetching calendars:', error);
    throw error;
  }
}

/**
 * Get free/busy information for a calendar
 */
async function getFreeBusy(accessToken, refreshToken, calendarId, timeMin, timeMax) {
  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const { data } = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMin,
        timeMax: timeMax,
        items: [{ id: calendarId }]
      }
    });
    
    const busySlots = data.calendars[calendarId]?.busy || [];
    
    return busySlots.map(slot => ({
      start: slot.start,
      end: slot.end
    }));
  } catch (error) {
    console.error('Error fetching free/busy:', error);
    throw error;
  }
}

/**
 * Create a calendar event with Google Meet
 */
async function createCalendarEvent(accessToken, refreshToken, calendarId, eventDetails) {
  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    const event = {
      summary: eventDetails.title,
      description: eventDetails.description,
      start: {
        dateTime: eventDetails.startTime,
        timeZone: eventDetails.timeZone || 'UTC'
      },
      end: {
        dateTime: eventDetails.endTime,
        timeZone: eventDetails.timeZone || 'UTC'
      },
      attendees: eventDetails.attendees || [],
      conferenceData: {
        createRequest: {
          requestId: `meet-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 }, // 1 day before
          { method: 'popup', minutes: 30 } // 30 min before
        ]
      }
    };
    
    const { data } = await calendar.events.insert({
      calendarId: calendarId,
      requestBody: event,
      conferenceDataVersion: 1,
      sendUpdates: 'all' // Send email invites
    });
    
    return {
      eventId: data.id,
      htmlLink: data.htmlLink,
      meetLink: data.hangoutLink || data.conferenceData?.entryPoints?.[0]?.uri,
      icsLink: data.htmlLink.replace('event?eid=', 'event/ics/')
    };
  } catch (error) {
    console.error('Error creating calendar event:', error);
    throw error;
  }
}

/**
 * Update a calendar event
 */
async function updateCalendarEvent(accessToken, refreshToken, calendarId, eventId, updates) {
  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Get existing event
    const { data: existingEvent } = await calendar.events.get({
      calendarId: calendarId,
      eventId: eventId
    });
    
    // Merge updates
    const updatedEvent = {
      ...existingEvent,
      ...updates
    };
    
    const { data } = await calendar.events.update({
      calendarId: calendarId,
      eventId: eventId,
      requestBody: updatedEvent,
      sendUpdates: 'all'
    });
    
    return data;
  } catch (error) {
    console.error('Error updating calendar event:', error);
    throw error;
  }
}

/**
 * Cancel/Delete a calendar event
 */
async function cancelCalendarEvent(accessToken, refreshToken, calendarId, eventId) {
  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    await calendar.events.delete({
      calendarId: calendarId,
      eventId: eventId,
      sendUpdates: 'all'
    });
    
    return { success: true };
  } catch (error) {
    console.error('Error canceling calendar event:', error);
    throw error;
  }
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken(refreshToken) {
  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    
    const { credentials } = await oauth2Client.refreshAccessToken();
    
    return credentials.access_token;
  } catch (error) {
    console.error('Error refreshing token:', error);
    throw error;
  }
}

module.exports = {
  getAuthUrl,
  getTokensFromCode,
  getUserInfo,
  getCalendarList,
  getFreeBusy,
  createCalendarEvent,
  updateCalendarEvent,
  cancelCalendarEvent,
  refreshAccessToken
};