// ===============================
// ScheduleSync Backend (Clean)
// ===============================

require("dotenv").config();
const express = require("express");
const path = require("path");
const nodemailer = require("nodemailer");
const app = express();

// -------------------------------
// Middleware
// -------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------------------------------
// Static file serving
// -------------------------------
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// Redirect `.htm` → `.html`
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith(".htm")) {
    return res.redirect(301, req.path + "l");
  }
  next();
});

// -------------------------------
// Page routes
// -------------------------------
app.get(["/", "/dashboard", "/dashboard.html"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "dashboard.html"));
});

app.get(["/booking", "/booking.html", "/booking.htm"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "booking.html"));
});

app.get(["/team-management", "/team-management.html"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "team-management.html"));
});

// -------------------------------
// Mock API (for frontend testing)
// -------------------------------
app.get("/api/teams", (req, res) => {
  res.json({
    teams: [
      {
        id: 1,
        name: "Engineering Team",
        member_count: 3,
        scheduling_mode: "round_robin",
        public_url: "engineering-team",
      },
      {
        id: 2,
        name: "Sales Team",
        member_count: 2,
        scheduling_mode: "collective",
        public_url: "sales-team",
      },
    ],
  });
});

// -------------------------------
// Email setup
// -------------------------------
const EMAIL_MODE = process.env.EMAIL_MODE || "SMTP"; // "SMTP" or "MOCK"
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.EMAIL_USER;
let transporter = null;

if (
  EMAIL_MODE !== "MOCK" &&
  process.env.EMAIL_USER &&
  (process.env.EMAIL_PASSWORD || process.env.EMAIL_PASS)
) {
  // Custom SMTP (preferred) or Gmail (App Password)
  if (process.env.EMAIL_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT || 465),
      secure: String(process.env.EMAIL_SECURE || "true") === "true",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD || process.env.EMAIL_PASS,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });
  } else {
    transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD || process.env.EMAIL_PASS,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });
  }

  transporter
    .verify()
    .then(() => console.log("✅ Email transporter verified"))
    .catch((err) => console.warn("⚠️ Email verify failed:", err.message));
} else {
  console.log(
    "📨 Email mode = MOCK (no external SMTP calls). Set EMAIL_MODE=SMTP and credentials to send real email."
  );
}

// -------------------------------
// Health endpoint
// -------------------------------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    env: process.env.NODE_ENV || "production",
    db: "mock",
    emailConfigured: EMAIL_MODE !== "MOCK" && !!transporter,
    time: new Date().toISOString(),
  });
});

// -------------------------------
// Test Email endpoint
// -------------------------------
async function sendTestEmail(req, res) {
  const to = req.query.to || (req.body && req.body.to);
  if (!to) return res.status(400).json({ ok: false, error: 'Missing "to" address' });

  const mail = {
    from: EMAIL_FROM || "ScheduleSync <no-reply@schedulesync>",
    to,
    subject: "ScheduleSync • Test Email",
    text: "This is a test email from ScheduleSync.",
    html: "<p>This is a <b>test</b> email from ScheduleSync.</p>",
  };

  try {
    if (EMAIL_MODE === "MOCK" || !transporter) {
      console.log("📧 [MOCK] Would send test email to:", to);
      return res.json({ ok: true, mock: true });
    }

    const info = await Promise.race([
      transporter.sendMail(mail),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SMTP timeout")), 12000)),
    ]);

    res.json({ ok: true, messageId: info.messageId || null });
  } catch (err) {
    console.error("❌ Email test error:", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
}

app.get("/api/email/test", sendTestEmail);
app.post("/api/email/test", sendTestEmail);

// -------------------------------
// Start server
// -------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Listening on http://localhost:${PORT}`);
});
