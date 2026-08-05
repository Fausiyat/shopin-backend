// shopin-backend/db.js
const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
require('dotenv').config();

// Configure WebSockets for Node.js runtime environment
neonConfig.webSocketConstructor = ws;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  
  // Pooling Limits for Neon Cold Starts & Idle Timeouts
  max: 10,                        // Maximum active clients in pool
  idleTimeoutMillis: 30000,       // 👈 Increased to 30s to keep sockets warm longer
  connectionTimeoutMillis: 30000, // 👈 Increased to 30s to allow Neon to wake up
  ssl: true,                      // 👈 Explicitly enforce SSL connection
});

// Catch unexpected background errors on idle pool connections
pool.on('error', (err) => {
  console.warn('⚠️ Idle Neon connection warning:', err.message);
});

// Ping DB on startup to confirm credentials
pool.query('SELECT NOW()')
  .then(() => console.log('✅ Connected to Neon PostgreSQL Database!'))
  .catch(err => console.error('❌ Neon Database connection error:', err.message));

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(), // Supports our new wallet transactions!
  pool
};