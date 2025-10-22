// server.js — static hosting + small mock API so the UI works
const express = require("express");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- STATIC ----------
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// auto-redirect .htm → .html (e.g. /booking.htm)
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith(".htm")) {
    return res.redirect(301, req.path + "l");
  }
  next();
});

// Pages
app.get(["/", "/dashboard", "/dashboard.html"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "dashboard.html"))
);
app.get(["/booking", "/booking.html", "/booking.htm"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "booking.html"))
);
app.get(["/team-management", "/team-management.html"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "team-management.html"))
);

// ---------- HEALTH ----------
app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    env: process.env.NODE_ENV || "development",
    db: "mock",
    time: new Date().toISOString(),
  });
});

// ===================================================================
//                         MOCK API (in-memory)
// ===================================================================

// Simple in-memory store (resets on restart)
let seq = 1;
const nextId = () => seq++;

const users = [];           // { id, email, name }
const teams = [];           // { id, name, description, public_url, scheduling_mode, created_by }
const teamMembers = [];     // { team_id, user_id, role, booking_count, joined_at }

// Seed a default user + team so the page has something
function seedOnce() {
  if (users.length) return;

  const owner = { id: nextId(), email: "demo@schedulesync.com", name: "Demo User" };
  users.push(owner);

  const t = {
    id: nextId(),
    name: "Sales Team",
    description: "Inbound sales demos",
    public_url: "team-sales",
    scheduling_mode: "round_robin",
    created_by: owner.id,
  };
  teams.push(t);

  teamMembers.push({
    team_id: t.id,
    user_id: owner.id,
    role: "admin",
    booking_count: 0,
    joined_at: new Date().toISOString(),
  });
}
seedOnce();

// ------- tiny auth helper -------
function auth(req, res, next) {
  // Accept ANY token for the mock; if missing, create a demo token automatically
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

  // When no token, treat as demo user (id of first user)
  req.userId = users[0]?.id || 1;
  next();
}

// ---------- AUTH ----------
app.post("/api/auth/register", (req, res) => {
  const { email, name } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });

  let user = users.find(u => u.email === email);
  if (!user) {
    user = { id: nextId(), email, name: name || email.split("@")[0] };
    users.push(user);
  }

  // Return a fake token and the user
  return res.json({ token: "demo-token", user });
});

// ---------- TEAMS ----------
app.get("/api/teams", auth, (req, res) => {
  const myTeamIds = teamMembers.filter(tm => tm.user_id === req.userId).map(tm => tm.team_id);

  const result = teams
    .filter(t => myTeamIds.includes(t.id))
    .map(t => ({
      ...t,
      member_count: teamMembers.filter(tm => tm.team_id === t.id).length,
    }));

  res.json({ teams: result });
});

app.post("/api/teams", auth, (req, res) => {
  const { name, schedulingMode, publicUrl } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });

  const team = {
    id: nextId(),
    name,
    description: "",
    public_url: publicUrl || name.toLowerCase().replace(/\s+/g, "-"),
    scheduling_mode: schedulingMode || "round_robin",
    created_by: req.userId,
  };
  teams.push(team);

  teamMembers.push({
    team_id: team.id,
    user_id: req.userId,
    role: "admin",
    booking_count: 0,
    joined_at: new Date().toISOString(),
  });

  res.json({ success: true, team });
});

app.get("/api/teams/:teamId", auth, (req, res) => {
  const id = Number(req.params.teamId);
  const team = teams.find(t => t.id === id);
  if (!team) return res.status(404).json({ error: "Team not found" });

  const myRole = teamMembers.find(tm => tm.team_id === id && tm.user_id === req.userId);
  if (!myRole) return res.status(403).json({ error: "Not a team member" });

  const members = teamMembers
    .filter(tm => tm.team_id === id)
    .map(tm => {
      const u = users.find(x => x.id === tm.user_id);
      return {
        id: tm.user_id,
        email: u?.email || "unknown@example.com",
        name: u?.name || "",
        role: tm.role,
        booking_count: tm.booking_count || 0,
        last_booked_at: null,
        joined_at: tm.joined_at,
      };
    });

  res.json({ team, members, userRole: myRole.role });
});

app.put("/api/teams/:teamId", auth, (req, res) => {
  const id = Number(req.params.teamId);
  const team = teams.find(t => t.id === id);
  if (!team) return res.status(404).json({ error: "Team not found" });

  const me = teamMembers.find(tm => tm.team_id === id && tm.user_id === req.userId);
  if (!me || me.role !== "admin") return res.status(403).json({ error: "Only admins can update team" });

  const { name, description, schedulingMode } = req.body || {};
  if (name) team.name = name;
  if (typeof description === "string") team.description = description;
  if (schedulingMode) team.scheduling_mode = schedulingMode;

  res.json({ success: true, team });
});

app.post("/api/teams/:teamId/members", auth, (req, res) => {
  const id = Number(req.params.teamId);
  const team = teams.find(t => t.id === id);
  if (!team) return res.status(404).json({ error: "Team not found" });

  const me = teamMembers.find(tm => tm.team_id === id && tm.user_id === req.userId);
  if (!me || me.role !== "admin") return res.status(403).json({ error: "Only admins can add members" });

  const { userId, role } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });

  const exists = teamMembers.find(tm => tm.team_id === id && tm.user_id === Number(userId));
  if (!exists) {
    teamMembers.push({
      team_id: id,
      user_id: Number(userId),
      role: role || "member",
      booking_count: 0,
      joined_at: new Date().toISOString(),
    });
  }

  res.json({ success: true });
});

app.delete("/api/teams/:teamId/members/:userId", auth, (req, res) => {
  const teamId = Number(req.params.teamId);
  const userId = Number(req.params.userId);

  const me = teamMembers.find(tm => tm.team_id === teamId && tm.user_id === req.userId);
  if (!me || me.role !== "admin") return res.status(403).json({ error: "Only admins can remove members" });

  const idx = teamMembers.findIndex(tm => tm.team_id === teamId && tm.user_id === userId);
  if (idx >= 0) teamMembers.splice(idx, 1);

  res.json({ success: true });
});

app.put("/api/teams/:teamId/members/:userId/role", auth, (req, res) => {
  const teamId = Number(req.params.teamId);
  const userId = Number(req.params.userId);
  const { role } = req.body || {};

  const me = teamMembers.find(tm => tm.team_id === teamId && tm.user_id === req.userId);
  if (!me || me.role !== "admin") return res.status(403).json({ error: "Only admins can change roles" });

  const tm = teamMembers.find(x => x.team_id === teamId && x.user_id === userId);
  if (!tm) return res.status(404).json({ error: "Team member not found" });

  if (!["admin", "member", "viewer"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  tm.role = role;
  res.json({ success: true, member: tm });
});

// Minimal activity feed endpoint
app.get("/api/member/bookings", auth, (req, res) => {
  res.json({ bookings: [] });
});

// ---------- START ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Listening on http://localhost:${PORT}`);
});
