// src/db.js
import pkg from 'pg';
const { Pool } = pkg;

const useSSL = process.env.DB_SSL === 'true';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(useSSL && {
    ssl: {
      rejectUnauthorized: false,
    },
  }),
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(1);
});

export { pool };
