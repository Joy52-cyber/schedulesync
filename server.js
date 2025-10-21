const express = require("express");
const path = require("path");
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from /public
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// Redirect .htm → .html (so /booking.htm works)
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith(".htm")) {
    return res.redirect(301, req.path + "l");
  }
  next();
});

// Page routes
app.get(["/", "/dashboard", "/dashboard.html"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "dashboard.html"))
);
app.get(["/booking", "/booking.html", "/booking.htm"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "booking.html"))
);
app.get(["/team-management", "/team-management.html"], (_, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "team-management.html"))
);

// Health
app.get("/health", (_, res) =>
  res.json({
    status: "ok",
    env: process.env.NODE_ENV || "development",
    db: "connected",
    time: new Date().toISOString(),
  })
);

// Start
const PORT = process.env.PORT || 8080; // Railway defaults to 8080
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Listening on 0.0.0.0:${PORT}`);
});
