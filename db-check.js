const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'db_fleetgo',
  password: 'user123',
  port: 5432,
});

async function check() {
  try {
    const res = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    console.log("Tables in db_fleetgo:", res.rows);
    if (res.rows.length > 0) {
      for (let table of res.rows) {
        const columns = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${table.tablename}'`);
        console.log(`Table ${table.tablename} columns:`, columns.rows.map(c => `${c.column_name} (${c.data_type})`).join(', '));
        const count = await pool.query(`SELECT COUNT(*) FROM ${table.tablename}`);
        console.log(`Table ${table.tablename} rows count:`, count.rows[0].count);
        if (table.tablename === 'users') {
          const users = await pool.query(`SELECT id, nama, email, role, password FROM users`);
          console.log(`Users:`, users.rows);
        }
      }
    }
  } catch (err) {
    console.error("Error connecting to DB:", err.message);
  } finally {
    await pool.end();
  }
}

check();
