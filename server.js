// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const nodemailer = require("nodemailer");

const app = express();

/* -------------------- App Middleware -------------------- */
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.set("trust proxy", 1);

/* -------------------- Email Config -------------------- */
const EMAIL_SERVICE = process.env.EMAIL_SERVICE || "gmail";
const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || "";
const EMAIL_HOST = process.env.EMAIL_HOST || "";      // optional (for non-Gmail)
const EMAIL_PORT = Number(process.env.EMAIL_PORT || 587);
const EMAIL_SECURE = String(process.env.EMAIL_SECURE || "false") === "true";
const emailConfigured = Boolean(EMAIL_USER && EMAIL_PASSWORD);

/**
 * Create a transporter on demand so startup never blocks on DNS/SMTP.
 */
function makeTransporter() {
  if (EMAIL_HOST) {
    return nodemailer.createTransport({
      host: EMAIL_HOST,
      port: EMAIL_PORT,
      secure: EMAIL_SECURE,
      auth: emailConfigured ? { user: EMAIL_USER, pass: EMAIL_PASSWORD } : undefined,
    });
  }
  return nodemailer.createTransport({
    service: EMAIL_SERVICE, // 'gmail' default
    port: EMAIL_PORT,       // 587 default (TLS)
    secure: EMAIL_SECURE,   // false for 587, true for 465
    auth: emailConfigured ? { user: EMAIL_USER, pass: EMAIL_PASSWORD } : undefined,
  });
}

/**
 * Verify SMTP with timeout, used by /smtp/verify only.
 */
async function verifySMTP(timeoutMs = 8000) {
  if (!emailConfigured) return { ok: false, message: "Email not configured" };

  const transporter = makeTransporter();
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
  res.json({ status: "ok", service: "schedulesync" });
});

// Liveness: super fast, no external calls
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    env: process.env.NODE_ENV || "development",
    time: new Date().toISOString(),
    emailConfigured,
  });
});

// Readiness: also fast, no external calls
app.get("/ready", (_req, res) => {
  res.json({ status: "ready", time: new Date().toISOString() });
});

// Explicit SMTP check (on demand)
app.post("/smtp/verify", async (_req, res) => {
  const result = await verifySMTP(8000);
  res.status(result.ok ? 200 : 502).json(result);
});

/* -------------------- Start Server (single listen) -------------------- */
const PORT = process.env.PORT || 8080;   // Railway/Render/Heroku will set PORT
const HOST = "0.0.0.0";

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
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/* -------------------- Crash Guards -------------------- */
process.on("unhandledRejection", err => {
  console.error("UNHANDLED REJECTION:", err);
});
process.on("uncaughtException", err => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

module.exports = app;
