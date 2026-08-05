// shopin-backend/test-db.js
const { query } = require('./db');

async function testConnection() {
  console.log('🔄 Connecting to Neon PostgreSQL...');
  try {
    // 1. Check current database timestamp and version
    const res = await query('SELECT NOW(), VERSION();');
    console.log('✅ Connected successfully!');
    console.log('⏰ Server Time:', res.rows[0].now);
    console.log('ℹ️ Postgres Version:', res.rows[0].version.split(' ')[0]);

    // 2. Test querying the food_pools table
    const poolRes = await query('SELECT COUNT(*) FROM food_pools;');
    console.log(`📊 Active Food Pools Count: ${poolRes.rows[0].count}`);

  } catch (err) {
    console.error('❌ Connection Failed!');
    console.error('Error Details:', err.message);
  } process.exit();
}

testConnection();
