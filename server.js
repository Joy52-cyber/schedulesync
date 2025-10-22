// server.js
// ScheduleSync - lightweight server with static pages, mock API, and SMTP email

require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

/* -------------------- MIDDLEWARE -------------------- */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* -------------------- STATIC PAGES -------------------- */
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Redirect .htm -> .html if anyone hits old links
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith('.htm')) return res.redirect(301, req.path + 'l');
  next();
});

// Pretty page routes
app.get(['/', '/dashboard', '/dashboard.html'], (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'))
);
app.get(['/booking', '/booking.html', '/booking.htm'], (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'booking.html'))
);
app.get(['/team-management', '/team-management.html'], (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'team-management.html'))
);

/* -------------------- MOCK DATA -------------------- */
const db = {
  users: [], // { id, email, name }
  teams: [
    {
      id: 1,
      name: 'Sales Team',
      description: 'Inbound sales demos',
      scheduling_mode: 'round_robin',
      public_url: 'team-sales',
      member_count: 1,
    },
  ],
  members: [
    { id: 1, teamId: 1, email: 'demo@schedulesync.com', role: 'admin', name: 'Demo User' },
  ],
};
const nextId = (arr) => (arr.length ? Math.max(...arr.map((x) => x.id)) + 1 : 1);

/* -------------------- SMTP EMAIL SETUP -------------------- */
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || '';
const EMAIL_HOST = process.env.EMAIL_HOST || '';           // e.g. smtp.gmail.com
const EMAIL_PORT = Number(process.env.EMAIL_PORT || 587);  // 587 = STARTTLS
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'ScheduleSync';

let transporter = null;

if (EMAIL_USER && EMAIL_PASSWORD && EMAIL_HOST) {
  transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_PORT === 465,       // false for 587 (STARTTLS)
    auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
    pool: true,
    maxConnections: 3,
    connectionTimeout: 15000,
    greetingTimeout: 8000,
    socketTimeout: 20000,
    tls: {
      minVersion: 'TLSv1.2',
      servername: EMAIL_HOST,
      rejectUnauthorized: true,
    },
  });
} else {
  console.warn('⚠️  Email disabled: missing EMAIL_HOST/EMAIL_USER/EMAIL_PASSWORD env vars.');
}

/* -------------------- HEALTH -------------------- */
app.get('/health', async (req, res) => {
  let emailConfigured = !!transporter;
  let emailOk = null;

  if (transporter) {
    try {
      emailOk = await transporter.verify();
    } catch (e) {
      emailOk = false;
    }
  }

  res.json({
    status: 'ok',
    env: process.env.NODE_ENV || 'production',
    db: 'mock',
    emailConfigured,
    emailOk,
    time: new Date().toISOString(),
  });
});

/* -------------------- EMAIL DEBUG / TEST -------------------- */
app.get('/api/email/debug', async (req, res) => {
  if (!transporter) return res.status(503).json({ ok: false, reason: 'transporter_not_configured' });
  try {
    const ok = await transporter.verify();
    res.json({ ok, host: EMAIL_HOST, port: EMAIL_PORT });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/email/test', async (req, res) => {
  if (!transporter) return res.status(503).json({ ok: false, reason: 'transporter_not_configured' });
  const to = req.query.to;
  if (!to) return res.status(400).json({ ok: false, error: 'missing to' });
  try {
    const info = await transporter.sendMail({
      from: `${EMAIL_FROM_NAME} <${EMAIL_USER}>`,
      to,
      subject: 'ScheduleSync: SMTP test',
      text: 'SMTP test from ScheduleSync',
      html: '<p>SMTP test from <b>ScheduleSync</b></p>',
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/* -------------------- AUTH (MOCK) -------------------- */
app.post('/api/auth/register', (req, res) => {
  const { email, name } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });

  let user = db.users.find((u) => u.email === email);
  if (!user) {
    user = { id: nextId(db.users), email, name: name || email.split('@')[0] };
    db.users.push(user);
  }
  // mock token
  const token = Buffer.from(`${user.id}:${user.email}`).toString('base64');
  res.json({ token, user });
});

/* -------------------- TEAMS (MOCK) -------------------- */
app.get('/api/teams', (req, res) => {
  const teams = db.teams.map((t) => ({
    ...t,
    member_count: db.members.filter((m) => m.teamId === t.id).length,
  }));
  res.json({ teams });
});

app.get('/api/teams/:id', (req, res) => {
  const id = Number(req.params.id);
  const team = db.teams.find((t) => t.id === id);
  if (!team) return res.status(404).json({ error: 'not found' });
  const members = db.members.filter((m) => m.teamId === id);
  res.json({ team, members });
});

app.post('/api/teams', (req, res) => {
  const { name, schedulingMode, publicUrl } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const team = {
    id: nextId(db.teams),
    name,
    description: '',
    scheduling_mode: (schedulingMode || 'round_robin').toLowerCase(),
    public_url: publicUrl || name.toLowerCase().replace(/\s+/g, '-'),
    member_count: 0,
  };
  db.teams.push(team);
  res.status(201).json({ team });
});

app.put('/api/teams/:id', (req, res) => {
  const id = Number(req.params.id);
  const team = db.teams.find((t) => t.id === id);
  if (!team) return res.status(404).json({ error: 'not found' });
  const { name, description } = req.body || {};
  if (name) team.name = name;
  if (description !== undefined) team.description = description;
  res.json({ team });
});

app.get('/api/teams/:id/members', (req, res) => {
  const id = Number(req.params.id);
  const members = db.members.filter((m) => m.teamId === id);
  res.json({ members });
});

app.post('/api/teams/:id/members', async (req, res) => {
  const id = Number(req.params.id);
  const { userId, role = 'member' } = req.body || {};
  const team = db.teams.find((t) => t.id === id);
  if (!team) return res.status(404).json({ error: 'team not found' });

  const user = db.users.find((u) => u.id === Number(userId));
  if (!user) return res.status(400).json({ error: 'user not found' });

  const exists = db.members.find((m) => m.teamId === id && m.email === user.email);
  if (exists) return res.status(409).json({ error: 'already a member' });

  const member = { id: nextId(db.members), teamId: id, email: user.email, role, name: user.name };
  db.members.push(member);

  // fire-and-forget email invite (doesn't block API success)
  (async () => {
    if (!transporter) return;
    try {
      await transporter.sendMail({
        from: `${EMAIL_FROM_NAME} <${EMAIL_USER}>`,
        to: user.email,
        subject: `You've been added to ${team.name}`,
        html: `<p>Hello ${user.name || user.email},</p>
               <p>You've been added to the team <b>${team.name}</b> on ScheduleSync.</p>
               <p>Role: <b>${role}</b></p>`,
        text: `You've been added to ${team.name} as ${role}.`,
      });
      console.log(`✅ Invite sent to ${user.email}`);
    } catch (e) {
      console.error(`❌ Email error for ${user.email}: ${e.message}`);
    }
  })();

  res.status(201).json({ member });
});

app.put('/api/teams/:id/members/:memberId/role', (req, res) => {
  const id = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  const m = db.members.find((x) => x.teamId === id && x.id === memberId);
  if (!m) return res.status(404).json({ error: 'member not found' });
  m.role = (req.body?.role || m.role).toLowerCase();
  res.json({ member: m });
});

app.delete('/api/teams/:id/members/:memberId', (req, res) => {
  const id = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  const idx = db.members.findIndex((x) => x.teamId === id && x.id === memberId);
  if (idx === -1) return res.status(404).json({ error: 'member not found' });
  const [removed] = db.members.splice(idx, 1);
  res.json({ removed: { id: removed.id, email: removed.email } });
});

/* -------------------- START SERVER -------------------- */
app.listen(PORT, '0.0.0.0', async () => {
  console.log('');
  console.log('✅ ScheduleSync API Server Running');
  console.log(`📡 Listening on http://localhost:${PORT}`);
  console.log(`🌐 Public: https://schedulesync-production.up.railway.app`);
  if (transporter) {
    try {
      await transporter.verify();
      console.log(`✉️  Email transporter ready: ${EMAIL_HOST}:${EMAIL_PORT}`);
    } catch (e) {
      console.warn(`⚠️  Email verify failed: ${e.message}`);
    }
  } else {
    console.warn('✋ Email not configured; skipping SMTP verify.');
  }
  console.log('');
});

/* -------------------- GRACEFUL SHUTDOWN -------------------- */
process.on('SIGTERM', () => {
  console.log('🛑 Stopping Container');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('🛑 Interrupted');
  process.exit(0);
});
