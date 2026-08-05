// shopin-backend/run-schema.js
const fs = require('fs');
const path = require('path');
const { query } = require('./db');

async function applySchema() {
  console.log('🔄 Executing schema.sql on Neon PostgreSQL...');
  
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    await query(sql);
    console.log('✅ All tables, indexes, and seeded data applied successfully!');

    // Verify row count in food_pools
    const poolsRes = await query('SELECT COUNT(*) FROM food_pools');
    console.log(`📊 Food Pools Count: ${poolsRes.rows[0].count}`);

    // Verify row count in delivery_pools
    const deliveryRes = await query('SELECT COUNT(*) FROM delivery_pools');
    console.log(`🚚 Delivery Pools Count: ${deliveryRes.rows[0].count}`);

  } catch (err) {
    console.error('❌ Schema Execution Error:', err.message);
  } process.exit();
}

applySchema();
