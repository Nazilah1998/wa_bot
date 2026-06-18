const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Otomatis mencari di schema wa_bot dan ptsp
pool.on('connect', (client) => {
  client.query('SET search_path TO kemenag_bot, kemenag_ptsp, public');
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};
