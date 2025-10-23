// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');

/* ------------------------------ Email Service ------------------------------ */
let emailService = null;
try {
  emailService = require('./email-service');
  console.log('✅ Email service loaded');
} catch {
  console.log('ℹ️ No email service file found — using safe stubs.');
  // --- prevent "sendTeamWelcome is not a function" error ---
  emailService = {
    sendTeamInvitation: async (...args) => console.log('📧 (stub) sendTeamInvitation', args),
    sendTeamWelcome: async (...args) => console.log('📧 (stub) sendTeamWelcome', args),
    sendBookingConfirmation: async (...args) => console.log('📧 (stub) sendBookingConfirmation', args),
    sendBookingNotificationToOwner: async (...args) => console.log('📧 (stub) sendBookingNotificationToOwner', args),
  };
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.set('trust proxy', 1);

/* ------------------------------- Config Vars ------------------------------- */
const clean = (v) => (v || '').trim();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = clean(process.env.JWT_SECRET) || 'schedulesync-secret-2025';

// Google OAuth
const GOOGLE_CLIENT_ID = clean(process.env.GOOGLE_CLIENT_ID);
const GOOGLE_CLIENT_SECRET = clean(process.env.GOOGLE_CLIENT_SECRET);
const GOOGLE_CALLBACK_URL = clean(process.env.GOOGLE_CALLBACK_URL);

// Microsoft OAuth
const MICROSOFT_CLIENT_ID = clean(process.env.MICROSOFT_CLIENT_ID);
const MICROSOFT_CLIENT_SECRET = clean(process.env.MICROSOFT_CLIENT_SECRET);
const MICROSOFT_CALLBACK_URL = clean(process.env.MICROSOFT_CALLBACK_URL);

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

/* ----------------------------- Environment Log ----------------------------- */
console.log('🚀 ScheduleSync API Starting...');
console.log(`📡 Port: ${PORT}`);
console.log('\n📋 Environment Variables Check:');
console.log(`  GOOGLE_CLIENT_ID:        ${GOOGLE_CLIENT_ID ? '✅ Found' : '❌ Missing'}`);
console.log(`  GOOGLE_CLIENT_SECRET:    ${GOOGLE_CLIENT_SECRET ? '✅ Found' : '❌ Missing'}`);
console.log(`  GOOGLE_CALLBACK_URL:     ${GOOGLE_CALLBACK_URL ? '✅ Found' : '❌ Missing'}`);
console.log(`  MICROSOFT_CLIENT_ID:     ${MICROSOFT_CLIENT_ID ? '✅ Found' : '❌ Missing'}`);
console.log(`  MICROSOFT_CLIENT_SECRET: ${MICROSOFT_CLIENT_SECRET ? '✅ Found' : '❌ Missing'}`);
console.log(`  MICROSOFT_CALLBACK_URL:  ${MICROSOFT_CALLBACK_URL ? '✅ Found' : '❌ Missing'}`);
console.log();

/* ------------------------------ DB Bootstrap ------------------------------ */
let dbReady = false;
(async () => {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');
    await initDatabase();
    dbReady = true;
    console.log('✅ Database schema ready');
    await ensureTestUser();
  } catch (err) {
    console.error('❌ Database init error:', err.message);
  }
})();

async function initDatabase() {
  console.log('🔧 Checking tables...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      owner_id INTEGER REFERENCES users(id),
      public_url VARCHAR(255) UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(50) DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(team_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS time_slots (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slot_start TIMESTAMP NOT NULL,
      slot_end TIMESTAMP NOT NULL,
      is_available BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      slot_id INTEGER REFERENCES time_slots(id) ON DELETE SET NULL,
      guest_name VARCHAR(255) NOT NULL,
      guest_email VARCHAR(255) NOT NULL,
      guest_notes TEXT,
      booking_date DATE,
      booking_time VARCHAR(50),
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_connections (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      token_expiry TIMESTAMP,
      calendar_id VARCHAR(255),
      email VARCHAR(255),
      last_synced TIMESTAMP,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, provider)
    );
  `);

  // Ensure slot_id exists in case of older schema
  await pool.query(`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS slot_id INTEGER REFERENCES time_slots(id) ON DELETE CASCADE;
  `);
}

async function ensureTestUser() {
  const testEmail = 'test@example.com';
  const existing = await pool.query('SELECT id FROM users WHERE email=$1', [testEmail]);
  if (!existing.rowCount) {
    await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3)',
      ['Test User', testEmail, 'password123']
    );
    console.log('👤 Test user created: test@example.com / password123');
  }
}

/* -------------------------- Safe Email Wrapper ---------------------------- */
function safeEmailCall(fnName, ...args) {
  if (emailService && typeof emailService[fnName] === 'function') {
    return emailService[fnName](...args).catch(err =>
      console.error(`📧 ${fnName} failed:`, err.message)
    );
  } else {
    console.log(`📧 (stub) ${fnName} called`);
    return Promise.resolve();
  }
}

/* ----------------------------- Core Endpoints ----------------------------- */
// ... [Keep all your existing routes below unchanged, they’ll now work safely]
// Example usage fix:
//   replace `emailService.sendTeamWelcome(...)`
//   with `safeEmailCall('sendTeamWelcome', ...)`
//   wherever it appears in your code.

/* ------------------------------- Start Server ----------------------------- */
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on http://0.0.0.0:${PORT}`);
  console.log('✅ ScheduleSync API Running\n');
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function shutdown(sig) {
  console.log(`${sig} received. Shutting down...`);
  server.close(() => process.exit(0));
}
