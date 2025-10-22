// server.js
"use strict";

const express = require("express");
const path = require("path");
const cors = require("cors");
const dotenv = require("dotenv");

// Load env (quiet in prod)
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

/* --------------------------- Middleware --------------------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

/* --------------------------- Static pages ------------------------- */
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// Friendly .htm → .html redirect
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith(".htm")) {
    return res.redirect(301, req.path + "l");
  }
  next();
});

app.get(["/", "/dashboard", "/dashboard.html"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "dashboard.html"))
);
app.get(["/booking", "/booking.html", "/booking.htm"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "booking.html"))
);
app.get(["/team-management", "/team-management.html"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "team-management.html"))
);

/* --------------------------- Mock Data ---------------------------- */
let nextTeamId = 2;
let nextMemberId = 3;

const db = {
  users: [],
  teams: [
    {
      id: 1,
      name: "Sales Team",
      description: "Inbound sales demos",
      scheduling_mode: "round_robin",
      public_url: "team-sales",
      member_count: 2,
    },
  ],
  members: [
    { id: 1, team_id: 1, email: "alice@example.com", role: "admin" },
    { id: 2, team_id: 1, email: "bob@example.com", role: "member" },
  ],
};

/* --------------------------- Helpers ------------------------------ */
function teamWithCounts(team) {
  const count = db.members.filter((m) => m.team_id === team.id).length;
  return { ...team, member_count: count };
}

function pick(obj, keys) {
  return keys.reduce((a, k) => {
    if (obj[k] !== undefined) a[k] = obj[k];
    return a;
  }, {});
}

/* --------------------------- Auth (demo) -------------------------- */
app.post("/api/auth/register", (req, res) => {
  const { email, name = "", extensionId = "" } = req.body || {};
  if (!email) return res.status(400).json({ error: "email_required" });

  let user = db.users.find((u) => u.email === email);
  if (!user) {
    user = { id: db.users.length + 1, email, name, extensionId };
    db.users.push(user);
  }

  // Demo token (no real JWT verification needed for the mock)
  const token = Buffer.from(`${user.id}:${email}`).toString("base64");

  res.json({ user: pick(user, ["id", "email", "name"]), token });
});

/* --------------------------- Teams API ---------------------------- */
// list teams
app.get("/api/teams", (req, res) => {
  res.json({ teams: db.teams.map(teamWithCounts) });
});

// team details
app.get("/api/teams/:id", (req, res) => {
  const id = Number(req.params.id);
  const team = db.teams.find((t) => t.id === id);
  if (!team) return res.status(404).json({ error: "team_not_found" });

  const members = db.members
    .filter((m) => m.team_id === id)
    .map((m) => pick(m, ["id", "email", "role"]));

  res.json({ team: teamWithCounts(team), members });
});

// create team
app.post("/api/teams", (req, res) => {
  const { name, schedulingMode = "round_robin", publicUrl } = req.body || {};
  if (!name) return res.status(400).json({ error: "name_required" });

  const team = {
    id: nextTeamId++,
    name,
    description: "",
    scheduling_mode: String(schedulingMode || "round_robin"),
    public_url:
      publicUrl || name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
    member_count: 0,
  };
  db.teams.push(team);
  res.status(201).json({ team: teamWithCounts(team) });
});

// update team
app.put("/api/teams/:id", (req, res) => {
  const id = Number(req.params.id);
  const team = db.teams.find((t) => t.id === id);
  if (!team) return res.status(404).json({ error: "team_not_found" });
  const { name, description, scheduling_mode } = req.body || {};
  if (name) team.name = name;
  if (description !== undefined) team.description = description;
  if (scheduling_mode) team.scheduling_mode = scheduling_mode;
  res.json({ team: teamWithCounts(team) });
});

// add member
app.post("/api/teams/:id/members", (req, res) => {
  const id = Number(req.params.id);
  const team = db.teams.find((t) => t.id === id);
  if (!team) return res.status(404).json({ error: "team_not_found" });

  const { userId, email, role = "member" } = req.body || {};
  const resolvedEmail =
    email ||
    (db.users.find((u) => u.id === Number(userId)) || {}).email ||
    null;
  if (!resolvedEmail) return res.status(400).json({ error: "email_required" });

  const member = { id: nextMemberId++, team_id: id, email: resolvedEmail, role };
  db.members.push(member);
  res.status(201).json({ member: pick(member, ["id", "email", "role"]) });
});

// change role
app.put("/api/teams/:id/members/:memberId/role", (req, res) => {
  const id = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  const member = db.members.find((m) => m.team_id === id && m.id === memberId);
  if (!member) return res.status(404).json({ error: "member_not_found" });
  const { role } = req.body || {};
  if (!role) return res.status(400).json({ error: "role_required" });
  member.role = role;
  res.json({ member: pick(member, ["id", "email", "role"]) });
});

// remove member
app.delete("/api/teams/:id/members/:memberId", (req, res) => {
  const id = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  const idx = db.members.findIndex((m) => m.team_id === id && m.id === memberId);
  if (idx === -1) return res.status(404).json({ error: "member_not_found" });
  db.members.splice(idx, 1);
  res.status(204).end();
});

/* --------------------------- Email (optional) --------------------- */
const EMAIL_HOST = process.env.EMAIL_HOST || "";
const EMAIL_PORT = process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : 587;
const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || "";
const EMAIL_FROM =
  process.env.EMAIL_FROM || (EMAIL_USER ? EMAIL_USER : "noreply@schedulesync.local");

let emailConfigured =
  Boolean(EMAIL_HOST && EMAIL_USER && EMAIL_PASSWORD && EMAIL_FROM);

let transporter = null;
if (emailConfigured) {
  const nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_PORT === 465,
    auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
  });
} else {
  // Non-fatal: just log once on boot that email is disabled
  console.warn("⚠️  Email disabled: missing EMAIL_HOST/EMAIL_USER/EMAIL_PASSWORD env vars.");
}

// GET test -> /api/email/test?to=someone@example.com
app.get("/api/email/test", async (req, res) => {
  const to = String(req.query.to || "").trim();
  if (!to) return res.status(400).json({ status: "error", message: "Query param 'to' required" });

  if (!emailConfigured) {
    return res.json({ status: "skipped", emailConfigured: false, to });
  }

  try {
    await transporter.sendMail({
      from: EMAIL_FROM,
      to,
      subject: "ScheduleSync test email",
      text: "Hello from ScheduleSync 👋",
    });
    res.json({ status: "sent", emailConfigured: true, to });
  } catch (err) {
    res.status(502).json({ status: "error", code: "smtp_error", message: err.message });
  }
});

// POST test -> { "to": "someone@example.com" }
app.post("/api/email/test", async (req, res) => {
  const to = String((req.body || {}).to || "").trim();
  if (!to) return res.status(400).json({ status: "error", message: "Body field 'to' required" });

  if (!emailConfigured) {
    return res.json({ status: "skipped", emailConfigured: false, to });
  }

  try {
    await transporter.sendMail({
      from: EMAIL_FROM,
      to,
      subject: "ScheduleSync test email",
      text: "Hello from ScheduleSync 👋",
    });
    res.json({ status: "sent", emailConfigured: true, to });
  } catch (err) {
    res.status(502).json({ status: "error", code: "smtp_error", message: err.message });
  }
});

/* --------------------------- Health -------------------------------- */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    env: process.env.NODE_ENV || "production",
    db: "mock",
    emailConfigured,
    time: new Date().toISOString(),
  });
});

/* --------------------------- Start & Shutdown ----------------------- */
const server = app.listen(PORT, () => {
  console.log("✅ ScheduleSync API Server Running");
  console.log(`📡 Listening on http://localhost:${PORT}`);
  console.log(`🌐 Public: https://schedulesync-production.up.railway.app`);
  if (!emailConfigured) {
    console.log("✋ Email not configured; skipping SMTP verify.");
  }
});

function shutdown(sig) {
  console.log(`\n${sig} received, shutting down…`);
  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
