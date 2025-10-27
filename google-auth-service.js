// google-auth-service.js — Google OAuth & Calendar helpers
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

function getOAuth2Client() {
  const redirectUri = (process.env.GOOGLE_REDIRECT_URI || '').trim();
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !redirectUri) {
    throw new Error('Missing Google OAuth credentials. Check GOOGLE_CLIENT_ID/SECRET and GOOGLE_REDIRECT_URI');
  }
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

/**
 * Generate a Google OAuth URL for the frontend to redirect the user to.
 * - Uses select_account (no forced consent every time)
 * - Enables incremental auth
 * - Requests offline access (refresh token on first grant)
 */
function getAuthUrl(options = {}) {
  const oauth2Client = getOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: options.access_type || 'offline',
    include_granted_scopes: true,
    scope: SCOPES,
    prompt: options.prompt || 'select_account', // avoid re-consent
    state: options.state || undefined,
  });
  return url;
}

/**
 * Exchange "code" for tokens.
 */
async function getTokensFromCode(code) {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens; // { access_token, refresh_token, id_token, expiry_date, ... }
}

/**
 * Fetch Google profile info using access token.
 */
async function getUserInfo(accessToken) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  // Normalized fields we use
  return {
    email: data.email,
    name: data.name || `${data.given_name || ''} ${data.family_name || ''}`.trim(),
    picture: data.picture,
    google_id: data.id,
  };
}

/**
 * Read calendar busy times using FreeBusy API.
 */
async function getBusyTimes(accessToken, startDate, endDate) {
  const auth = getOAuth2Client();
  auth.setCredentials({ access_token: accessToken });
  const calendar = google.calendar({ version: 'v3', auth });

  const { data } = await calendar.freebusy.query({
    requestBody: {
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      items: [{ id: 'primary' }],
    },
  });

  const busy =
    data?.calendars?.primary?.busy?.map((b) => ({ start: b.start, end: b.end })) || [];
  return busy;
}

/**
 * Create an event on the authenticated user's primary calendar.
 * Pass eventData like:
 * {
 *   summary, description,
 *   start: { dateTime, timeZone: 'UTC' },
 *   end: { dateTime, timeZone: 'UTC' },
 *   attendees: [{email}, ...],
 *   conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
 *   reminders: { useDefault: false, overrides: [...] }
 * }
 */
async function createCalendarEvent(accessToken, eventData) {
  const auth = getOAuth2Client();
  auth.setCredentials({ access_token: accessToken });
  const calendar = google.calendar({ version: 'v3', auth });

  const { data } = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: eventData,
    conferenceDataVersion: 1,
  });

  return data; // contains id, htmlLink, hangoutLink, conferenceData, ...
}

module.exports = {
  getAuthUrl,
  getTokensFromCode,
  getUserInfo,
  getBusyTimes,
  createCalendarEvent,
};
