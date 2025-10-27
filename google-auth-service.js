// google-auth-service.js - Google OAuth and Calendar API integration
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const axios = require('axios');

// Initialize OAuth2 client
const getOAuth2Client = () => {
 const redirectUri = (process.env.GOOGLE_REDIRECT_URI || '').trim();

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
function getAuthUrl(options = {}) {
  const oauth2Client = getOAuth2Client();
  
  const url = oauth2Client.generateAuthUrl({
    access_type: options.access_type || 'offline',
    scope: SCOPES,
    prompt: options.prompt || 'select_account', // Show account picker, but not consent screen if already granted
    state: options.state || undefined
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
 * Alias for backward compatibility
 */
async function getTokens(code) {
  return getTokensFromCode(code);
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

/* ============================================================================
   PHASE 2: CALENDAR INTEGRATION FUNCTIONS
   ========================================================================== */

/**
 * Get busy times from Google Calendar (for availability checking)
 */
async function getBusyTimes(accessToken, startDate, endDate) {
  try {
    const response = await axios.post(
      'https://www.googleapis.com/calendar/v3/freeBusy',
      {
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        items: [{ id: 'primary' }]
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const busyTimes = response.data.calendars.primary.busy || [];
    return busyTimes;

  } catch (error) {
    console.error('Error fetching busy times:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Create calendar event with Google Meet
 */
async function createCalendarEvent(accessToken, event) {
  try {
    const response = await axios.post(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
      event,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;

  } catch (error) {
    console.error('Error creating calendar event:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  getAuthUrl,
  getTokensFromCode,
  getTokens,  // Alias for backward compatibility
  getUserInfo,
  getCalendarList,
  refreshAccessToken,
  getBusyTimes,        // Phase 2
  createCalendarEvent  // Phase 2
};