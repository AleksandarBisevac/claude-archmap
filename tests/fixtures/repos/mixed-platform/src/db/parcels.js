const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function listParcels() {
  const result = await pool.query('SELECT id, status, shipped_at FROM parcels ORDER BY shipped_at DESC');
  return result.rows;
}

async function findParcel(id) {
  const result = await pool.query('SELECT id, status, shipped_at FROM parcels WHERE id = $1', [id]);
  return result.rows[0];
}

module.exports = { listParcels, findParcel };
