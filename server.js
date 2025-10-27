// server.js — clean API with Railway base links + availability flow
// -----------------------------------------------------------------------------

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

// 1) ADD IMPORTS (OAuth + calendar routes)
const googleOAuthRoutes = require('./google-oauth-routes');
const calendarBookingRoutes = require('./calendar-booking-routes');

// Optional services (loaded if present)
let emailService = null;
try { emailService = require('./email-service'); } catch {}

// Config ----------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const JWT_SECRET = (process.env.JWT_SECRET || 'schedulesync-secret-2025').trim();

// Force Railway domain for ALL public links in emails/buttons
const PUBLIC_BASE_URL =
  (process.env.APP_URL && process.env.APP_URL.replace(/\/+$/,'')) ||
  'https://schedulesync-production.up.railway.app';

// DB --------------------------------------------------------------------------
const connectionString = process.env.DB_CONNECTION_STRING || process.env.DATABASE_URL;
const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Utils -----------------------------------------------------------------------
function parseDateAndTimeToTimestamp(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const parts = String(timeStr).trim().split(/\s+/);
  let h, m;
  if (parts.length >= 2) {
    const [hm, ampmRaw] = parts;
    const [hRaw, mRaw = '0'] = hm.split(':');
    h = parseInt(hRaw, 10); m = parseInt(mRaw, 10);
    const ampm = (ampmRaw || '').toUpperCase();
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
  } else {
    const [hRaw, mRaw = '0'] = timeStr.split(':');
    h = parseInt(hRaw, 10); m = parseInt(mRaw, 10);
  }
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const start = new Date(`${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 60 * 60000);
  const fmt = (d) => {
    const y=d.getUTCFullYear(), mo=String(d.getUTCMonth()+1).padStart(2,'0'),
          da=String(d.getUTCDate()).padStart(2,'0'), hh=String(d.getUTCHours()).padStart(2,'0'),
          mm=String(d.getUTCMinutes()).padStart(2,'0'), ss=String(d.getUTCSeconds()).padStart(2,'0');
    return `${y}-${mo}-${da} ${hh}:${mm}:${ss}`;
  };
  return { start: fmt(start), end: fmt(end) };
}
function timeToMinutes(s){const [h,m]=String(s).split(':').map(Number);return h*60+m;}
function getNextDateForDay(dow){ // 1..7 (Mon..Sun)
  const today=new Date(), current=today.getDay(); // 0..6 Sun..Sat
  const target = (dow===7?0:dow);
  let delta = target - current; if (delta<=0) delta+=7;
  const t=new Date(today); t.setDate(today.getDate()+delta);
  return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
}
function formatTime12Hour(t){const [h,m]=t.split(':');const n=+h;const h12=n%12||12;return `${h12}:${m} ${n>=12?'PM':'AM'}`;}

// App -------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// -----------------------------------------------------------------------------
// ROOT + HEALTH ROUTES (for Railway + monitoring)
// -----------------------------------------------------------------------------
app.get('/', (_req, res) => res.status(200).send('OK')); // root for Railway health
app.get('/health', (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));
app.head('/health', (_req, res) => res.status(200).end());
app.get('/api/status', async (_req, res) => {
  try {
    const dbOk = await pool.query('SELECT 1').then(() => true).catch(() => false);
    res.status(200).json({
      status: 'ScheduleSync API Running',
      database: dbOk,
      baseUrl: PUBLIC_BASE_URL
    });
  } catch {
    res.status(500).json({ error: 'Healthcheck failed' });
  }
});


// 2) ATTACH DATABASE TO ALL REQUESTS (after express.json())
app.use((req, _res, next) => {
  req.db = pool;
  next();
});

// Health ----------------------------------------------------------------------
app.get('/health', (_req,res)=>res.json({ok:true}));
app.get('/api/status', async (_req,res)=>{
  const dbOk = await pool.query('SELECT 1').then(()=>true).catch(()=>false);
  res.json({ status:'ScheduleSync API Running', database:dbOk, baseUrl:PUBLIC_BASE_URL });
});

// DB bootstrap (idempotent) ---------------------------------------------------
async function initDatabase(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255),
      google_access_token TEXT,
      google_refresh_token TEXT,
      timezone VARCHAR(100) DEFAULT 'UTC',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams(
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      owner_id INTEGER REFERENCES users(id),
      public_url VARCHAR(255) UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_members(
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(50) DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(team_id,user_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS time_slots(
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      day_of_week INTEGER,
      start_time TIME,
      end_time TIME,
      is_available BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings(
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      slot_id INTEGER REFERENCES time_slots(id) ON DELETE SET NULL,
      guest_name VARCHAR(255) NOT NULL,
      guest_email VARCHAR(255) NOT NULL,
      guest_notes TEXT,
      booking_date DATE,
      booking_time VARCHAR(50),
      slot_start TIMESTAMP,
      slot_end TIMESTAMP,
      calendar_event_id VARCHAR(255),
      meet_link TEXT,
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS availability_requests(
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      guest_name VARCHAR(255) NOT NULL,
      guest_email VARCHAR(255) NOT NULL,
      guest_notes TEXT,
      token VARCHAR(255) UNIQUE NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      booked_date DATE,
      booked_time VARCHAR(50),
      booking_id INTEGER REFERENCES bookings(id),
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      guest_google_access_token TEXT,
      guest_google_refresh_token TEXT,
      guest_google_email VARCHAR(255)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guest_availability_slots(
      id SERIAL PRIMARY KEY,
      request_id INTEGER REFERENCES availability_requests(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL
    )`);
}
initDatabase().catch(err=>console.error('DB init error:',err.message));

// Auth ------------------------------------------------------------------------
function authenticateToken(req,res,next){
  const token = req.headers.authorization?.replace('Bearer ', '');
  if(!token) return res.status(401).json({error:'No token provided'});
  try{
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  }catch{
    return res.status(401).json({error:'Invalid token'});
  }
}

app.post('/api/auth/signup', async (req,res)=>{
  try{
    const {name,email,password}=req.body||{};
    if(!name||!email||!password) return res.status(400).json({error:'Missing fields'});
    const hashed=await bcrypt.hash(password,10);
    const out=await pool.query(
      'INSERT INTO users(name,email,password) VALUES($1,$2,$3) RETURNING id,name,email',
      [name,email,hashed]
    );
    const token=jwt.sign({userId:out.rows[0].id},JWT_SECRET,{expiresIn:'7d'});
    res.status(201).json({success:true,token,user:out.rows[0]});
  }catch(e){
    if(e.code==='23505') return res.status(409).json({error:'Email already exists'});
    res.status(500).json({error:'Signup failed'});
  }
});

app.post('/api/auth/login', async (req,res)=>{
  try{
    const {email,password}=req.body||{};
    if(!email||!password) return res.status(400).json({error:'Email and password are required'});
    const out=await pool.query('SELECT id,name,email,password FROM users WHERE email=$1',[email]);
    if(!out.rowCount) return res.status(401).json({error:'No account found'});
    const u=out.rows[0];
    const ok = u.password?.startsWith('$2b$') ? await bcrypt.compare(password,u.password) : (u.password===password);
    if(!ok) return res.status(401).json({error:'Incorrect password'});
    if(!u.password?.startsWith('$2b$')) {
      const hashed=await bcrypt.hash(password,10);
      await pool.query('UPDATE users SET password=$1 WHERE id=$2',[hashed,u.id]);
    }
    const token=jwt.sign({userId:u.id},JWT_SECRET,{expiresIn:'7d'});
    res.json({success:true,token,user:{id:u.id,name:u.name,email:u.email}});
  }catch{
    res.status(500).json({error:'Login failed'});
  }
});

app.get('/api/users/me', authenticateToken, async (req,res)=>{
  const out=await pool.query('SELECT id,name,email FROM users WHERE id=$1',[req.userId]);
  if(!out.rowCount) return res.status(404).json({error:'User not found'});
  res.json({user:out.rows[0]});
});

// Teams & Members -------------------------------------------------------------
app.post('/api/teams', authenticateToken, async (req,res)=>{
  try{
    const {name,description=''}=req.body||{};
    const team=await pool.query(
      `INSERT INTO teams(name,description,owner_id,public_url)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [name,description,req.userId,Math.random().toString(36).slice(2)]
    ).then(r=>r.rows[0]);

    // ensure owner is in team_members
    await pool.query(
      `INSERT INTO team_members(team_id,user_id,role)
       VALUES($1,$2,'owner') ON CONFLICT DO NOTHING`,
      [team.id, req.userId]
    );

    res.status(201).json({team});
  }catch{
    res.status(500).json({error:'Failed to create team'});
  }
});

app.get('/api/teams', authenticateToken, async (req,res)=>{
  try{
    const {rows}=await pool.query(`
      SELECT t.*, u.name as owner_name, u.email as owner_email,
             CASE WHEN t.owner_id=$1 THEN true ELSE false END as is_owner,
             COALESCE((
               SELECT role FROM team_members tm
               WHERE tm.team_id=t.id AND tm.user_id=$1 LIMIT 1
             ), CASE WHEN t.owner_id=$1 THEN 'owner' ELSE NULL END) as my_role
      FROM teams t JOIN users u ON u.id=t.owner_id
      WHERE t.owner_id=$1
         OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=t.id AND tm.user_id=$1)
      ORDER BY is_owner DESC, t.created_at DESC
    `,[req.userId]);
    res.json({teams:rows});
  }catch(e){
    res.status(500).json({error:'Failed to list teams'});
  }
});

app.get('/api/teams/:id/members', authenticateToken, async (req,res)=>{
  try{
    const {id}=req.params;
    const allowed = await pool.query(
      `SELECT 1 FROM teams t
       WHERE t.id=$1 AND (t.owner_id=$2 OR EXISTS(
         SELECT 1 FROM team_members tm WHERE tm.team_id=t.id AND tm.user_id=$2
       ))`,[id,req.userId]
    );
    if(!allowed.rowCount) return res.status(403).json({error:'Access denied'});

    const owner = await pool.query(
      `SELECT u.id,u.name,u.email,'owner' as role
       FROM teams t JOIN users u ON u.id=t.owner_id WHERE t.id=$1`,[id]);

    const members = await pool.query(
      `SELECT u.id,u.name,u.email,tm.role
       FROM team_members tm JOIN users u ON u.id=tm.user_id
       WHERE tm.team_id=$1 ORDER BY u.name ASC`,[id]);

    const map=new Map();
    [...owner.rows, ...members.rows].forEach(m=>map.set(m.id,m));
    res.json({members:[...map.values()], owner_id: owner.rows[0]?.id || null});
  }catch{
    res.status(500).json({error:'Failed to list members'});
  }
});

// Owner availability
app.post('/api/teams/:id/availability', authenticateToken, async (req,res)=>{
  try{
    const {id}=req.params; const {slots=[]}=req.body||{};
    await pool.query('DELETE FROM time_slots WHERE team_id=$1 AND user_id=$2',[id,req.userId]);
    for(const s of slots){
      await pool.query(
        `INSERT INTO time_slots(team_id,user_id,day_of_week,start_time,end_time,is_available)
         VALUES($1,$2,$3,$4,$5,true)`,
        [id,req.userId,s.day_of_week,s.start_time,s.end_time]
      );
    }
    res.json({success:true});
  }catch{
    res.status(500).json({error:'Failed to save availability'});
  }
});

app.get('/api/teams/:id/availability', authenticateToken, async (req,res)=>{
  try{
    const {id}=req.params;
    const rows = await pool
      .query('SELECT * FROM time_slots WHERE team_id=$1 AND user_id=$2 ORDER BY day_of_week,start_time',[id,req.userId])
      .then(r=>r.rows);
    res.json({slots:rows});
  }catch{
    res.status(500).json({error:'Failed to fetch availability'});
  }
});

// Availability Requests -------------------------------------------------------
app.post('/api/availability-requests', authenticateToken, async (req,res)=>{
  try{
    const {team_id, guest_name, guest_email, guest_notes=''} = req.body || {};
    const team = await pool.query('SELECT * FROM teams WHERE id=$1 AND owner_id=$2',[team_id,req.userId]).then(r=>r.rows[0]);
    if(!team) return res.status(403).json({error:'Team not found or access denied'});

    const token=crypto.randomBytes(32).toString('hex');
    const created = await pool.query(
      `INSERT INTO availability_requests(team_id,guest_name,guest_email,guest_notes,token)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [team_id, guest_name, guest_email, guest_notes, token]
    ).then(r=>r.rows[0]);

    const url = `${PUBLIC_BASE_URL}/availability-request/${token}`;
    emailService?.sendAvailabilityRequest?.(guest_email, guest_name, team.name, url)
      .catch(e=>console.error('Email error:', e?.message||e));

    res.status(201).json({success:true, request:created, url});
  }catch(e){
    res.status(500).json({error:'Failed to create availability request'});
  }
});

// Back-compat: old “Send Request” button payload
app.post('/api/booking-request/create', authenticateToken, async (req,res)=>{
  try{
    const { team_id, guest_name, guest_email, guest_notes, recipients } = req.body || {};
    const team = await pool.query('SELECT * FROM teams WHERE id=$1 AND owner_id=$2',[team_id,req.userId]).then(r=>r.rows[0]);
    if(!team) return res.status(403).json({error:'Team not found or access denied'});

    const list = Array.isArray(recipients)&&recipients.length
      ? recipients
      : [{name:guest_name, email:guest_email, notes:guest_notes}];

    const out=[];
    for(const r of list){
      if(!r?.email) continue;
      const token=crypto.randomBytes(32).toString('hex');
      const created = await pool.query(
        `INSERT INTO availability_requests(team_id,guest_name,guest_email,guest_notes,token)
         VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [team_id, r.name||'', r.email, r.notes||'', token]
      ).then(q=>q.rows[0]);

      const url = `${PUBLIC_BASE_URL}/availability-request/${token}`;
      emailService?.sendAvailabilityRequest?.(r.email, r.name||'', team.name, url)
        .catch(e=>console.error('Email error:', e?.message||e));

      out.push({ id: created.id, token, url, guest_email: r.email, guest_name: r.name||'' });
    }

    res.json({ success:true, requests_created: out.length, requests: out });
  }catch(e){
    res.status(500).json({error:'Failed to create booking request'});
  }
});

// Public: fetch availability request (for guest page)
app.get('/api/availability-requests/:token', async (req,res)=>{
  try{
    const {token}=req.params;
    const request = await pool.query(
      `SELECT ar.*, t.name as team_name, t.description as team_description, u.name as owner_name
       FROM availability_requests ar
       JOIN teams t ON ar.team_id=t.id
       JOIN users u ON t.owner_id=u.id
       WHERE ar.token=$1 AND ar.status!='expired'`,[token]
    ).then(r=>r.rows[0]);
    if(!request) return res.status(404).json({error:'Availability request not found or expired'});

    if(request.expires_at && new Date(request.expires_at) < new Date()){
      await pool.query('UPDATE availability_requests SET status=$1 WHERE id=$2',['expired',request.id]);
      return res.status(410).json({error:'This availability request has expired'});
    }

    const ownerId = await pool.query('SELECT owner_id FROM teams WHERE id=$1',[request.team_id]).then(r=>r.rows[0].owner_id);
    const ownerSlots = await pool.query(
      'SELECT * FROM time_slots WHERE user_id=$1 ORDER BY day_of_week,start_time',[ownerId]
    ).then(r=>r.rows);

    res.json({
      request: {
        id: request.id,
        team_name: request.team_name,
        team_description: request.team_description,
        owner_name: request.owner_name,
        guest_name: request.guest_name,
        status: request.status,
        created_at: request.created_at,
        expires_at: request.expires_at,
      },
      owner_availability: ownerSlots
    });
  }catch{
    res.status(500).json({error:'Failed to fetch availability request'});
  }
});

// Guest submits availability
app.post('/api/availability-requests/:token/submit', async (req,res)=>{
  try{
    const {token}=req.params; const {slots=[]}=req.body||{};
    const request = await pool.query('SELECT * FROM availability_requests WHERE token=$1',[token]).then(r=>r.rows[0]);
    if(!request) return res.status(404).json({error:'Availability request not found'});
    if(request.status!=='pending') return res.status(400).json({error:'Availability already submitted'});

    await pool.query('DELETE FROM guest_availability_slots WHERE request_id=$1',[request.id]);
    for(const s of slots){
      await pool.query(
        `INSERT INTO guest_availability_slots(request_id,day_of_week,start_time,end_time)
         VALUES($1,$2,$3,$4)`,
        [request.id, s.day_of_week, s.start_time, s.end_time]
      );
    }
    await pool.query('UPDATE availability_requests SET status=$1 WHERE id=$2',['submitted',request.id]);

    const overlap = await calculateOverlap(request.team_id, request.id);
    // Notify owner (best-effort)
    try{
      const team = await pool.query(
        'SELECT t.*, u.email as owner_email, u.name as owner_name FROM teams t JOIN users u ON t.owner_id=u.id WHERE t.id=$1',
        [request.team_id]
      ).then(r=>r.rows[0]);
      emailService?.sendAvailabilitySubmitted?.(team.owner_email, team.owner_name, request.guest_name, overlap.length)
        .catch(()=>{});
    }catch{}

    res.json({success:true, message:'Availability submitted', overlap, overlap_count: overlap.length});
  }catch{
    res.status(500).json({error:'Failed to submit availability'});
  }
});

// Calculate overlap
app.get('/api/availability-requests/:token/overlap', async (req,res)=>{
  try{
    const {token}=req.params;
    const request = await pool.query('SELECT * FROM availability_requests WHERE token=$1',[token]).then(r=>r.rows[0]);
    if(!request) return res.status(404).json({error:'Availability request not found'});
    if(request.status==='pending') return res.status(400).json({error:'Guest has not submitted availability yet'});
    const overlap = await calculateOverlap(request.team_id, request.id);
    res.json({overlap, count:overlap.length});
  }catch{
    res.status(500).json({error:'Failed to calculate overlap'});
  }
});

// Finalize booking from overlap
app.post('/api/availability-requests/:token/book', async (req,res)=>{
  try{
    const {token}=req.params; const {date,time}=req.body||{};
    const request = await pool.query(
      'SELECT ar.*, t.owner_id FROM availability_requests ar JOIN teams t ON ar.team_id=t.id WHERE ar.token=$1',
      [token]
    ).then(r=>r.rows[0]);
    if(!request) return res.status(404).json({error:'Availability request not found'});
    if(request.status!=='submitted') return res.status(400).json({error:'Cannot book yet'});

    const overlap = await calculateOverlap(request.team_id, request.id);
    const selected = overlap.find(s=>s.date===date && s.time===time);
    if(!selected) return res.status(400).json({error:'Selected time is not in overlap'});

    const ts = parseDateAndTimeToTimestamp(date,time);
    if(!ts) return res.status(400).json({error:'Invalid date/time'});

    const booking = await pool.query(
      `INSERT INTO bookings(team_id,guest_name,guest_email,guest_notes,status,booking_date,booking_time,slot_start,slot_end)
       VALUES($1,$2,$3,$4,'confirmed',$5,$6,$7,$8) RETURNING *`,
      [request.team_id, request.guest_name, request.guest_email, request.guest_notes||'', date, time, ts.start, ts.end]
    ).then(r=>r.rows[0]);

    await pool.query(
      `UPDATE availability_requests SET status='booked', booked_date=$1, booked_time=$2, booking_id=$3 WHERE id=$4`,
      [date,time,booking.id,request.id]
    );

    // Notify
    try{
      const team = await pool.query('SELECT * FROM teams WHERE id=$1',[request.team_id]).then(r=>r.rows[0]);
      emailService?.sendBookingConfirmation?.(booking, team)?.catch(()=>{});
      const ownerEmail = await pool.query('SELECT email FROM users WHERE id=$1',[request.owner_id]).then(r=>r.rows[0]?.email);
      if(ownerEmail) emailService?.sendBookingNotificationToOwner?.(booking, team, ownerEmail)?.catch(()=>{});
    }catch{}

    res.status(201).json({success:true, booking, message:'Booking confirmed'});
  }catch{
    res.status(500).json({error:'Failed to finalize booking'});
  }
});

// 3) MOUNT ROUTES (place before the guest page route)
app.use('/api/auth', googleOAuthRoutes);   // Google OAuth routes
app.use('/api', calendarBookingRoutes);    // Calendar booking routes

// 6) Guest page route — switch to the CALENDAR version
app.get('/availability-request/:token', (_req,res)=>{
  res.sendFile(path.join(__dirname,'public','availability-request-guest-calendar.html'));
});

// Helpers ---------------------------------------------------------------------
async function calculateOverlap(teamId, requestId){
  try{
    const ownerId = await pool.query('SELECT owner_id FROM teams WHERE id=$1',[teamId]).then(r=>r.rows[0].owner_id);
    const ownerAvailability = await pool.query('SELECT * FROM time_slots WHERE user_id=$1',[ownerId]).then(r=>r.rows);
    const guestAvailability = await pool.query('SELECT * FROM guest_availability_slots WHERE request_id=$1',[requestId]).then(r=>r.rows);

    const out=[];
    for(let day=1; day<=7; day++){
      const ownerSlots = ownerAvailability.filter(s=>s.day_of_week===day);
      const guestSlots = guestAvailability.filter(s=>s.day_of_week===day);
      if(!ownerSlots.length || !guestSlots.length) continue;

      const o=ownerSlots[0], g=guestSlots[0];
      const s=Math.max(timeToMinutes(o.start_time), timeToMinutes(g.start_time));
      const e=Math.min(timeToMinutes(o.end_time), timeToMinutes(g.end_time));
      if(s<e){
        const dayName=['','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][day];
        for(let m=s; m+60<=e; m+=60){
          const hh=String(Math.floor(m/60)).padStart(2,'0');
          const mm=String(m%60).padStart(2,'0');
          const t=`${hh}:${mm}`;
          out.push({day_of_week:day, day_name:dayName, date:getNextDateForDay(day), time:t, time_display:formatTime12Hour(t)});
        }
      }
    }
    return out;
  }catch(e){ console.error('overlap error',e); return []; }
}

// 404 & server ---------------------------------------------------------------
app.use((_req,res)=>res.status(404).json({error:'Not found'}));

let server;
function shutdown(sig){
  console.log(`${sig} received. Shutting down...`);
  try{
    server?.close?.(()=>{ pool?.end?.().finally(()=>process.exit(0)); });
  }catch{ process.exit(0); }
}
server = app.listen(PORT,'0.0.0.0',()=>console.log(`✅ Server on :${PORT}`));
process.on('SIGINT', ()=>shutdown('SIGINT'));
process.on('SIGTERM',()=>shutdown('SIGTERM'));
