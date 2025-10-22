 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/server.js b/server.js
index 6a3ca51bc743e1b5267cfc11986ec7305e30e6c9..73f21cdc1427386c8aafa161c103c2b970284caf 100644
--- a/server.js
+++ b/server.js
@@ -12,90 +12,131 @@ const JWT_SECRET = process.env.JWT_SECRET || 'schedulesync-secret-2025';
 // OAuth Credentials (hardcoded for now)
 const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || 'c3bb1864-422d-4fa8-8701-27f7b903d1e9';
 const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || 'bcc558ea-c38d-41d8-8bfe-0551b78877ae';
 const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1046899819143-hnebgn1jti2ec2j8v1e25sn6vuae961e.apps.googleusercontent.com';
 const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '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';
 
 app.use(cors());
 app.use(express.json());
 app.use(express.static('public'));
 
 console.log('🚀 ScheduleSync API Starting...');
 console.log(`📡 Listening on port ${PORT}`);
 console.log(`\n📋 Environment Variables Check:`);
 console.log(`  MICROSOFT_CLIENT_ID: ${MICROSOFT_CLIENT_ID ? '✅ Found' : '❌ Missing'}`);
 console.log(`  MICROSOFT_CLIENT_SECRET: ${MICROSOFT_CLIENT_SECRET ? '✅ Found' : '❌ Missing'}`);
 console.log(`  GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID ? '✅ Found' : '❌ Missing'}`);
 console.log(`  GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET ? '✅ Found' : '❌ Missing'}`);
 console.log();
 
 const pool = new Pool({
   connectionString: process.env.DATABASE_URL,
   ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
 });
 
 let dbReady = false;
+const schemaState = {
+  teamsOwnerId: null
+};
+
+async function columnExists(tableName, columnName) {
+  const result = await pool.query(
+    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
+    [tableName, columnName]
+  );
+  return result.rowCount > 0;
+}
+
+async function refreshTeamsOwnerColumnStatus() {
+  try {
+    const exists = await columnExists('teams', 'owner_id');
+    const previous = schemaState.teamsOwnerId;
+    schemaState.teamsOwnerId = exists;
+    if (previous !== exists) {
+      if (exists) {
+        console.log('  ✅ teams.owner_id column ready');
+      } else {
+        console.warn('  ⚠️ teams.owner_id column missing; analytics will use fallback logic');
+      }
+    }
+  } catch (error) {
+    console.warn('  ⚠️ Could not verify teams.owner_id column:', error.message);
+    schemaState.teamsOwnerId = false;
+  }
+}
 
 pool.query('SELECT NOW()', (err) => {
   if (err) {
     console.error('❌ Database connection failed:', err.message);
   } else {
     console.log('✅ Database connected');
     initDatabase();
   }
 });
 
 async function initDatabase() {
   try {
     console.log('🔄 Initializing database...');
     
     await pool.query(`
       CREATE TABLE IF NOT EXISTS users (
         id SERIAL PRIMARY KEY,
         name VARCHAR(255) NOT NULL,
         email VARCHAR(255) UNIQUE NOT NULL,
         password VARCHAR(255) NOT NULL,
         created_at TIMESTAMP DEFAULT NOW()
       )
     `);
     console.log('  ✅ users table');
     
     await pool.query(`
       ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255) DEFAULT 'temp'
     `).catch(() => {});
     
     await pool.query(`
       CREATE TABLE IF NOT EXISTS teams (
         id SERIAL PRIMARY KEY,
         name VARCHAR(255) NOT NULL,
         description TEXT,
         owner_id INTEGER NOT NULL REFERENCES users(id),
         public_url VARCHAR(255) UNIQUE,
         created_at TIMESTAMP DEFAULT NOW()
       )
     `);
     console.log('  ✅ teams table');
+
+    // Ensure owner_id column exists for legacy databases
+    try {
+      await pool.query(`
+        ALTER TABLE teams
+        ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id)
+      `);
+    } catch (error) {
+      console.warn('  ⚠️ Could not ensure teams.owner_id column:', error.message);
+    }
+
+    await refreshTeamsOwnerColumnStatus();
     
     await pool.query(`
       CREATE TABLE IF NOT EXISTS team_members (
         id SERIAL PRIMARY KEY,
         team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         role VARCHAR(50) DEFAULT 'member',
         joined_at TIMESTAMP DEFAULT NOW(),
         UNIQUE(team_id, user_id)
       )
     `);
     console.log('  ✅ team_members table');
     
     await pool.query(`
       CREATE TABLE IF NOT EXISTS time_slots (
         id SERIAL PRIMARY KEY,
         team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         slot_start TIMESTAMP NOT NULL,
         slot_end TIMESTAMP NOT NULL,
         is_available BOOLEAN DEFAULT true,
         created_at TIMESTAMP DEFAULT NOW()
       )
     `);
     console.log('  ✅ time_slots table');
@@ -351,54 +392,72 @@ app.get('/api/analytics/dashboard', async (req, res) => {
       recentActivity: []
     };
 
     // Get total bookings
     const bookingsResult = await pool.query(
       'SELECT COUNT(*) as count FROM bookings WHERE user_id = $1',
       [userId]
     );
     analytics.totalBookings = parseInt(bookingsResult.rows[0]?.count || 0);
 
     // Get upcoming meetings
     const upcomingResult = await pool.query(
       'SELECT COUNT(*) as count FROM bookings WHERE user_id = $1 AND start_time > NOW() AND status = $2',
       [userId, 'confirmed']
     );
     analytics.upcomingMeetings = parseInt(upcomingResult.rows[0]?.count || 0);
 
     // Get completed meetings
     const completedResult = await pool.query(
       'SELECT COUNT(*) as count FROM bookings WHERE user_id = $1 AND end_time < NOW()',
       [userId]
     );
     analytics.completedMeetings = parseInt(completedResult.rows[0]?.count || 0);
 
     // Get team members count
-    const teamResult = await pool.query(
-      'SELECT COUNT(DISTINCT tm.user_id) as count FROM team_members tm JOIN teams t ON tm.team_id = t.id WHERE t.owner_id = $1',
-      [userId]
-    );
+    if (schemaState.teamsOwnerId === null) {
+      await refreshTeamsOwnerColumnStatus();
+    }
+
+    let teamResult;
+    if (schemaState.teamsOwnerId) {
+      teamResult = await pool.query(
+        'SELECT COUNT(DISTINCT tm.user_id) as count FROM team_members tm JOIN teams t ON tm.team_id = t.id WHERE t.owner_id = $1',
+        [userId]
+      );
+    } else {
+      teamResult = await pool.query(
+        `SELECT COUNT(DISTINCT tm_member.user_id) as count
+         FROM team_members tm_member
+         WHERE tm_member.team_id IN (
+           SELECT tm_owner.team_id
+           FROM team_members tm_owner
+           WHERE tm_owner.user_id = $1
+         )`,
+        [userId]
+      );
+    }
     analytics.teamMembers = parseInt(teamResult.rows[0]?.count || 0);
 
     // Get recent activity
     const activityResult = await pool.query(
       `SELECT b.id, b.title, b.start_time, b.end_time, b.status, u.name as attendee_name
        FROM bookings b
        LEFT JOIN users u ON b.attendee_id = u.id
        WHERE b.user_id = $1
        ORDER BY b.created_at DESC
        LIMIT 10`,
       [userId]
     );
     analytics.recentActivity = activityResult.rows;
 
     res.json(analytics);
   } catch (error) {
     console.error('Error fetching analytics:', error);
     res.status(500).json({ error: 'Failed to fetch analytics' });
   }
 });
 
 // ============================================================================
 // CALENDAR INTEGRATION ENDPOINTS
 // ============================================================================
 
 
EOF
)