const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    const who = await pool.query('SELECT current_user, current_database()');
    console.log('Connected as:', who.rows[0]);

    // Make current user the owner of specific tables first (time_slots, users)
    await pool.query(`
      ALTER TABLE IF EXISTS public.time_slots OWNER TO ${process.env.PGUSER || 'postgres'};
      ALTER TABLE IF EXISTS public.users      OWNER TO ${process.env.PGUSER || 'postgres'};
    `);

    // (Optional) Make current user the owner of ALL public objects
    await pool.query(`
      DO $$
      DECLARE r record;
      BEGIN
        -- tables
        FOR r IN SELECT 'public.'||tablename AS n FROM pg_tables WHERE schemaname='public' LOOP
          EXECUTE 'ALTER TABLE '||r.n||' OWNER TO '||current_user;
        END LOOP;
        -- sequences
        FOR r IN SELECT 'public.'||sequence_name AS n FROM information_schema.sequences WHERE sequence_schema='public' LOOP
          EXECUTE 'ALTER SEQUENCE '||r.n||' OWNER TO '||current_user;
        END LOOP;
        -- views
        FOR r IN SELECT 'public.'||table_name AS n FROM information_schema.views WHERE table_schema='public' LOOP
          EXECUTE 'ALTER VIEW '||r.n||' OWNER TO '||current_user;
        END LOOP;
      END $$;
    `);

    console.log('✅ Ownership fixed to current_user');
  } catch (e) {
    console.error('❌ Fix failed:', e.message);
  } finally {
    await pool.end();
  }
})();
