// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const nodemailer = require("nodemailer");

const app = express();

/* -------------------- Middleware -------------------- */
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// If behind a proxy (Railway/Render/Heroku), this helps with correct IPs, HTTPS redirects, etc.
app.set("trust proxy", 1);

/* -------------------- Email Transport -------------------- */
const EMAIL_SERVICE = process.env.EMAIL_SERVICE || "gmail";
const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || "";
const EMAIL_HOST = process.env.EMAIL_HOST || ""; // optional (for non-Gmail)
const EMAIL_PORT = Number(process.env.EMAIL_PORT || 587);
const EMAIL_SECURE = String(process.env.EMAIL_SECURE || "false") === "true";

const emailConfigured = Boolean(EMAIL_USER && EMAIL_PASSWORD);

/** Create a Nodemailer transporter. */
function createTransporter() {
  // If a custom HOST is provided, use it; otherwise rely on "service"
  if (EMAIL_HOST) {
    return nodemailer.createTransport({
      host: EMAIL_HOST,
      port: EMAIL_PORT,
      secure: EMAIL_SECURE,
      auth: emailConfigured ? { user: EMAIL_USER, pass: EMAIL_PASSWORD } : undefined,
    });
  }
  return nodemailer.createTransport({
    service: EMAIL_SERVICE, // 'gmail' by default
    port: EMAIL_PORT,       // 587 default (TLS)
    secure: EMAIL_SECURE,   // false for 587, true for 465
    auth: emailConfigured ? { user: EMAIL_USER, pass: EMAIL_PASSWORD } : undefined,
  });
}

const transporter = createTransporter();

/** Verify SMTP with a timeout to avoid hanging the server. */
async function verifySMTP(timeoutMs = 5000) {
  if (!emailConfigured) return { ok: false, message: "Email not configured" };

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("SMTP verify timeout")), timeoutMs)
  );

  try {
    await Promise.race([transporter.verify(), timeout]);
    return { ok: true, message: "SMTP OK" };
  } catch (err) {
    return { ok: false, message: err?.message || "SMTP verify failed" };
  }
}

/* -------------------- Routes -------------------- */
app.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/health", async (_req, res) => {
  const smtp = await verifySMTP(2500); // quick check
  res.json({
    status: "ok",
    env: process.env.NODE_ENV || "development",
    time: new Date().toISOString(),
    emailConfigured,
    smtp: smtp.ok ? "verified" : `error: ${smtp.message}`,
  });
});

/**
 * POST /email/verify
 * Trigger a longer SMTP verify on demand (helpful for debugging)
 */
app.post("/email/verify", async (_req, res) => {
  const result = await verifySMTP(8000);
  const code = result.ok ? 200 : 502;
  res.status(code).json(result);
});

/**
 * POST /email/test
 * Body: { to?: string }
 * Sends a simple test email (uses EMAIL_USER as default "to" if omitted)
 */
app.post("/email/test", async (req, res) => {
  if (!emailConfigured) {
    return res.status(400).json({ ok: false, message: "Email not configured" });
  }

  const to = req.body?.to || EMAIL_USER;
  try {
    const info = await transporter.sendMail({
      from: `"ScheduleSync" <${EMAIL_USER}>`,
      to,
      subject: "Test Email from ScheduleSync",
      text: "Hello! This is a test email to confirm SMTP is working.",
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    res.status(502).json({ ok: false, message: err?.message || "Failed to send" });
  }
});

/* -------------------- Start Server (single listen) -------------------- */
const PORT = process.env.PORT || 8080; // Railway will provide PORT
const HOST = "0.0.0.0"; // listen on all interfaces

const server = app.listen(PORT, HOST, () => {
  console.log(`✅ Server listening on http://${HOST}:${PORT}`);
});

/* -------------------- Graceful Shutdown -------------------- */
function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down...`);
  server.close(err => {
    if (err) {
      console.error("Error during server close:", err);
      process.exit(1);
    }
    // Close other resources here if needed (e.g., DB pools)
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = app;
