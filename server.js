// ------------------------------
// ScheduleSync Server (clean build)
// ------------------------------
const express = require("express");
const path = require("path");
const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ------------------------------
// Serve static files from /public
// ------------------------------
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// Optional redirect .htm → .html
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith(".htm")) {
    return res.redirect(301, req.path + "l");
  }
  next();
});

// ------------------------------
// Email setup (Gmail or custom SMTP)
// ------------------------------
const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || "";
const EMAIL_SERVICE = (process.env.EMAIL_SERVICE || "").toLowerCase();
const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_PORT = process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : undefined;
const EMAIL_SECURE = process.env.EMAIL_SECURE
  ? process.env.EMAIL_SECURE === "true"
  : undefined;

let mailer = null;
let emailConfigured = false;

if (EMAIL_USER && EMAIL_PASSWORD) {
  emailConfigured = true;
  if (EMAIL_HOST) {
    mailer = nodemailer.createTransport({
      host: EMAIL_HOST,
      port: EMAIL_PORT ?? 587,
      secure: EMAIL_SECURE ?? false,
      auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
    });
  } else if (EMAIL_SERVICE) {
    mailer = nodemailer.createTransport({
      service: EMAIL_SERVICE, // "gmail" etc.
      auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
    });
  }

  mailer?.verify((err) => {
    if (err) console.error("❌ SMTP verify failed:", err.message || err);
    else console.log("✅ Email service ready");
  });
} else {
  console.warn("⚠️ Email not configured. Set EMAIL_USER and EMAIL_PASSWORD.");
}

// ------------------------------
// Health endpoint
// ------------------------------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    env: process.env.NODE_ENV || "development",
    db: "mock",
    emailConfigured,
    time: new Date().toISOString(),
  });
});

// ------------------------------
// Email test endpoints
// ------------------------------
app.post("/api/email/test", async (req, res) => {
  try {
    if (!mailer) return res.status(400).json({ success: false, error: "Email not configured" });

    const to = (req.body?.to || EMAIL_USER || "").trim();
    if (!to.includes("@")) return res.status(400).json({ success: false, error: "Invalid recipient" });

    const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");
    const html = `
      <div style="font-family:Arial;padding:16px;max-width:640px;margin:auto">
        <h2>ScheduleSync SMTP Test</h2>
        <p>This is a test email from your production server.</p>
        <p>APP_URL: <code>${APP_URL}</code></p>
      </div>
    `;

    const info = await mailer.sendMail({
      from: `ScheduleSync <${EMAIL_USER}>`,
      to,
      subject: "ScheduleSync: SMTP Test",
      html,
      text: "This is a test email from ScheduleSync.",
    });

    res.json({ success: true, to, messageId: info.messageId, response: info.response });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// GET fallback (useful for quick test in browser)
app.get("/api/email/test", async (req, res) => {
  try {
    if (!mailer) return res.status(400).json({ success: false, error: "Email not configured" });

    const to = (req.query.to || EMAIL_USER || "").trim();
    if (!to.includes("@")) return res.status(400).json({ success: false, error: "Invalid recipient" });

    const info = await mailer.sendMail({
      from: `ScheduleSync <${EMAIL_USER}>`,
      to,
      subject: "ScheduleSync: SMTP Test (GET)",
      html: "<p>This is a GET fallback test email.</p>",
      text: "GET fallback test email.",
    });

    res.json({ success: true, to, messageId: info.messageId, response: info.response });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// ------------------------------
// Mock API for Teams (frontend demo)
// ------------------------------
app.get("/api/teams", (req, res) => {
  res.json({
    teams: [
      {
        id: 1,
        name: "Demo Team",
        scheduling_mode: "round_robin",
        member_count: 3,
        public_url: "demo-team",
      },
      {
        id: 2,
        name: "Product QA",
        scheduling_mode: "collective",
        member_count: 4,
        public_url: "qa-team",
      },
    ],
  });
});

app.get("/api/teams/:id", (req, res) => {
  const { id } = req.params;
  res.json({
    team: {
      id,
      name: id === "1" ? "Demo Team" : "Product QA",
      description: "Sample description for testing.",
      scheduling_mode: id === "1" ? "round_robin" : "collective",
      public_url: id === "1" ? "demo-team" : "qa-team",
    },
    members: [
      { id: 1, email: "admin@schedulesync.com", role: "admin" },
      { id: 2, email: "member@schedulesync.com", role: "member" },
    ],
  });
});

// ------------------------------
// Page routes
// ------------------------------
app.get(["/", "/dashboard", "/dashboard.html"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "dashboard.html"));
});

app.get(["/booking", "/booking.html", "/booking.htm"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "booking.html"));
});

app.get(["/team-management", "/team-management.html"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "team-management.html"));
});

// ------------------------------
// Start server
// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Listening on http://localhost:${PORT}`);
});
