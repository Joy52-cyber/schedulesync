const express = require("express");
const path = require("path");
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === Static file serving ===
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// Optional: auto-redirect `.htm` → `.html`
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith(".htm")) {
    return res.redirect(301, req.path + "l");
  }
  next();
});

// === Page routes ===
app.get(["/", "/dashboard", "/dashboard.html"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "dashboard.html"));
});

app.get(["/booking", "/booking.html", "/booking.htm"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "booking.html"));
});

app.get(["/team-management", "/team-management.html"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "team-management.html"));
});

// === Health check ===
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    env: process.env.NODE_ENV || "development",
    db: "connected",
    time: new Date().toISOString(),
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Listening on http://localhost:${PORT}`);
});
