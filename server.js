// server.js — ScheduleSync (clean mock backend)
require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");

// ----------------------------------------------------------------------------
// App setup
// ----------------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || "production"; // default to prod for Railway
const PUBLIC_DIR = path.join(__dirname, "public");

// basic middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// tiny request logger (useful on Railway logs)
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.url}`);
  next();
});

// ----------------------------------------------------------------------------
// Static hosting
// ----------------------------------------------------------------------------
app.use(express.static(PUBLIC_DIR));

// redirect ".htm" → ".html"
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith(".htm")) {
    return res.redirect(301, req.path + "l");
  }
  next();
});

// pretty routes for your pages
app.get(["/", "/dashboard", "/dashboard.html"], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "dashboard.html"));
});
app.get(["/booking", "/booking.html", "/booking.htm"], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "booking.html"));
});
app.get(["/team-management", "/team-management.html"], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "team-management.html"));
});

// ----------------------------------------------------------------------------
// Health
// ----------------------------------------------------------------------------
const emailEnv = {
  user: process.env.EMAIL_USER || "",
  pass: process.env.EMAIL_PASSWORD || "",
  service: process.env.EMAIL_SERVICE || "",
};
const emailConfigured = Boolean(emailEnv.user && emailEnv.pass);

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    env: NODE_ENV,
    db: "mock",
    emailConfigured,
    time: new Date().toISOString(),
  });
});

// ----------------------------------------------------------------------------
// Mock API (keeps the UI working without a real database)
// ----------------------------------------------------------------------------
const MOCK_TEAMS = [
  {
    id: 1,
    name: "Engineering Team",
    public_url: "team-eng",
    scheduling_mode: "round_robin",
    member_count: 3,
    description: "Handles product and platform.",
  },
  {
    id: 2,
    name: "Sales Team",
    public_url: "team-sales",
    scheduling_mode: "collective",
    member_count: 2,
    description: "Talks to customers.",
  },
];

app.get("/api/teams", (_req, res) => {
  res.json({ teams: MOCK_TEAMS });
});

app.get("/api/teams/:id", (req, res) => {
  const id = Number(req.params.id);
  const team = MOCK_TEAMS.find((t) => t.id === id);
  if (!team) return res.status(404).json({ ok: false, message: "Team not found" });
  res.json({
    team,
    members: [
      { id: 101, email: "alice@example.com", role: "admin" },
      { id: 102, email: "bob@example.com", role: "member" },
    ],
    userRole: "admin",
  });
});

app.post("/api/auth/register", (req, res) => {
  const email = req.body?.email || "demo@schedulesync.dev";
  const name = req.body?.name || "Demo User";
  res.json({
    ok: true,
    message: "Demo register successful (no real account created)",
    token: "demo.jwt.token",
    user: { id: Date.now(), email, name },
  });
});

// ----------------------------------------------------------------------------
// Email test (non-blocking; never hangs)
// - GET  /api/email/test?to=someone@example.com
// - POST /api/email/test { "to": "someone@example.com" }
// If EMAIL_USER + EMAIL_PASSWORD exist, tries SMTP; else simulates success.
// ----------------------------------------------------------------------------
app.all("/api/email/test", async (req, res) => {
  try {
    const to =
      (req.method === "GET" ? req.query?.to : req.body?.to) ||
      process.env.TEST_RECIPIENT ||
      "";

    if (!to || !String(to).includes("@")) {
      return res
        .status(400)
        .json({ ok: false, message: 'Provide recipient via ?to=someone@example.com' });
    }

    // If no SMTP creds, simulate success quickly (so Railway doesn't 502)
    if (!emailConfigured) {
      console.log(`[EMAIL:SIMULATED] to=${to}`);
      return res.json({
        ok: true,
        simulated: true,
        message:
          "Email service not configured; simulated success. Set EMAIL_USER and EMAIL_PASSWORD to send real emails.",
      });
    }

    // Try real send (Gmail/SMTP)
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      service: emailEnv.service || "gmail",
      auth: { user: emailEnv.user, pass: emailEnv.pass },
    });

    const info = await transporter.sendMail({
      from: `ScheduleSync <${emailEnv.user}>`,
      to,
      subject: "ScheduleSync Test Email",
      text: "This is a test email from ScheduleSync.",
      html: `<p>This is a <b>test email</b> from ScheduleSync.</p>`,
    });

    console.log(`[EMAIL:SENT] to=${to} id=${info?.messageId}`);
    return res.json({ ok: true, simulated: false, messageId: info?.messageId || null });
  } catch (err) {
    console.error("Email test error:", err?.message);
    // Return a safe JSON error (do not hang)
    return res
      .status(500)
      .json({ ok: false, message: "Email send failed", error: String(err?.message || err) });
  }
});

// ----------------------------------------------------------------------------
// 404 for unknown API routes (helps debugging)
// ----------------------------------------------------------------------------
app.use("/api", (_req, res) => {
  res.status(404).json({ ok: false, message: "API route not found" });
});

// ----------------------------------------------------------------------------
// Start server (0.0.0.0 for Railway)
// ----------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ScheduleSync mock API running on http://localhost:${PORT}`);
});
