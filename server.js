// server.js
// ScheduleSync – compact production-ready server with mock fallbacks

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");

const app = express();

/* -------------------------- middleware & static -------------------------- */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// Allow .htm links to work by redirecting to .html
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith(".htm")) {
    return res.redirect(301, req.path + "l");
  }
  next();
});

// UI routes
app.get(["/", "/dashboard", "/dashboard.html"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "dashboard.html"))
);
app.get(["/booking", "/booking.html", "/booking.htm"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "booking.html"))
);
app.get(["/team-management", "/team-management.html"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "team-management.html"))
);

/* --------------------------------- state -------------------------------- */
const isProd = (process.env.NODE_ENV || "").toLowerCase() === "production";

let pool = null;
let dbStatus = "mock"; // "connected" | "mock" | "error"

let emailConfigured = false;
let transporter = null;

/* ------------------------------- mock data ------------------------------- */
let seqTeam = 2;
let seqMember = 2;

const mock = {
  users: [{ id: 1, email: "demo@schedulesync.com", name: "Demo User" }],
  teams: [
    {
      id: 1,
      name: "Sales Team",
      public_url: "team-sales",
      description: "Inbound sales demo",
      scheduling_mode: "round_robin",
      member_count: 1,
      members: [{ id: 1, email: "demo@schedulesync.com", role: "admin" }],
    },
  ],
};

const ensureNumber = (v) => Number.parseInt(v, 10);

/* --------------------------- helper: db connect -------------------------- */
async function tryConnectDb() {
  const cs = process.env.DATABASE_URL;
  if (!cs) {
    dbStatus = "mock";
    console.warn("ℹ️  DATABASE_URL missing – using mock DB");
    return;
  }

  try {
    pool = new Pool({
      connectionString: cs,
      ssl: isProd ? { rejectUnauthorized: false } : false,
      // optional: increase timeouts a bit for managed DBs
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    await pool.query("SELECT 1;");
    dbStatus = "connected";
    console.log("✅ Database connected");
  } catch (err) {
    dbStatus = "error";
    pool = null;
    console.error("❌ Database connection failed, using mock DB:", err.message);
    dbStatus = "mock";
  }
}

/* -------------------------- helper: email setup -------------------------- */
async function tryConfigureEmail() {
  const { EMAIL_SERVICE, EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASSWORD } =
    process.env;

  if (!(EMAIL_USER && EMAIL_PASSWORD && (EMAIL_SERVICE || EMAIL_HOST))) {
    emailConfigured = false;
    console.warn(
      "⚠️  Email disabled: missing EMAIL_HOST/EMAIL_SERVICE and/or EMAIL_USER/EMAIL_PASSWORD"
    );
    return;
  }

  try {
    transporter = nodemailer.createTransport(
      EMAIL_SERVICE
        ? {
            service: EMAIL_SERVICE,
            auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
          }
        : {
            host: EMAIL_HOST,
            port: EMAIL_PORT ? Number(EMAIL_PORT) : 587,
            secure: Number(EMAIL_PORT) === 465, // true for 465, false otherwise
            auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
          }
    );

    // light verify with timeout guard
    await Promise.race([
      transporter.verify(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("SMTP verify timeout")), 5000)
      ),
    ]);

    emailConfigured = true;
    console.log("📧 Email transporter ready");
  } catch (err) {
    emailConfigured = false;
    transporter = null;
    console.warn("⚠️  Email verify failed:", err.message);
  }
}

/* ------------------------------- API: auth ------------------------------- */
app.post("/api/auth/register", async (req, res) => {
  const { email, name } = req.body || {};
  const user = {
    id: mock.users.length + 1,
    email: email || "user@example.com",
    name: name || "User",
  };
  mock.users.push(user);
  return res.json({
    status: "ok",
    user,
    token: "demo-token", // placeholder
  });
});

/* ------------------------------- API: teams ------------------------------ */
// GET /api/teams
app.get("/api/teams", async (_req, res) => {
  // mock only; extend here when you hook Postgres tables
  const teams = mock.teams.map((t) => ({
    id: t.id,
    name: t.name,
    public_url: t.public_url,
    scheduling_mode: t.scheduling_mode,
    member_count: t.members.length,
  }));
  res.json({ status: "ok", mode: dbStatus, teams });
});

// GET /api/teams/:id
app.get("/api/teams/:id", async (req, res) => {
  const id = ensureNumber(req.params.id);
  const team = mock.teams.find((t) => t.id === id);
  if (!team) return res.status(404).json({ status: "not_found" });
  res.json({ status: "ok", team, members: team.members });
});

// POST /api/teams
app.post("/api/teams", async (req, res) => {
  const { name, schedulingMode, publicUrl } = req.body || {};
  if (!name) return res.status(400).json({ status: "error", message: "name required" });
  const team = {
    id: ++seqTeam,
    name,
    public_url: publicUrl || name.toLowerCase().replace(/\s+/g, "-"),
    description: "",
    scheduling_mode: schedulingMode || "round_robin",
    members: [],
  };
  mock.teams.push(team);
  res.json({ status: "ok", team });
});

// PUT /api/teams/:id
app.put("/api/teams/:id", async (req, res) => {
  const id = ensureNumber(req.params.id);
  const team = mock.teams.find((t) => t.id === id);
  if (!team) return res.status(404).json({ status: "not_found" });
  const { name, description } = req.body || {};
  if (name) team.name = name;
  if (typeof description === "string") team.description = description;
  res.json({ status: "ok", team });
});

// POST /api/teams/:id/members
app.post("/api/teams/:id/members", async (req, res) => {
  const id = ensureNumber(req.params.id);
  const team = mock.teams.find((t) => t.id === id);
  if (!team) return res.status(404).json({ status: "not_found" });

  const { userId, role = "member", email } = req.body || {};
  const member = {
    id: ++seqMember,
    email:
      email ||
      (mock.users.find((u) => u.id === userId)?.email ?? "member@example.com"),
    role,
  };
  team.members.push(member);
  res.json({ status: "ok", member });
});

// PUT /api/teams/:id/members/:memberId/role
app.put("/api/teams/:id/members/:memberId/role", async (req, res) => {
  const id = ensureNumber(req.params.id);
  const memberId = ensureNumber(req.params.memberId);
  const team = mock.teams.find((t) => t.id === id);
  if (!team) return res.status(404).json({ status: "not_found" });

  const member = team.members.find((m) => m.id === memberId);
  if (!member) return res.status(404).json({ status: "not_found" });

  const { role } = req.body || {};
  if (role) member.role = role;
  res.json({ status: "ok", member });
});

// DELETE /api/teams/:id/members/:memberId
app.delete("/api/teams/:id/members/:memberId", async (req, res) => {
  const id = ensureNumber(req.params.id);
  const memberId = ensureNumber(req.params.memberId);
  const team = mock.teams.find((t) => t.id === id);
  if (!team) return res.status(404).json({ status: "not_found" });

  team.members = team.members.filter((m) => m.id !== memberId);
  res.json({ status: "ok" });
});

/* ------------------------------ API: email ------------------------------- */
// GET /api/email/test?to=someone@example.com
app.get("/api/email/test", async (req, res) => {
  const to = String(req.query.to || "").trim();
  if (!to) return res.status(400).json({ status: "error", message: "Missing ?to=" });
  if (!emailConfigured || !transporter) {
    return res.json({ status: "skipped", emailConfigured: false, to });
  }

  try {
    const from =
      process.env.EMAIL_FROM_NAME
        ? `${process.env.EMAIL_FROM_NAME} <${process.env.EMAIL_USER}>`
        : process.env.EMAIL_USER;

    const info = await transporter.sendMail({
      from,
      to,
      subject: "ScheduleSync: Test Email",
      text: "If you received this, SMTP is working.",
    });

    res.json({ status: "ok", to, id: info.messageId });
  } catch (err) {
    res.status(502).json({ status: "error", message: err.message });
  }
});

/* ------------------------------- API: health ----------------------------- */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    env: process.env.NODE_ENV || "development",
    db: dbStatus,
    emailConfigured,
    time: new Date().toISOString(),
  });
});

/* ----------------------------- bootstrap/start --------------------------- */
async function start() {
  await tryConnectDb();
  await tryConfigureEmail();

  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log("");
    console.log("✅ ScheduleSync API Server Running");
    console.log(`📡 Listening on http://localhost:${PORT}`);
    if (process.env.RAILWAY_STATIC_URL) {
      console.log(`🌐 Public: ${process.env.RAILWAY_STATIC_URL}`);
    }
    console.log(
      emailConfigured
        ? "📧 Email configured."
        : "📭 Email not configured; skipping SMTP verify."
    );
    console.log(`🗄️  DB mode: ${dbStatus}`);
    console.log("");
  });
}

// graceful shutdown
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down…");
  if (pool) pool.end().catch(() => {});
  process.exit(0);
});

start();
