// server.js — ScheduleSync (Option B: mock DB + optional email)
const express = require("express");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Static files & page routes ---
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// Optional: redirect ".htm" -> ".html"
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith(".htm")) {
    return res.redirect(301, req.path + "l");
  }
  next();
});

// Pretty pages
app.get(["/", "/dashboard", "/dashboard.html"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "dashboard.html"))
);
app.get(["/booking", "/booking.html", "/booking.htm"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "booking.html"))
);
app.get(["/team-management", "/team-management.html"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "team-management.html"))
);

// --- Email transport (optional) ---
const emailConfig =
  (process.env.EMAIL_SERVICE && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) ||
  (process.env.EMAIL_HOST && process.env.EMAIL_PORT && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD);

let transporter = null;
if (emailConfig) {
  if (process.env.EMAIL_SERVICE) {
    transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE, // e.g. 'gmail'
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
    });
  } else {
    // Custom SMTP
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT) || 587,
      secure: String(process.env.EMAIL_SECURE || "false").toLowerCase() === "true",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
    });
  }
}

// --- Health ---
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    env: process.env.NODE_ENV || "development",
    db: "mock",
    emailConfigured: Boolean(transporter),
    time: new Date().toISOString(),
  });
});

// --- Mock API for UI to function in prod ---
app.post("/api/auth/register", (req, res) => {
  // return a fake token+user so the UI can proceed
  const email = req.body?.email || "demo@schedulesync.com";
  res.json({
    token: "mock.jwt.token",
    user: { id: 1, email, name: req.body?.name || "Demo User" },
  });
});

app.get("/api/teams", (_req, res) => {
  res.json({
    teams: [
      {
        id: 101,
        name: "Core Team",
        description: "Primary scheduling team",
        scheduling_mode: "round_robin",
        public_url: "core-team",
        member_count: 3,
        created_at: new Date().toISOString(),
      },
    ],
  });
});

app.get("/api/teams/:teamId", (req, res) => {
  const teamId = Number(req.params.teamId) || 101;
  res.json({
    team: {
      id: teamId,
      name: "Core Team",
      description: "Primary scheduling team",
      public_url: "core-team",
      scheduling_mode: "round_robin",
    },
    userRole: "admin",
    members: [
      { id: 1, name: "Alice", email: "alice@example.com", role: "admin", booking_count: 4 },
      { id: 2, name: "Bob", email: "bob@example.com", role: "member", booking_count: 2 },
      { id: 3, name: "Cara", email: "cara@example.com", role: "viewer", booking_count: 0 },
    ],
  });
});

// --- Email test endpoint ---
app.get("/api/email/test", async (req, res) => {
  try {
    const to = req.query.to;
    if (!to || !to.includes("@")) {
      return res.status(400).json({ ok: false, error: "Missing or invalid ?to=email@example.com" });
    }
    if (!transporter) {
      return res.status(503).json({ ok: false, error: "Email not configured on server (no SMTP vars)" });
    }
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to,
      subject: "ScheduleSync • Test Email",
      text: "This is a test email from ScheduleSync.",
      html: "<p>This is a <b>test email</b> from ScheduleSync.</p>",
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/email/test", async (req, res) => {
  req.query.to = req.body?.to; // allow POST {to:"..."} as well
  return app._router.handle(req, res, require("express/lib/router/layer")()); // reuse the GET handler
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Listening on http://localhost:${PORT}`);
});
