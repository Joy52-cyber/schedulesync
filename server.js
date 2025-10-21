// server.js — ScheduleSync (stable Railway build)

const express = require("express");
const cors = require("cors");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

/* --------------------------- Config & Middleware -------------------------- */
const PORT = Number(process.env.PORT) || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const NODE_ENV = process.env.NODE_ENV || "development";
const JWT_SECRET = process.env.JWT_SECRET || "schedulesync-dev-secret-2025";
const DISABLE_DB = process.env.DISABLE_DB === "1";
const DATABASE_URL = process.env.DATABASE_URL || "";
const USE_SSL = process.env.DATABASE_SSL === "true";

app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

/* -------------------------- Crash-safe global logs ------------------------ */
process.on("unhandledRejection", (r, p) => console.error("Unhandled:", r, "at:", p));
process.on("uncaughtException", (e) => console.error("Uncaught:", e));

/* -------------------------------- Database -------------------------------- */
let pool = null;
if (!DISABLE_DB && DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: USE_SSL ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
  pool.on("error", (e) => console.error("PG pool error:", e.message));
  pool
    .query("SELECT NOW()")
    .then(() => console.log("✅ DB test query OK"))
    .catch((e) => console.warn("⚠️ DB test query failed:", e.message));
} else {
  console.log("📦 DB disabled (DISABLE_DB=1) or DATABASE_URL missing");
}

/* ------------------------------- Small helpers ---------------------------- */
function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

async function q(sql, params = []) {
  if (!pool) throw new Error("Database disabled");
  return pool.query(sql, params);
}

/* --------------------------------- Static --------------------------------- */
app.use(express.static(path.join(__dirname)));

/* --------------------------------- Health --------------------------------- */
app.get("/", (_req, res) => {
  res.type("text/plain").send("ScheduleSync API is running. Try /health");
});

app.get("/health", async (_req, res) => {
  if (!pool) {
    return res.json({
      status: "ok",
      env: NODE_ENV,
      db: "disabled",
      time: new Date().toISOString(),
    });
  }
  try {
    const r = await q("SELECT 1 AS ok");
    res.json({
      status: "ok",
      env: NODE_ENV,
      db: r.rows[0].ok === 1 ? "connected" : "unknown",
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(503).json({
      status: "error",
      env: NODE_ENV,
      db: "disconnected",
      error: e.message,
      time: new Date().toISOString(),
    });
  }
});

/* ------------------------------- Auth / User ------------------------------ */
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, name, extensionId } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email is required" });
    const ex = pool ? await q("SELECT * FROM users WHERE email=$1", [email]) : { rows: [] };
    let user;
    if (ex.rows.length) {
      user = ex.rows[0];
      if (pool) await q("UPDATE users SET extension_id=$1 WHERE id=$2", [extensionId || null, user.id]);
    } else if (pool) {
      const ins = await q(
        "INSERT INTO users (email, name, extension_id) VALUES ($1,$2,$3) RETURNING *",
        [email, name || null, extensionId || null]
      );
      user = ins.rows[0];
    } else {
      user = { id: 1, email, name: name || null }; // DB disabled fallback
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    res.status(500).json({ error: "Registration failed: " + e.message });
  }
});

/* ------------------------------ Preferences ------------------------------- */
app.get("/api/availability", auth, async (req, res) => {
  try {
    let prefs = { work_start: 9, work_end: 17, slot_duration: 30, max_slots: 10, buffer_time: 0 };
    if (pool) {
      const r = await q("SELECT * FROM user_preferences WHERE user_id=$1", [req.userId]);
      if (r.rows[0]) prefs = r.rows[0];
    }
    const slots = generateSampleSlots(prefs);
    res.json({ freeSlots: slots, preferences: prefs, source: pool ? "database" : "mock" });
  } catch (e) {
    res.status(500).json({ error: "Failed to calculate availability: " + e.message });
  }
});

app.post("/api/preferences", auth, async (req, res) => {
  try {
    const { workStart, workEnd, slotDuration, maxSlots, bufferTime } = req.body || {};
    if (!pool) return res.json({ success: true, preferences: { workStart, workEnd, slotDuration, maxSlots, bufferTime } });
    const r = await q(
      `INSERT INTO user_preferences (user_id, work_start, work_end, slot_duration, max_slots, buffer_time)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id)
       DO UPDATE SET work_start=$2, work_end=$3, slot_duration=$4, max_slots=$5, buffer_time=$6
       RETURNING *`,
      [req.userId, workStart, workEnd, slotDuration, maxSlots, bufferTime || 0]
    );
    res.json({ success: true, preferences: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: "Failed to save preferences: " + e.message });
  }
});

/* --------------------------------- Teams ---------------------------------- */
app.post("/api/teams", auth, async (req, res) => {
  try {
    const { name, schedulingMode = "round_robin", publicUrl } = req.body || {};
    if (!["round_robin", "collective", "first_available"].includes(schedulingMode))
      return res.status(400).json({ error: "Invalid scheduling mode" });

    const url = publicUrl || `${name?.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
    if (!pool) return res.json({ success: true, team: { id: 1, name, public_url: url, scheduling_mode: schedulingMode } });

    const ins = await q(
      `INSERT INTO teams (name, created_by, public_url, scheduling_mode, is_active, created_at)
       VALUES ($1,$2,$3,$4,true,NOW()) RETURNING *`,
      [name, req.userId, url, schedulingMode]
    );
    const team = ins.rows[0];
    await q("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1,$2,$3,NOW())", [
      team.id,
      req.userId,
      "admin",
    ]);
    res.json({ success: true, team });
  } catch (e) {
    res.status(500).json({ error: "Failed to create team: " + e.message });
  }
});

app.get("/api/teams", auth, async (req, res) => {
  try {
    if (!pool) return res.json({ teams: [] });
    const r = await q(
      `SELECT t.*, tm.role,
        (SELECT COUNT(*) FROM team_members WHERE team_id=t.id) AS member_count
       FROM teams t
       JOIN team_members tm ON t.id=tm.team_id
       WHERE tm.user_id=$1
       ORDER BY t.created_at DESC`,
      [req.userId]
    );
    res.json({ teams: r.rows });
  } catch (e) {
    res.status(500).json({ error: "Failed to get teams: " + e.message });
  }
});

/* -------------------------------- Bookings -------------------------------- */
app.post("/api/booking/create", async (req, res) => {
  try {
    const { teamId, slotStart, slotEnd, guestEmail, guestName, meetingLink, description, notes } = req.body || {};
    if (!teamId || !slotStart || !slotEnd || !guestEmail || !guestName)
      return res.status(400).json({ error: "Missing required fields" });

    if (!pool) {
      return res.json({
        success: true,
        booking: {
          id: 1,
          status: "pending",
          confirmationToken: "mock-token",
          cancelUrl: `${APP_URL}/booking.html?cancel=mock-token`,
        },
      });
    }

    const conflict = await q(
      `SELECT id FROM bookings WHERE team_id=$1 AND status=$2 AND slot_start < $3 AND slot_end > $4`,
      [teamId, "confirmed", slotEnd, slotStart]
    );
    if (conflict.rows.length) return res.status(409).json({ error: "Slot is no longer available" });

    const token = jwt.sign({ type: "booking" }, JWT_SECRET, { expiresIn: "7d" });
    const ins = await q(
      `INSERT INTO bookings (
        team_id, assigned_member_id, slot_start, slot_end, guest_email, guest_name,
        meeting_link, description, notes, status, confirmation_token, created_at
      ) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, NOW())
      RETURNING *`,
      [teamId, slotStart, slotEnd, guestEmail, guestName, meetingLink || null, description || null, notes || null, token]
    );
    const b = ins.rows[0];
    res.json({
      success: true,
      booking: { id: b.id, status: "pending", confirmationToken: token, cancelUrl: `${APP_URL}/booking.html?cancel=${token}` },
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to create booking: " + e.message });
  }
});

/* -------------------------------- Analytics ------------------------------- */
app.get("/api/analytics/dashboard", async (_req, res) => {
  try {
    if (!pool) {
      return res.json({
        stats: { totalUsers: 1, totalBookings: 1, activeConnections: 0, cacheHitRate: 85 },
      });
    }
    const u = await q("SELECT COUNT(*)::int AS c FROM users");
    const b = await q("SELECT COUNT(*)::int AS c FROM bookings");
    const c = await q("SELECT COUNT(*)::int AS c FROM calendar_connections WHERE is_active=true");
    res.json({
      stats: {
        totalUsers: u.rows[0].c || 0,
        totalBookings: b.rows[0].c || 0,
        activeConnections: c.rows[0].c || 0,
        cacheHitRate: 85,
      },
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to load analytics: " + e.message });
  }
});

/* ------------------------------- Page routes ------------------------------- */
app.get("/dashboard", (_req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/team-management", (_req, res) => res.sendFile(path.join(__dirname, "team-management.html")));
app.get("/booking.html", (_req, res) => res.sendFile(path.join(__dirname, "booking.html")));

/* ---------------------------- Global error handler ------------------------- */
app.use((err, _req, res, _next) => {
  console.error("Global error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

/* --------------------------------- Start ---------------------------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Listening on 0.0.0.0:${PORT}`);
  console.log(`🌐 ${APP_URL}`);
});

/* ------------------------------ Util functions ----------------------------- */
function generateSampleSlots(p) {
  const workStart = p.work_start ?? 9;
  const workEnd = p.work_end ?? 17;
  const slotDuration = p.slot_duration ?? 30;
  const maxSlots = p.max_slots ?? 10;

  const slots = [];
  const now = new Date();
  const slotMs = slotDuration * 60 * 1000;
  let current = new Date(Math.ceil(now.getTime() / slotMs) * slotMs);
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  while (slots.length < maxSlots && current < horizon) {
    const h = current.getHours();
    const d = current.getDay();
    if (d >= 1 && d <= 5 && h >= workStart && h < workEnd) {
      const end = new Date(current.getTime() + slotMs);
      if (end.getHours() <= workEnd) {
        slots.push({ start: current.toISOString(), end: end.toISOString() });
      }
    }
    current = new Date(current.getTime() + slotMs);
  }
  return slots;
}
