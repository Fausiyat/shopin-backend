const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const db = require('./db');

// 1. Create platform_settings table
db.query(`
  CREATE TABLE IF NOT EXISTS platform_settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );
`).catch(err => console.error("Table creation error:", err.message));

// 2. Add is_verified column to users table
db.query(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
`).catch(err => console.error("User verification column error:", err.message));
const app = express();

// 3. Add Ratings to Vendor Products table
db.query(`
  ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS rating NUMERIC(3,1) DEFAULT 0.0;
  ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS review_count INT DEFAULT 0;
`).catch(err => console.error("Ratings column error:", err.message));

// 4. Setup Food Pools & Update Orders Table for Processing Fees
db.query(`
  CREATE TABLE IF NOT EXISTS food_pools (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      pool_title VARCHAR(100) NOT NULL,
      target_item_name VARCHAR(100) NOT NULL,
      sourcing_market VARCHAR(50) DEFAULT 'Mandate Market',
      total_slots INT NOT NULL,
      filled_slots INT DEFAULT 0,
      price_per_slot NUMERIC(10,2) NOT NULL,
      status VARCHAR(30) DEFAULT 'OPEN',
      expires_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );

  ALTER TABLE orders ADD COLUMN IF NOT EXISTS processing_fee NUMERIC(10,2) DEFAULT 0.00;
`).catch(err => console.error("Food Pools / Orders upgrade error:", err.message));

// 5. Setup Dynamic Marketplace Categories Table
db.query(`
  CREATE TABLE IF NOT EXISTS marketplace_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_name VARCHAR(50) UNIQUE NOT NULL,
    display_icon VARCHAR(50) DEFAULT '🛍️',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );

  -- Insert default tabs so they don't disappear
  INSERT INTO marketplace_categories (category_name) VALUES 
  ('Foodstuff'), ('Wearables'), ('Electronics'), ('AB&S Services')
  ON CONFLICT (category_name) DO NOTHING;
`).catch(err => console.error("Categories table error:", err.message));

// ⚡ ADD THIS 1 LINE RIGHT HERE:
app.set('trust proxy', 1);

// --- PRODUCTION CORS SETUP ---
const allowedOrigins = [
  'http://localhost:5173', // Local Vite dev server
  'http://localhost:3000',
  process.env.FRONTEND_URL
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Blocked by CORS policy: Origin not allowed.'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-pin']
};

app.use(cors(corsOptions));
app.options(/(.*)/, cors(corsOptions)); // Enable pre-flight across all routes
app.use(express.json());

// 🚦 PLACE RATE LIMITERS HERE (Right after express.json setup)
const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per 15 mins
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes.' }
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Limit AI parsing & SMS to 10 requests per minute
  message: { error: 'Rate limit exceeded for resource-heavy actions. Slow down!' }
});

// Apply them globally or to specific routes
app.use('/api/', apiLimiter);
app.use('/api/orders/parse-list', strictLimiter);
app.use('/api/notifications/send-sms', strictLimiter);

// 🔒 Secure Admin Middleware
const verifyAdminMiddleware = (req, res, next) => {
  const clientPin = req.headers['x-admin-pin'];
  const storedAdminPin = process.env.ADMIN_PIN || '1234';

  if (!clientPin || clientPin.trim() !== storedAdminPin.trim()) {
    return res.status(403).json({ error: 'Unauthorized: Admin access required.' });
  }
  next();
};

// 🔒 Upgraded Shopper or Admin Middleware (Checks Database for Dynamic Shopper PIN)
const verifyShopperOrAdminMiddleware = async (req, res, next) => {
  const clientPin = req.headers['x-admin-pin'] || req.headers['x-shopper-pin'];
  const validAdminPin = process.env.ADMIN_PIN || '1234';

  if (!clientPin) {
    return res.status(403).json({ error: 'Unauthorized: Access PIN required.' });
  }

  // If Admin PIN is used, grant access immediately
  if (clientPin.trim() === validAdminPin.trim()) {
    return next();
  }

  try {
    const pinQuery = await db.query("SELECT value FROM platform_settings WHERE key = 'shopper_pin'");
    const validShopperPin = pinQuery.rows.length > 0 ? pinQuery.rows[0].value : (process.env.SHOPPER_PIN || '5678');

    if (clientPin.trim() === validShopperPin.trim()) {
      return next();
    }
  } catch (err) {
    console.error("Error verifying shopper PIN from DB:", err.message);
  }

  return res.status(403).json({ error: 'Unauthorized: Invalid Shopper or Admin PIN.' });
};

// Route: Fetch all marketplace categories for frontend tabs
app.get('/api/marketplace/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT category_name FROM marketplace_categories ORDER BY created_at ASC');
    res.status(200).json({ status: 'success', categories: result.rows.map(r => r.category_name) });
  } catch (err) {
    console.error("Fetch Categories Error:", err.message);
    res.status(500).json({ error: 'Failed to fetch categories.' });
  }
});

// Route: Admin Add a brand new category (e.g. "House Agents")
app.post('/api/admin/categories', verifyAdminMiddleware, async (req, res) => {
  const { category_name } = req.body;
  if (!category_name) return res.status(400).json({ error: 'Category name is required.' });

  try {
    const result = await db.query(
      `INSERT INTO marketplace_categories (category_name) VALUES ($1) RETURNING *`,
      [category_name.trim()]
    );
    res.status(201).json({ status: 'success', message: `Category "${category_name}" created successfully!`, category: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'This category already exists.' });
    console.error("Create Category Error:", err.message);
    res.status(500).json({ error: 'Server error creating category.' });
  }
});

// Route: Admin Delete Market Price Entry
app.delete('/api/admin/prices/:id', verifyAdminMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query('DELETE FROM market_prices WHERE id = $1 RETURNING *', [id]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Price item not found in database.' });
    }
    
    res.json({
      status: 'success',
      message: 'Market price item deleted successfully!'
    });
  } catch (err) {
    console.error("Delete Market Price Error:", err.message);
    res.status(500).json({ error: 'Server error deleting price item.' });
  }
});

// Route: Update an item (Admin or Vendor)
app.put('/api/admin/vendor-products/:id', async (req, res) => {
  const { id } = req.params;
  const { product_name, price_ngn, category, service_type } = req.body;

  try {
    const result = await db.query(
      `UPDATE vendor_products 
       SET 
         product_name = COALESCE($1, product_name),
         price_ngn = COALESCE($2, price_ngn),
         category = COALESCE($3, category),
         service_type = COALESCE($4, service_type),
         updated_at = NOW()
       WHERE id::text = $5 OR shopin_id = $5
       RETURNING *;`,
      [product_name, price_ngn, category, service_type, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error('Update Product Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Route: Delete a vendor product
app.delete('/api/admin/vendor-products/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `DELETE FROM vendor_products WHERE id::text = $1 RETURNING *;`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    res.json({ success: true, message: 'Item deleted.' });
  } catch (err) {
    console.error('Delete Product Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Route: Save Dynamic Locations
app.put('/api/admin/locations', async (req, res) => {
  const { category, locations_array } = req.body;
  try {
    await db.query(
      `INSERT INTO dynamic_locations (category, locations)
       VALUES ($1, $2)
       ON CONFLICT (category) DO UPDATE SET locations = EXCLUDED.locations;`,
      [category, JSON.stringify(locations_array)]
    );
    res.json({ success: true, message: 'Locations saved to database.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Route: Update Vendor Bank Details (Admin or Vendor)
app.put('/api/admin/vendors/:id/bank-details', async (req, res) => {
  const { id } = req.params;
  const { bank_name, account_number, account_name } = req.body;

  if (!account_number || !bank_name) {
    return res.status(400).json({ error: 'Bank name and account number are required.' });
  }

  try {
    const result = await db.query(
      `UPDATE users 
       SET 
         bank_name = $1,
         account_number = $2,
         account_name = $3
       WHERE id::text = $4 OR shopin_id = $4
       RETURNING id, full_name, shopin_id, bank_name, account_number, account_name;`,
      [bank_name.trim(), account_number.trim(), account_name?.trim() || null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Vendor not found.' });
    }

    res.json({ 
      success: true, 
      message: 'Vendor bank details updated successfully!', 
      vendor: result.rows[0] 
    });
  } catch (err) {
    console.error('Update Vendor Bank Error:', err.message);
    res.status(500).json({ error: 'Failed to update bank details: ' + err.message });
  }
});

// 📱 EBULKSMS NOTIFICATION HELPER
const sendSMS = async (to, message) => {
  const email = process.env.EBULKSMS_EMAIL;
  const apiKey = process.env.EBULKSMS_API_KEY;
  const senderId = process.env.EBULKSMS_SENDER_ID || 'ShopIn';

  if (!email || !apiKey) {
    console.warn("⚠️ EbulkSMS credentials missing in backend .env!");
    return { status: 'failed', reason: 'Missing API key' };
  }

  // Ensure Nigerian phone numbers format (234...)
  let formattedPhone = to.trim();
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '234' + formattedPhone.slice(1);
  }

  const payload = {
    SMS: {
      auth: { username: email, apikey: apiKey },
      message: { sender: senderId, messagetext: message, flash: "0" },
      recipients: { gsm: [{ msidn: formattedPhone }] }
    }
  };

  try {
    const response = await axios.post('https://api.ebulksms.com/sendsms.json', payload);
    console.log(`✅ SMS dispatched to ${formattedPhone}:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`❌ EbulkSMS Error (${formattedPhone}):`, error.response?.data || error.message);
    throw error;
  }
};

// 🧠 SIMPLE IN-MEMORY CACHE FOR AI PARSING
const aiParseCache = new Map();
const CACHE_TTL = 1000 * 60 * 10; // Cache valid for 10 minutes

// Route 1: Health Check Test
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'ShopIn Engine Online' });
});
// Route: Verify Admin Passcode Securely
app.post('/api/admin/verify-pin', (req, res) => {
  const { pin } = req.body;
  const validAdminPin = process.env.ADMIN_PIN || '1234';

  if (!pin || pin.trim() !== validAdminPin) {
    return res.status(401).json({ error: 'Invalid admin passcode.' });
  }

  return res.status(200).json({ success: true, message: 'Admin verified successfully.' });
});

// Route 2: Register User & Auto-generate Kwara ShopIn ID
app.post('/api/users/register', async (req, res) => {
    try {
        const { full_name, phone_number, email } = req.body;

        if (!full_name || !phone_number) {
            return res.status(400).json({ error: 'Name and Phone Number are required.' });
        }

        const randomNum = Math.floor(1000 + Math.random() * 9000);
        const shopin_id = `SHP-ILR-${randomNum}`;

        const queryText = `
            INSERT INTO users (shopin_id, full_name, phone_number, email, user_role)
            VALUES ($1, $2, $3, $4, 'consumer')
            RETURNING *;
        `;
        const values = [shopin_id, full_name, phone_number, email || null];
        const result = await db.query(queryText, values);

        // 🔔 ADMIN ALERT: New Consumer Registered
        const adminPhone = process.env.ADMIN_PHONE_NUMBER || '08000000000';
        const smsAlert = `[ShopIn Admin Alert] 🎉 New Consumer Signed Up!\nName: ${full_name}\nID: ${shopin_id}\nPhone: ${phone_number}`;
        sendSMS(adminPhone, smsAlert).catch(err => console.warn("Admin SMS alert failed:", err.message));

        res.status(201).json({
            status: "success",
            message: 'Welcome to ShopIn Kwara!',
            user_data: result.rows[0]
        });
    } catch (err) {
        if (err.code === '23505') { 
            return res.status(400).json({ error: 'A user with this phone number already exists.' });
        }
        console.error(err.message);
        res.status(500).json({ error: 'Server error while registering user.' });
    }
});

// Route 2b: Register Vendor (With Bank Details & Error Handling)
app.post('/api/vendors/register', async (req, res) => {
    const { 
        full_name, 
        phone_number, 
        email, 
        vendor_category, 
        contact_mode = 'MIDDLEMAN',
        bank_name,
        account_number,
        account_name
    } = req.body;

    if (!full_name || !phone_number || !vendor_category) {
        return res.status(400).json({ error: 'Full name, phone number, and vendor category are required.' });
    }

    try {
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        const shopin_id = `VND-ILR-${randomNum}`;

        const queryText = `
            INSERT INTO users (
                shopin_id, 
                full_name, 
                phone_number, 
                email, 
                user_role, 
                vendor_category, 
                contact_mode, 
                is_verified,
                bank_name,
                account_number,
                account_name
            )
            VALUES ($1, $2, $3, $4, 'vendor', $5, $6, FALSE, $7, $8, $9)
            RETURNING *;
        `;
        const values = [
            shopin_id, 
            full_name.trim(), 
            phone_number.trim(), 
            email ? email.trim() : null, 
            vendor_category, 
            contact_mode.toUpperCase(),
            bank_name ? bank_name.trim() : null,
            account_number ? account_number.trim() : null,
            account_name ? account_name.trim() : null
        ];
        const result = await db.query(queryText, values);

        // 🔔 ADMIN ALERT: New Vendor Awaiting Approval
        const adminPhone = process.env.ADMIN_PHONE_NUMBER || '08143086509';
        const smsAlert = `[ShopIn Admin] ⚠️ NEW VENDOR PENDING APPROVAL!\nBusiness: ${full_name}\nCategory: ${vendor_category}\nReview in Admin Console.`;
        
        if (typeof sendSMS === 'function') {
            sendSMS(adminPhone, smsAlert).catch(err => console.warn("Admin SMS alert failed:", err.message));
        }

        res.status(201).json({
            status: "success",
            message: "Registration received! Your account is pending admin verification.",
            vendor_data: result.rows[0]
        });
    } catch (err) {
        if (err.code === '23505') { 
            return res.status(400).json({ error: 'A user or vendor with this phone number already exists.' });
        }
        console.error("Vendor Register Error:", err.message);
        res.status(500).json({ error: 'Server error while registering vendor: ' + err.message });
    }
});

// 🔒 ADMIN: Fetch Unverified Pending Vendors
// 🔒 ADMIN: Fetch All Vendors (Pending & Active) With Bank Details
app.get('/api/admin/pending-vendors', verifyAdminMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        id, shopin_id, full_name, phone_number, email, 
        vendor_category, contact_mode, is_verified, created_at,
        bank_name, account_number, account_name
      FROM users 
      WHERE user_role = 'vendor' OR shopin_id LIKE 'VND-%'
      ORDER BY created_at DESC;
    `);
    
    // Returning both 'pending_vendors' and 'vendors' keys ensures the frontend gets the data
    res.status(200).json({ 
      status: 'success', 
      pending_vendors: result.rows,
      vendors: result.rows 
    });
  } catch (err) {
    console.error("Fetch Vendors Error:", err.message);
    res.status(500).json({ error: "Failed to fetch vendors." });
  }
});

// 🔒 ADMIN: Approve and Verify Vendor
app.put('/api/admin/vendors/:id/verify', verifyAdminMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(`
      UPDATE users 
      SET is_verified = TRUE 
      WHERE id = $1 AND user_role = 'vendor' 
      RETURNING *;
    `, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Vendor not found.' });
    }

    res.status(200).json({
      status: 'success',
      message: 'Vendor verified and activated successfully!',
      vendor: result.rows[0]
    });
  } catch (err) {
    console.error("Verify Vendor Error:", err.message);
    res.status(500).json({ error: 'Server error verifying vendor.' });
  }
});

// Route: Delete / Reject Unverified Vendor
app.delete('/api/admin/vendors/:identifier', async (req, res) => {
  const { identifier } = req.params;

  try {
    // Delete any unverified products linked to this vendor first
    await db.query(
      `DELETE FROM vendor_products 
       WHERE vendor_id IN (SELECT id FROM users WHERE id::text = $1 OR shopin_id = $1);`,
      [identifier]
    );

    // Delete the vendor profile from the users table
    const result = await db.query(
      `DELETE FROM users 
       WHERE (id::text = $1 OR shopin_id = $1) AND user_role = 'vendor' 
       RETURNING *;`,
      [identifier]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Vendor not found.' });
    }

    res.json({ success: true, message: 'Vendor rejected and deleted successfully.' });
  } catch (err) {
    console.error('Delete Vendor Error:', err.message);
    res.status(500).json({ error: 'Failed to delete vendor: ' + err.message });
  }
});

// Route 3: Save Delivery Address
app.post('/api/users/address', async (req, res) => {
    try {
        const { address_label, zone_name, major_checkpoint, detailed_address } = req.body;
        const shopin_id = req.body.shopin_id ? req.body.shopin_id.trim() : null;

        if (!shopin_id || !zone_name || !major_checkpoint || !detailed_address) {
            return res.status(400).json({ error: 'Missing required address details or ShopIn ID.' });
        }

        const userResult = await db.query('SELECT id FROM users WHERE shopin_id = $1', [shopin_id]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: "We couldn't find a user with that ShopIn ID." });
        }

        const userId = userResult.rows[0].id;

        const addressResult = await db.query(
            'INSERT INTO user_addresses (user_id, address_label, zone_name, major_checkpoint, detailed_address) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [userId, address_label || 'HOME', zone_name, major_checkpoint, detailed_address]
        );

        res.status(201).json({ 
            message: "Address saved successfully!", 
            address: addressResult.rows[0] 
        });

    } catch (err) {
        console.error("Error saving address:", err.message);
        res.status(500).json({ error: "Server error while saving address.", details: err.message });
    }
});

// Route 4: AI Grocery List Parser (Groq Engine)
app.post('/api/orders/parse-list', async (req, res) => {
  const raw_text = req.body.raw_text || req.body.text || req.body.rawText;

  if (!raw_text || typeof raw_text !== 'string' || !raw_text.trim()) {
    return res.status(400).json({ 
      status: 'error', 
      error: 'raw_text is required and must be a non-empty string.' 
    });
  }

  const cacheKey = raw_text.trim().toLowerCase();

  if (aiParseCache.has(cacheKey)) {
    console.log(`⚡ CACHE HIT for query: "${raw_text}"`);
    const cachedData = aiParseCache.get(cacheKey);
    return res.status(200).json({
      status: 'success',
      items: cachedData.items,
      parsed_data: { ...cachedData, is_cache: true }
    });
  }

 const systemInstruction = `
    You are the ShopIn Local Grocery, Goods & Micro-Services Parsing AI for Ilorin, Kwara State.
    Parse unstructured text input into a JSON object.

    CRITICAL RULE - YOU MUST FOLLOW THIS EXACT JSON OUTPUT STRUCTURE:
    {
      "items": [
        {
          "item_name": "Tomatoes",
          "quantity": 500,
          "unit": "naira_value",
          "category": "Produce",
          "notes": null
        }
      ],
      "is_service_request": false,
      "unrecognized_tokens": []
    }

    NIGERIAN MARKET RULES (CRITICAL):
    - Understand local measurement units: "paint rubber", "paint", "mudu", "module", "congo", "tuber". 
    - DO NOT treat "paint" or "rubber" as a separate item (e.g., "2 paint rubber garri" means item_name: "Garri", quantity: 2, unit: "paint_rubber").
    - "tuber" refers to Yams or Sweet Potatoes. (e.g., "5 tubers of yam" means item_name: "Yam", quantity: 5, unit: "tuber").
    - Always output a root JSON object with an "items" array.
    - "item_name" MUST ONLY contain clean product names (e.g., "Garri Ijebu", "Yam", "Chicken").
    - Extract Naira amounts (e.g. "500 naira tomatoes") with quantity: 500 and unit: "naira_value".
  `;

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-70b-versatile',
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: raw_text }
        ],
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const parsedOutput = JSON.parse(response.data.choices[0].message.content);

    // 🛡️ SMART ARRAY NORMALIZER: Guarantees items is never empty if an array exists
    let extractedItems = [];
    if (Array.isArray(parsedOutput)) {
      extractedItems = parsedOutput;
    } else if (Array.isArray(parsedOutput.items)) {
      extractedItems = parsedOutput.items;
    } else {
      // Find any array property inside parsedOutput if "items" was renamed
      const arrayKey = Object.keys(parsedOutput).find(key => Array.isArray(parsedOutput[key]));
      if (arrayKey) extractedItems = parsedOutput[arrayKey];
    }

    const finalResult = {
      items: extractedItems,
      is_service_request: parsedOutput.is_service_request || false,
      unrecognized_tokens: parsedOutput.unrecognized_tokens || []
    };

    aiParseCache.set(cacheKey, finalResult);

    return res.status(200).json({
      status: 'success',
      items: extractedItems,
      parsed_data: { ...finalResult, is_mock: false }
    });

  } catch (err) {
    console.error('--- GROQ PARSING ERROR LOG ---', err.response?.data || err.message);

    // Local Regex Fallback
    const rawItems = raw_text.split(/\s*(?:and|,|\+|\n)\s*/i).filter(Boolean);
    const mockItems = rawItems.map(raw => ({
      item_name: raw.trim(),
      quantity: 1,
      unit: "unit",
      category: "General",
      notes: "Parsed via fallback"
    }));

    return res.status(200).json({
      status: 'success',
      items: mockItems,
      parsed_data: { items: mockItems, is_service_request: false, unrecognized_tokens: [], is_mock: true },
      is_mock: true
    });
  }
});

// Route 4b: Save Order directly from Frontend
app.post('/api/orders', async (req, res) => {
  const { 
    user_id,
    shopin_id, 
    channel = 'WEB', 
    raw_input_text, 
    parsed_json, 
    delivery_fee = 1500, 
    service_fee = 500,
    processing_fee = 0,
    estimated_item_cost,
    estimated_total,
    deposit_paid
  } = req.body;

  if (!raw_input_text || !parsed_json || !parsed_json.items) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'raw_input_text and valid parsed_json are required.' 
    });
  }

  try {
    // 1. Resolve User ID (UUID) if shopin_id was sent from localStorage
    let resolvedUserId = user_id || null;
    if (!resolvedUserId && shopin_id) {
      const userRes = await db.query(
        `SELECT id FROM users WHERE shopin_id = $1 LIMIT 1;`, 
        [shopin_id.trim()]
      );
      if (userRes.rows.length > 0) {
        resolvedUserId = userRes.rows[0].id;
      }
    }

    // 2. Use the client's verified pricing or fallback to server estimates
    let finalItemCost = estimated_item_cost;
    if (finalItemCost === undefined || finalItemCost === null) {
      const ESTIMATED_PRICES = {
        // Bulk Staple Units
        full_bag: 82000,
        half_bag: 41000,
        quarter_bag: 21000,
        keg_25l: 38000,
        keg_5l: 8500,
        crate: 4500,
        basket: 6000,

        // Standard Market Measures
        paint_rubber: 2800,
        derica: 1200,
        congo: 2200,
        module: 1600,
        mudu: 1600,
        tuber: 2500,

        // Everyday Provisions & Packaged Goods
        refill: 3500,
        pack: 2500,
        roll: 1800,
        carton: 12500,
        bottle: 1200,
        can: 900,
        piece: 800,
        pieces: 800,
        unit: 1500,         // 👈 Safe default for 'unit'
        default: 1500       // 👈 Prevents unknown items from defaulting to 82,000
      };

      finalItemCost = parsed_json.items.reduce((sum, item) => {
        const unitKey = item.unit?.toLowerCase() || 'default';
        const unitPrice = item.price || ESTIMATED_PRICES[unitKey] || ESTIMATED_PRICES.default;
        return sum + ((item.quantity || 1) * unitPrice);
      }, 0);
    }

    const finalTotalCost = estimated_total ?? (finalItemCost + Number(delivery_fee) + Number(service_fee) + Number(processing_fee));
    const initialDepositPaid = deposit_paid ?? finalTotalCost;
    const order_code = `ORD-${Math.floor(10000 + Math.random() * 90000)}`;

    // 3. Insert order including deposit_paid
    const queryText = `
      INSERT INTO orders (
        order_code, 
        user_id, 
        channel, 
        raw_input_text, 
        parsed_json,
        estimated_item_cost, 
        service_fee, 
        delivery_fee, 
        total_estimated_cost, 
        deposit_paid,
        order_status
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING_CONFIRMATION')
      RETURNING *;
    `;

    const values = [
      order_code,
      resolvedUserId,
      channel,
      raw_input_text,
      typeof parsed_json === 'string' ? parsed_json : JSON.stringify(parsed_json),
      finalItemCost,
      service_fee,
      delivery_fee,
      finalTotalCost,
      initialDepositPaid,
      'PENDING_CONFIRMATION'
    ];

    const result = await db.query(queryText, values);

    return res.status(201).json({
      status: 'success',
      message: 'Order created successfully!',
      order: result.rows[0]
    });

  } catch (err) {
    console.error('--- CREATE ORDER ERROR ---', err);
    return res.status(500).json({ 
      status: 'error', 
      message: 'Failed to create order.', 
      details: err.message 
    });
  }
});

// 🔒 PROTECTED ADMIN ROUTE: User & Vendor Tracker Directory (Secured with Middleware)
app.get('/api/admin/users', verifyAdminMiddleware, async (req, res) => {
  try {
    const statsQuery = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE user_role = 'consumer') AS total_buyers,
        COUNT(*) FILTER (WHERE user_role = 'vendor') AS total_vendors,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS signups_today,
        COUNT(*) AS total_platform_users
      FROM users
      WHERE shopin_id != 'GUEST-WEB';
    `);

    const usersDirectoryQuery = await db.query(`
      SELECT 
        u.id, u.shopin_id, u.full_name, u.phone_number, u.email, 
        u.user_role, u.vendor_category, u.contact_mode, u.created_at,
        COALESCE(w.available_balance, 0.00) AS wallet_balance
      FROM users u
      LEFT JOIN stash_wallets w ON u.id = w.user_id
      WHERE u.shopin_id != 'GUEST-WEB'
      ORDER BY u.created_at DESC;
    `);

    res.status(200).json({
      status: 'success',
      metrics: statsQuery.rows[0],
      users: usersDirectoryQuery.rows
    });
  } catch (err) {
    console.error("User Tracking Endpoint Error:", err.message);
    res.status(500).json({ error: "Failed to fetch platform user metrics." });
  }
});

// Route 5: Admin - Add Market Price Entry
app.post('/api/admin/prices', async (req, res) => {
    const { item_name, category, unit, min_price_ngn, max_price_ngn, brand_or_variant, is_variable_budget, sourcing_market, fallback_market } = req.body;

    try {
        const queryText = `
            INSERT INTO market_prices (item_name, category, unit, brand_or_variant, min_price_ngn, max_price_ngn, is_variable_budget, sourcing_market, fallback_market)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *;
        `;
        const values = [
            item_name.toLowerCase(), 
            category, 
            unit, 
            brand_or_variant || 'Standard',
            min_price_ngn || 0, 
            max_price_ngn || 0, 
            is_variable_budget || false,
            sourcing_market || 'Mandate',
            fallback_market || 'Ipata'
        ];
        
        const result = await db.query(queryText, values);
        res.status(201).json({
            message: 'Market price logged successfully!',
            price_data: result.rows[0]
        });
    } catch (err) {
        console.error("Insert Market Price Error:", err.message);
        res.status(500).json({ error: 'Failed to insert market price.' });
    }
});

// Route 5b: PUT /api/admin/prices/update - Price Range Update
app.put('/api/admin/prices/update', async (req, res) => {
  const { id, item_name, unit, brand_or_variant, min_price_ngn, max_price_ngn } = req.body;

  try {
    let result;
    if (id) {
      result = await db.query(
        `UPDATE market_prices 
         SET min_price_ngn = $1, max_price_ngn = $2, last_updated = CURRENT_TIMESTAMP 
         WHERE id = $3 RETURNING *`,
        [min_price_ngn, max_price_ngn, id]
      );
    } else {
      result = await db.query(
        `UPDATE market_prices 
         SET min_price_ngn = $1, max_price_ngn = $2, last_updated = CURRENT_TIMESTAMP 
         WHERE LOWER(item_name) = LOWER($3) AND LOWER(unit) = LOWER($4) AND LOWER(brand_or_variant) = LOWER($5)
         RETURNING *`,
        [min_price_ngn, max_price_ngn, item_name, unit, brand_or_variant || 'Standard']
      );
    }

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Item price entry not found.' });
    }

    res.json({
      status: 'success',
      message: 'Price range updated successfully!',
      updated_data: result.rows[0]
    });
  } catch (err) {
    console.error('Error updating market price:', err);
    res.status(500).json({ error: 'Server error updating price range.' });
  }
});

// 🌟 ADMIN ROUTE: CREDIT USER WALLET (REFUNDS & CHANGE)
app.post('/api/admin/credit-wallet', async (req, res) => {
  const { shopin_id, amount } = req.body;
  const adminPin = req.headers['x-admin-pin'];

  // 1. Basic Admin Security Check
  const VALID_PIN = process.env.ADMIN_PIN || '1234'; 
  if (adminPin !== VALID_PIN) {
    return res.status(403).json({ error: 'Unauthorized: Invalid Admin PIN' });
  }

  // 2. Validate input
  if (!shopin_id || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid ShopIn ID or Amount' });
  }

  try {
    // 3. Find the user AND their attached wallet ID at the same time
    const userQuery = await db.query(`
      SELECT u.id AS user_id, w.id AS wallet_id 
      FROM users u
      JOIN stash_wallets w ON u.id = w.user_id
      WHERE u.shopin_id = $1
    `, [shopin_id]);
    
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ error: 'User or wallet not found in database.' });
    }

    const { user_id, wallet_id } = userQuery.rows[0];

    // 4. Update the exact Stash Wallet attached to this user
    await db.query(
      'UPDATE stash_wallets SET available_balance = available_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
      [amount, user_id]
    );

    // 5. 🌟 BONUS: Write a receipt to your wallet_transactions ledger!
    const refCode = `REFUND-${Date.now()}`;
    await db.query(
      `INSERT INTO wallet_transactions 
       (wallet_id, transaction_type, amount, reference_code, status, narration) 
       VALUES ($1, 'REFUND', $2, $3, 'SUCCESS', 'Admin Wallet Refund / Market Overage')`,
      [wallet_id, amount, refCode]
    );

    res.status(200).json({ 
      success: true, 
      message: `Successfully credited ₦${amount} to ${shopin_id}.` 
    });

  } catch (error) {
    console.error('Wallet Credit Error:', error);
    res.status(500).json({ error: 'Internal server error while crediting wallet.' });
  }
});

// Route 6: Order Quote Calculator
app.post('/api/orders/quote', async (req, res) => {
    try {
        const { items, zone_name } = req.body;
        let totalEstimatedCost = 0;
        let receipt = [];

        for (let i = 0; i < items.length; i++) {
            const currentItem = items[i];
            const priceQuery = await db.query(
                'SELECT min_price_ngn, max_price_ngn FROM market_prices WHERE item_name ILIKE $1 LIMIT 1',
                [`%${currentItem.item_name}%`]
            );

            if (priceQuery.rows.length > 0) {
                const itemPrice = parseFloat(priceQuery.rows[0].max_price_ngn);
                const itemTotal = itemPrice * currentItem.quantity;
                
                totalEstimatedCost += itemTotal;
                receipt.push({
                    name: currentItem.item_name,
                    quantity: currentItem.quantity,
                    cost: itemTotal
                });
            }
        }

        const deliveryFee = 1500;
        const serviceFee = 500;
        const grandTotal = totalEstimatedCost + deliveryFee + serviceFee;

        res.status(200).json({
            status: "success",
            zone: zone_name,
            breakdown: receipt,
            delivery_fee: deliveryFee,
            service_fee: serviceFee,
            grand_total: grandTotal
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server Error calculating quote." });
    }
});

// 🚀 Route 7: UPGRADED CREATE MASTER ORDER (Now with Wallet Deductions!)
app.post('/api/orders/create', async (req, res) => {
    const raw_text = req.body.raw_input_text || "Web Order";
    const channel = req.body.channel || 'WEB';
    const shopin_id = req.body.shopin_id ? req.body.shopin_id.trim() : null;
    const deposit_paid = req.body.deposit_paid || 0; // How much the user is paying now

    // We use a "client" here to lock the database so money doesn't go missing if the internet drops
    const client = await db.getClient(); 

    try {
        await client.query('BEGIN'); // Start the safe transaction

        // 1. Find the User
        let userId = null;
        if (shopin_id) {
            const userQuery = await client.query('SELECT id FROM users WHERE shopin_id = $1', [shopin_id]);
            if (userQuery.rows.length > 0) userId = userQuery.rows[0].id;
        }

        // 2. Move the money between the Jars! (If they are paying a deposit)
        if (userId && deposit_paid > 0) {
            const walletQuery = await client.query(
                'SELECT available_balance FROM stash_wallets WHERE user_id = $1 FOR UPDATE', 
                [userId]
            );
            
            if (walletQuery.rows.length === 0 || walletQuery.rows[0].available_balance < deposit_paid) {
                throw new Error("Insufficient funds in Liquid Stash!");
            }

            // Take from Liquid (available) and put into Safe (escrow)
            await client.query(`
                UPDATE stash_wallets 
                SET available_balance = available_balance - $1, 
                    escrow_balance = escrow_balance + $1,
                    last_updated = CURRENT_TIMESTAMP
                WHERE user_id = $2
            `, [deposit_paid, userId]);
        }

        // 3. Calculate Totals
        const parsedOutput = req.body.parsed_json || { items: [] };
        const deliveryFee = req.body.delivery_fee || 1500;
        const serviceFee = req.body.service_fee || 500;
        // 🌟 NEW: Grab the processing fee!
        const processingFee = req.body.processing_fee || 0;
        const grandTotal = req.body.estimated_total || 0;
        const estimatedItemCost = req.body.estimated_item_cost || 0;
        const orderCode = `ORD-${Math.floor(10000 + Math.random() * 90000)}`;

        // 4. Save the Order Receipt (CORRECTED)
        const insertOrderQuery = `
            INSERT INTO orders (
                order_code, user_id, channel, raw_input_text, parsed_json, 
                estimated_item_cost, service_fee, delivery_fee, processing_fee, total_estimated_cost, order_status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *;
        `;
        const orderValues = [
          orderCode, 
          userId, 
          channel, 
          raw_text, 
          JSON.stringify(parsedOutput), 
          estimatedItemCost, 
          serviceFee, 
          deliveryFee, 
          processingFee, 
          grandTotal, 
          'PENDING_CONFIRMATION'
        ];
        const savedOrder = await client.query(insertOrderQuery, orderValues);

        await client.query('COMMIT'); // Success! Save everything.
        client.release();

        return res.status(201).json({
            status: "success",
            message: deposit_paid > 0 ? "Order created and deposit held safely in escrow!" : "Order created!",
            order: savedOrder.rows[0]
        });

    } catch (err) {
        await client.query('ROLLBACK'); // Oh no, an error! Put the money back and cancel the order.
        client.release();
        console.error("Master Order Creation Error:", err.message);
        return res.status(500).json({ status: "error", error: err.message });
    }
});

// Route 8: WhatsApp & SMS Webhook Bot
app.post('/api/webhooks/sms', async (req, res) => {
    try {
        const senderPhone = req.body.from || req.body.phoneNumber || req.body.phone;
        const rawTextMessage = req.body.text || req.body.body || req.body.message;

        if (!senderPhone || !rawTextMessage) {
            return res.status(400).json({ error: 'Missing phone number or message text.' });
        }

        console.log(`\n💬 INCOMING BOT MESSAGE from ${senderPhone}: "${rawTextMessage}"`);

        let userId = null;
        let formattedPhone = senderPhone.trim();
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '234' + formattedPhone.slice(1);
        }

        const userQuery = await db.query(
            'SELECT id, shopin_id, full_name FROM users WHERE phone_number LIKE $1 LIMIT 1', 
            [`%${senderPhone.slice(-10)}%`]
        );

        if (userQuery.rows.length > 0) {
            userId = userQuery.rows[0].id;
            console.log(`👤 Recognized User: ${userQuery.rows[0].full_name} (${userQuery.rows[0].shopin_id})`);
        } else {
            console.log(`👤 Unregistered User (${senderPhone}) — processing as Guest`);
        }

        let parsedItems = [];
        try {
            const systemInstruction = `You are the ShopIn Local Grocery Parsing AI for Ilorin, Kwara State. Parse unstructured text input into a JSON object.

                                        CRITICAL RULE - YOU MUST FOLLOW THIS EXACT JSON OUTPUT STRUCTURE:
                                        {
                                          "items": [
                                            {
                                              "item_name": "Tomatoes",
                                              "quantity": 500,
                                              "unit": "naira_value",
                                              "category": "Produce",
                                              "notes": null
                                            }
                                          ],
                                          "is_service_request": false,
                                          "unrecognized_tokens": []
                                        }

                                        RESTRICTED MEASUREMENT UNITS (YOU MUST ONLY USE THESE EXACT STRINGS):
                                        - Grains & Staples: "full_bag", "half_bag", "1/4_bag", "1/8_bag", "paint_rubber", "mudu", "cup"
                                        - Liquids & Oils: "25_litres", "12.5_litres", "5_litres", "75cl", "refill"
                                        - Proteins & Solids: "kg", "1/2kg", "tuber", "pieces", "bunch"
                                        - Packaged Goods: "carton", "pack", "roll", "crate", "basket", "half_basket", "dozen"
                                        - Custom: "naira_value", "plate", "sachet", "unit"

                                        NIGERIAN MARKET RULES:
                                        - Never invent a unit. Map words like "congo", "paint", or "rubber" strictly to "paint_rubber" or "mudu".
                                        - 5 tubers of yam = item_name: "Yam", quantity: 5, unit: "tuber".
                                        - "500 naira tomatoes" = quantity: 500, unit: "naira_value".
                                        - "item_name" MUST ONLY contain clean product names (e.g., "Garri", "Yam", "Spaghetti").
                                      `;
            // ⚡ GROQ / OPENAI COMPATIBLE API CALL
            const response = await axios.post(
              'https://api.groq.com/openai/v1/chat/completions',
              {
                model: 'llama-3.1-70b-versatile',
                messages: [
                  { role: 'system', content: systemInstruction },
                  { role: 'user', content: rawTextMessage }
                ],
                response_format: { type: 'json_object' }
              },
              {
                headers: {
                  'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                  'Content-Type': 'application/json'
                }
              }
            );
            
            const parsedData = JSON.parse(response.data.choices[0].message.content);
            parsedItems = parsedData.items || [];
        } catch (aiErr) {
            console.warn("AI parsing fallback for SMS bot:", aiErr.response?.data || aiErr.message);
            parsedItems = [{ item_name: rawTextMessage.trim(), quantity: 1, unit: 'unit', category: 'General' }];
        }

        const deliveryFee = 1500;
        const serviceFee = 500;
        let estimatedItemCost = 0;

        for (let item of parsedItems) {
            const priceQuery = await db.query(
                'SELECT max_price_ngn FROM market_prices WHERE item_name ILIKE $1 LIMIT 1',
                [`%${item.item_name}%`]
            );
            const unitPrice = priceQuery.rows.length > 0 ? parseFloat(priceQuery.rows[0].max_price_ngn) : 1800;
            estimatedItemCost += unitPrice * (item.quantity || 1);
        }

        const grandTotal = estimatedItemCost + deliveryFee + serviceFee;
        const orderCode = `BOT-${Math.floor(10000 + Math.random() * 90000)}`;

        const insertOrder = `
            INSERT INTO orders (
                order_code, user_id, channel, raw_input_text, parsed_json, 
                estimated_item_cost, service_fee, delivery_fee, total_estimated_cost, order_status
            )
            VALUES ($1, $2, 'SMS_BOT', $3, $4, $5, $6, $7, $8, 'PENDING_CONFIRMATION')
            RETURNING id;
        `;
        
        await db.query(insertOrder, [
            orderCode, 
            userId, 
            rawTextMessage, 
            JSON.stringify({ items: parsedItems }), 
            estimatedItemCost, 
            serviceFee, 
            deliveryFee, 
            grandTotal
        ]);

        const itemsSummary = parsedItems.map(i => `${i.quantity}x ${i.item_name}`).join(', ');
        const replyMessage = `[ShopIn Kwara] Order Received! 🛒\nItems: ${itemsSummary}\nEst. Total: ₦${grandTotal.toLocaleString()} (incl. N1500 delivery).\nOrder Code: ${orderCode}.\nPay now: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`;

        try {
            await sendSMS(formattedPhone, replyMessage);
        } catch (smsErr) {
            console.warn("Termii SMS notification failed:", smsErr.message);
        }

        res.status(200).json({
            status: "success",
            message: "SMS parsed and dynamic reply dispatched to user!",
            order_code: orderCode,
            grand_total: grandTotal
        });

    } catch (err) {
        console.error("SMS Webhook Bot Error:", err.message);
        res.status(500).json({ error: "Server error handling SMS bot order.", details: err.message });
    }
});

// Route 9: Outbound SMS Receipt Engine
app.post('/api/notifications/send-receipt', async (req, res) => {
    const { order_code, phone_number, grand_total } = req.body;

    if (!order_code || !phone_number || !grand_total) {
        return res.status(400).json({ error: 'Missing required fields for SMS.' });
    }

    const smsText = `ShopIn Kwara: Your order ${order_code} is received! Estimated Total: N${grand_total}. Reply YES to confirm or CANCEL to abort.`;
    console.log(`\n📤 OUTBOUND SMS to ${phone_number}:\n"${smsText}"\n`);

    try {
      await sendSMS(phone_number, smsText);
    } catch (e) {
      console.warn("Termii send skipped/failed:", e.message);
    }

    res.status(200).json({
        status: "success",
        message: "Receipt dispatched successfully to user's phone.",
        sms_content: smsText
    });
});

// Route 9b: TERMII AUTOMATED TRANSACTIONAL SMS DISPATCHER
app.post('/api/notifications/send-sms', async (req, res) => {
  const { phone, type, amount, reference } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  let message = '';
  if (type === 'DEPOSIT') {
    message = `[ShopIn] Alert: Your deposit of ₦${Number(amount || 0).toLocaleString()} was successful! Ref: ${reference}. Wallet balance updated.`;
  } else if (type === 'TARGET_DISPATCH') {
    message = `[ShopIn] 🎉 Target Goal Reached! Your savings total ₦${Number(amount || 0).toLocaleString()} has been dispatched for Mandate Market delivery!`;
  } else {
    message = `[ShopIn] Notification: Transaction of ₦${Number(amount || 0).toLocaleString()} recorded. Ref: ${reference}`;
  }

  try {
    const result = await sendSMS(phone, message);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send SMS', details: err.message });
  }
});

// Route 10: Setup Seller Marketplace & Media Schema
app.get('/api/admin/setup-phase2', async (req, res) => {
    try {
        const createVendorProducts = `
            CREATE TABLE IF NOT EXISTS vendor_products (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                vendor_id UUID REFERENCES users(id) ON DELETE CASCADE,
                product_name VARCHAR(100) NOT NULL,
                category VARCHAR(50) NOT NULL,
                price_ngn NUMERIC(10,2),
                stock_quantity INT DEFAULT 1,
                image_url TEXT,
                brand_or_variant VARCHAR(100),
                service_type VARCHAR(50) DEFAULT 'product',
                is_pickup_available BOOLEAN DEFAULT TRUE,
                allow_direct_contact BOOLEAN DEFAULT FALSE,
                is_verified BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;

        const createEscrowTable = `
            CREATE TABLE IF NOT EXISTS escrow_transactions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
                buyer_id UUID REFERENCES users(id),
                vendor_id UUID REFERENCES users(id),
                amount_held NUMERIC(10,2) NOT NULL,
                status VARCHAR(30) DEFAULT 'HELD_IN_ESCROW',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;

        await db.query(createVendorProducts);
        await db.query(createEscrowTable);

        res.status(200).json({
            status: "success",
            message: "Vendor Products & Escrow tables verified successfully!"
        });
    } catch (err) {
        console.error("Phase 2 DB Setup Error:", err.message);
        res.status(500).json({ error: "Failed to create Phase 2 tables." });
    }
});

// Route 11: Add Vendor Product or Service
app.post('/api/vendors/products', async (req, res) => {
    const { 
      shopin_id, 
      product_name, 
      category, 
      price_ngn, 
      stock_quantity, 
      image_url, 
      brand_or_variant, 
      service_type = 'product',
      is_pickup_available = true,
      allow_direct_contact = false
    } = req.body;

    if (!shopin_id || !product_name || !category) {
        return res.status(400).json({ error: 'ShopIn ID, item name, and category are required.' });
    }

    try {
        const vendorQuery = await db.query('SELECT id, contact_mode FROM users WHERE shopin_id = $1', [shopin_id.trim()]);
        
        if (vendorQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Vendor not found. Please register first.' });
        }
        const vendor = vendorQuery.rows[0];

        if (vendor.contact_mode === 'MIDDLEMAN' && service_type !== 'service' && (!price_ngn || Number(price_ngn) <= 0)) {
          return res.status(400).json({ error: 'Price is required for middleman product listings.' });
        }

        const insertQuery = `
            INSERT INTO vendor_products (vendor_id, product_name, category, price_ngn, stock_quantity, image_url, brand_or_variant, service_type, is_pickup_available, allow_direct_contact)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *;
        `;
        const values = [
          vendor.id, 
          product_name, 
          category, 
          price_ngn ? parseFloat(price_ngn) : null, 
          stock_quantity || 1,
          image_url || null,
          brand_or_variant || null,
          service_type,
          is_pickup_available,
          allow_direct_contact || vendor.contact_mode === 'DIRECT'
        ];
        
        const newProduct = await db.query(insertQuery, values);

        res.status(201).json({
            status: "success",
            message: `Listed successfully under ${category}!`,
            product: newProduct.rows[0]
        });
    } catch (err) {
        console.error("Vendor Product Error:", err.message);
        res.status(500).json({ error: "Server error while listing vendor item." });
    }
});

// Route: Submit a Vendor / Product Review
app.post('/api/vendors/reviews', async (req, res) => {
    const { product_id, rating } = req.body;

    if (!product_id || !rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Valid Product ID and a rating between 1 and 5 are required.' });
    }

    try {
        // This clever SQL updates the rolling average rating and adds 1 to the review count instantly!
        const updateQuery = `
            UPDATE vendor_products 
            SET 
                rating = CASE 
                    WHEN review_count = 0 THEN $1::numeric
                    ELSE ((rating * review_count) + $1::numeric) / (review_count + 1)
                END,
                review_count = review_count + 1
            WHERE id = $2 
            RETURNING rating, review_count;
        `;
        
        const result = await db.query(updateQuery, [rating, product_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product or Service not found.' });
        }

        res.status(200).json({
            status: "success",
            message: "Thank you! Your review has been saved.",
            new_stats: result.rows[0]
        });

    } catch (err) {
        console.error("Review Submission Error:", err.message);
        res.status(500).json({ error: "Server error while saving your review." });
    }
});

// Update Route: Fetch All Verified Vendor Products & Services (WITH BANK DETAILS)
app.get('/api/vendors/products', async (req, res) => {
    try {
        const queryText = `
            SELECT 
              vp.*, 
              u.shopin_id,
              u.full_name as vendor_name, 
              u.phone_number,
              u.bank_name,
              u.account_number,
              u.account_name
            FROM vendor_products vp
            JOIN users u ON vp.vendor_id = u.id
            WHERE u.is_verified = TRUE
            ORDER BY vp.created_at DESC;
        `;
        const result = await db.query(queryText);
        res.status(200).json({ status: "success", data: result.rows });
    } catch (err) {
        console.error("Fetch Vendor Products Error:", err.message);
        res.status(500).json({ error: "Failed to fetch marketplace catalog." });
    }
});

// Route: Pay ₦200 Fee to Unlock Vendor Contact
app.post('/api/services/book-contact', async (req, res) => {
    const { buyer_shopin_id, vendor_id, service_category } = req.body;
    const CONTACT_FEE = 200;

    const client = await db.getClient(); // Start a secure transaction
    
    try {
        await client.query('BEGIN'); // Lock the wallet

        // 1. Find the User
        const userRes = await client.query('SELECT id FROM users WHERE shopin_id = $1', [buyer_shopin_id]);
        if (userRes.rows.length === 0) {
            throw new Error("User account not found.");
        }
        const userId = userRes.rows[0].id;

        // 2. Check their Liquid Stash Balance
        const walletRes = await client.query(
            'SELECT available_balance FROM stash_wallets WHERE user_id = $1 FOR UPDATE', 
            [userId]
        );
        
        if (walletRes.rows.length === 0 || walletRes.rows[0].available_balance < CONTACT_FEE) {
            throw new Error("Insufficient Liquid Stash balance. Please deposit at least ₦200.");
        }

        // 3. Deduct the ₦200 ShopIn Fee
        await client.query(
            'UPDATE stash_wallets SET available_balance = available_balance - $1 WHERE user_id = $2', 
            [CONTACT_FEE, userId]
        );

        // Optional: Trigger your EbulkSMS gateway here to alert the vendor of a hot lead!
        
        await client.query('COMMIT'); // Save changes
        res.status(200).json({ success: true, message: "Fee deducted and contact unlocked!" });

    } catch (error) {
        await client.query('ROLLBACK'); // Cancel if anything goes wrong
        console.error("Contact Reveal Error:", error.message);
        res.status(400).json({ error: error.message });
    } finally {
        client.release(); // Free up the Neon database connection
    }
});

// Route 12: Vendor Marketplace Checkout
app.post('/api/vendors/checkout', async (req, res) => {
    const { buyer_shopin_id, product_id, delivery_mode = 'DELIVERY', delivery_zone = 'alhikmah' } = req.body;

    if (!buyer_shopin_id || !product_id) {
        return res.status(400).json({ error: 'Buyer ShopIn ID and Product ID are required.' });
    }

    try {
        const buyerQuery = await db.query('SELECT id FROM users WHERE shopin_id = $1', [buyer_shopin_id.trim()]);
        if (buyerQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Buyer not found.' });
        }
        const buyerId = buyerQuery.rows[0].id;

        const productQuery = await db.query(
            'SELECT id, vendor_id, product_name, price_ngn FROM vendor_products WHERE id = $1 LIMIT 1', 
            [product_id]
        );
        if (productQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Vendor product not found.' });
        }
        const product = productQuery.rows[0];

        const vendorShopinFee = 200;
        
        // 🌟 Enforce ₦3,000 for outside areas on the backend!
        let deliveryFee = 0;
        if (delivery_mode.toUpperCase() === 'DELIVERY') {
          if (delivery_zone === 'alhikmah') {
            deliveryFee = 1500;
          } else if (delivery_zone === 'custom_kwara') {
            deliveryFee = 3000; // 🔥 Outside Selected Routes
          } else {
            deliveryFee = 2000; // Standard Outer Zone
          }
        }

        const itemCost = parseFloat(product.price_ngn || 0);
        const grandTotal = itemCost + vendorShopinFee + deliveryFee;

        const orderCode = `VND-${Math.floor(10000 + Math.random() * 90000)}`;
        const orderQuery = await db.query(
            `INSERT INTO orders (order_code, user_id, channel, raw_input_text, parsed_json, estimated_item_cost, service_fee, delivery_fee, total_estimated_cost, order_status) 
             VALUES ($1, $2, 'WEB', $3, $4, $5, $6, $7, $8, 'PENDING_ESCROW') RETURNING id`,
            [
              orderCode, 
              buyerId, 
              `Buying ${product.product_name} (${delivery_mode})`, 
              JSON.stringify({ product_id, delivery_mode, delivery_zone }),
              itemCost, 
              vendorShopinFee, 
              deliveryFee, 
              grandTotal
            ]
        );
        const orderId = orderQuery.rows[0].id;

        const escrowQuery = await db.query(
            `INSERT INTO escrow_transactions (order_id, buyer_id, vendor_id, amount_held, status)
             VALUES ($1, $2, $3, $4, 'HELD_IN_ESCROW') RETURNING *`,
            [orderId, buyerId, product.vendor_id, itemCost + vendorShopinFee]
        );

        res.status(201).json({
            status: "success",
            message: `Checkout complete (${delivery_mode})! Grand Total: ₦${grandTotal.toLocaleString()} (incl. ₦200 ShopIn Fee).`,
            order_code: orderCode,
            escrow_receipt: escrowQuery.rows[0]
        });

    } catch (err) {
        console.error("Vendor Checkout Error:", err.message);
        res.status(500).json({ error: "Server error during vendor checkout." });
    }
});

// Route 13: Release Escrow Funds
app.post('/api/escrow/release', async (req, res) => {
    const escrow_id = req.body.escrow_id ? req.body.escrow_id.trim() : null;

    if (!escrow_id) {
        return res.status(400).json({ error: 'Escrow ID is required.' });
    }

    try {
        const escrowQuery = await db.query(
            "SELECT id, amount_held, status FROM escrow_transactions WHERE id = $1 AND status = 'HELD_IN_ESCROW'",
            [escrow_id]
        );

        if (escrowQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Valid escrow transaction not found or funds already released.' });
        }

        const releaseQuery = await db.query(
            "UPDATE escrow_transactions SET status = 'RELEASED' WHERE id = $1 RETURNING *",
            [escrow_id]
        );

        res.status(200).json({
            status: "success",
            message: `Funds (N${releaseQuery.rows[0].amount_held}) successfully released to vendor's wallet!`,
            transaction_details: releaseQuery.rows[0]
        });

    } catch (err) {
        console.error("Escrow Release Error:", err.message);
        res.status(500).json({ error: "Server error releasing escrow funds." });
    }
});

// Route 14: Micro-Service & Direct Vendor Booking
app.post('/api/services/book-contact', async (req, res) => {
    const { buyer_shopin_id, vendor_id, service_category = 'Pepper Blending' } = req.body;

    if (!buyer_shopin_id || !vendor_id) {
        return res.status(400).json({ error: 'Buyer ShopIn ID and Vendor ID are required.' });
    }

    try {
        const buyerQuery = await db.query('SELECT id FROM users WHERE shopin_id = $1', [buyer_shopin_id.trim()]);
        if (buyerQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Buyer not found.' });
        }
        const buyerId = buyerQuery.rows[0].id;

        const vendorQuery = await db.query('SELECT id, full_name, phone_number FROM users WHERE id = $1 OR shopin_id = $2', [vendor_id, vendor_id]);
        if (vendorQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Service provider not found.' });
        }
        const vendor = vendorQuery.rows[0];

        const shopinServiceFee = 200;

        await db.query(
          `INSERT INTO vendor_service_calls (buyer_id, vendor_id, service_category, shopin_fee_paid)
           VALUES ($1, $2, $3, $4)`,
          [buyerId, vendor.id, service_category, shopinServiceFee]
        );

        res.status(200).json({
            status: "success",
            message: `ShopIn fee of ₦200 verified! You can now contact ${vendor.full_name} for ${service_category}.`,
            vendor_contact: {
              name: vendor.full_name,
              phone_number: vendor.phone_number,
              service_category: service_category
            }
        });

    } catch (err) {
        console.error("Service Contact Error:", err.message);
        res.status(500).json({ error: "Server error verifying service booking." });
    }
});

// Route 15: Register Service Provider
app.post('/api/services/register-provider', async (req, res) => {
    const { shopin_id, service_category, base_rate_ngn, provider_name } = req.body;

    if (!shopin_id || !service_category) {
        return res.status(400).json({ error: 'ShopIn ID and service category are required.' });
    }

    try {
        const userQuery = await db.query('SELECT id FROM users WHERE shopin_id = $1', [shopin_id.trim()]);
        
        if (userQuery.rows.length === 0) {
            return res.status(404).json({ error: 'User not found. Please register first.' });
        }
        const userId = userQuery.rows[0].id;

        const insertQuery = `
            INSERT INTO service_providers (user_id, service_category, base_rate_ngn, provider_name)
            VALUES ($1, $2, $3, $4)
            RETURNING *;
        `;
        const values = [userId, service_category.toUpperCase(), base_rate_ngn || 0, provider_name || 'AB&S Services'];
        
        const newProvider = await db.query(insertQuery, values);

        res.status(201).json({
            status: "success",
            message: `Awesome! You are now registered as a ${service_category} provider on ShopIn!`,
            provider_details: newProvider.rows[0]
        });
    } catch (err) {
        console.error("Provider Registration Error:", err.message);
        res.status(500).json({ error: "Server error while registering provider." });
    }
});

// Route 16: Book Micro-Service
app.post('/api/services/book', async (req, res) => {
    const { buyer_shopin_id, service_category } = req.body;

    if (!buyer_shopin_id || !service_category) {
        return res.status(400).json({ error: 'Buyer ShopIn ID and Service Category are required.' });
    }

    try {
        const buyerQuery = await db.query('SELECT id FROM users WHERE shopin_id = $1', [buyer_shopin_id.trim()]);
        if (buyerQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Buyer not found. Please check the ShopIn ID.' });
        }
        const buyerId = buyerQuery.rows[0].id;

        const providerQuery = await db.query(
            'SELECT id, base_rate_ngn FROM service_providers WHERE service_category = $1 LIMIT 1', 
            [service_category.toUpperCase()]
        );
        
        if (providerQuery.rows.length === 0) {
            return res.status(404).json({ error: 'No providers available for this service right now.' });
        }
        
        const provider = providerQuery.rows[0];

        const insertQuery = `
            INSERT INTO service_requests (buyer_id, provider_id, service_type, agreed_price_ngn)
            VALUES ($1, $2, $3, $4)
            RETURNING *;
        `;
        
        const values = [buyerId, provider.id, service_category.toUpperCase(), provider.base_rate_ngn || 0];
        const newRequest = await db.query(insertQuery, values);

        res.status(201).json({
            status: "success",
            message: `Service booked successfully! A ${service_category} provider will be dispatched.`,
            request_details: newRequest.rows[0]
        });
    } catch (err) {
        console.error("Service Booking Error:", err.message);
        res.status(500).json({ error: "Server error while booking the service." });
    }
});

// Route 17: Setup Group Buying Schema
app.get('/api/admin/setup-pooling', async (req, res) => {
    try {
        const createPoolCampaignsTable = `
            CREATE TABLE IF NOT EXISTS pool_campaigns (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                item_name VARCHAR(100) NOT NULL,
                target_quantity NUMERIC(10,2) NOT NULL,
                unit VARCHAR(30) NOT NULL,
                price_per_unit_ngn NUMERIC(10,2) NOT NULL,
                status VARCHAR(30) DEFAULT 'OPEN',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;

        const createPoolContributionsTable = `
            CREATE TABLE IF NOT EXISTS pool_contributions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                campaign_id UUID REFERENCES pool_campaigns(id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(id),
                quantity_pledged NUMERIC(10,2) NOT NULL,
                amount_paid_ngn NUMERIC(10,2) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;

        await db.query(createPoolCampaignsTable);
        await db.query(createPoolContributionsTable);

        res.status(200).json({
            status: "success",
            message: "Group Buying tables created successfully!"
        });
    } catch (err) {
        console.error("Pooling DB Setup Error:", err.message);
        res.status(500).json({ error: "Failed to create Group Buying tables." });
    }
});

// Route 18: Create Pool Campaign
app.post('/api/pooling/campaigns', async (req, res) => {
    const { item_name, target_quantity, unit, price_per_unit_ngn } = req.body;

    if (!item_name || !target_quantity || !unit || !price_per_unit_ngn) {
        return res.status(400).json({ error: 'Missing required campaign details.' });
    }

    try {
        const insertQuery = `
            INSERT INTO pool_campaigns (item_name, target_quantity, unit, price_per_unit_ngn)
            VALUES ($1, $2, $3, $4)
            RETURNING *;
        `;
        const values = [item_name, target_quantity, unit, price_per_unit_ngn];
        
        const newCampaign = await db.query(insertQuery, values);

        res.status(201).json({
            status: "success",
            message: `Awesome! New Pool Campaign started for ${item_name}!`,
            campaign_details: newCampaign.rows[0]
        });
    } catch (err) {
        console.error("Pool Campaign Error:", err.message);
        res.status(500).json({ error: "Server error while creating the pool campaign." });
    }
});

// Route 19: Contribute to Pool Campaign
app.post('/api/pooling/contribute', async (req, res) => {
    const { shopin_id, item_name, quantity_pledged } = req.body;

    if (!shopin_id || !item_name || !quantity_pledged) {
        return res.status(400).json({ error: 'ShopIn ID, item name, and quantity are required.' });
    }

    try {
        const userQuery = await db.query('SELECT id FROM users WHERE shopin_id = $1', [shopin_id.trim()]);
        if (userQuery.rows.length === 0) {
            return res.status(404).json({ error: 'User not found. Please register first.' });
        }
        const userId = userQuery.rows[0].id;

        const campaignQuery = await db.query(
            "SELECT id, price_per_unit_ngn FROM pool_campaigns WHERE item_name ILIKE $1 AND status = 'OPEN' LIMIT 1",
            [`%${item_name}%`]
        );
        if (campaignQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Active campaign not found for this item.' });
        }
        const campaign = campaignQuery.rows[0];

        const amount_paid_ngn = quantity_pledged * campaign.price_per_unit_ngn;

        const insertQuery = `
            INSERT INTO pool_contributions (campaign_id, user_id, quantity_pledged, amount_paid_ngn)
            VALUES ($1, $2, $3, $4)
            RETURNING *;
        `;
        const values = [campaign.id, userId, quantity_pledged, amount_paid_ngn];
        
        const contribution = await db.query(insertQuery, values);

        res.status(201).json({
            status: "success",
            message: `Awesome! You secured ${quantity_pledged} of ${item_name} at the bulk price! Total cost: N${amount_paid_ngn}`,
            contribution_details: contribution.rows[0]
        });

    } catch (err) {
        console.error("Contribution Error:", err.message);
        res.status(500).json({ error: "Server error while processing your pool contribution." });
    }
});

// Route 20: Live Market Price Ticker (Updated to show latest first)
app.get('/api/market/ticker', async (req, res) => {
    try {
        const tickerQuery = `
            SELECT * FROM (
                SELECT DISTINCT ON (LOWER(item_name), LOWER(unit)) 
                    id, item_name, unit, min_price_ngn, max_price_ngn, sourcing_market, last_updated 
                FROM market_prices 
                ORDER BY LOWER(item_name) ASC, LOWER(unit) ASC, last_updated DESC
            ) AS unique_prices
            ORDER BY last_updated DESC;
        `;
        const prices = await db.query(tickerQuery);

        if (prices.rows.length === 0) {
             return res.status(404).json({ message: "No market prices found in the database." });
        }

        res.status(200).json({
            status: "success",
            message: "Live market ticker data retrieved successfully!",
            data: prices.rows
        });
    } catch (err) {
        console.error("Ticker Error:", err.message);
        res.status(500).json({ error: "Server error retrieving market ticker." });
    }
});

// Route 21: Shopper Picking List
app.get('/api/shoppers/picking-list', verifyShopperOrAdminMiddleware, async (req, res) => {
    try {
        const ordersQuery = await db.query(
            "SELECT parsed_json FROM orders WHERE order_status NOT IN ('COMPLETED', 'CANCELLED')"
        );

        let pickingList = {};

        for (const order of ordersQuery.rows) {
            const items = order.parsed_json?.items || [];

            for (const item of items) {
                const category = item.category || 'General Foodstuff';
                const nameKey = item.item_name || item.name || 'Grocery Item';
                
                const priceQuery = await db.query(
                    'SELECT sourcing_market, fallback_market FROM market_prices WHERE item_name ILIKE $1 LIMIT 1',
                    [`%${nameKey}%`]
                );

                const primaryMarket = priceQuery.rows[0]?.sourcing_market || 'Mandate';
                const fallbackMarket = priceQuery.rows[0]?.fallback_market || 'Ipata';

                if (!pickingList[category]) {
                    pickingList[category] = [];
                }

                pickingList[category].push({
                    name: nameKey,
                    quantity: item.quantity || 1,
                    unit: item.unit || 'unit',
                    sourcing_info: `Sourced from ${primaryMarket} Market (Fallback: ${fallbackMarket} Market)`,
                    primary_market: primaryMarket,
                    fallback_market: fallbackMarket
                });
            }
        }

        res.status(200).json({
            status: "success",
            message: "Shopper picking list generated with primary and fallback markets!",
            data: pickingList
        });
    } catch (err) {
        console.error("Picking List Error:", err.message);
        res.status(500).json({ error: "Server error generating picking list." });
    }
});

// Route 22: Setup Phase 4 Tables
app.get('/api/admin/setup-phase4', async (req, res) => {
    try {
        const createCitiesTable = `
            CREATE TABLE IF NOT EXISTS operating_cities (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                state_name VARCHAR(50) NOT NULL,
                city_name VARCHAR(50) NOT NULL,
                market_hubs TEXT[] NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;

        const createDiasporaOrdersTable = `
            CREATE TABLE IF NOT EXISTS diaspora_orders (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                sender_email VARCHAR(100) NOT NULL,
                sender_country VARCHAR(50) NOT NULL,
                recipient_shopin_id VARCHAR(12) NOT NULL,
                order_value_usd NUMERIC(10,2) NOT NULL,
                exchange_rate_ngn NUMERIC(10,2) NOT NULL,
                status VARCHAR(30) DEFAULT 'PAYMENT_PENDING',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;

        await db.query(createCitiesTable);
        await db.query(createDiasporaOrdersTable);

        res.status(200).json({
            status: "success",
            message: "Phase 4 Multi-City and Diaspora tables created successfully!"
        });
    } catch (err) {
        console.error("Phase 4 DB Setup Error:", err.message);
        res.status(500).json({ error: "Failed to create Phase 4 tables." });
    }
});

// Route 23: Add Operating City
app.post('/api/admin/cities', async (req, res) => {
    const { state_name, city_name, market_hubs } = req.body;

    if (!state_name || !city_name || !market_hubs || !Array.isArray(market_hubs)) {
        return res.status(400).json({ error: 'State, city, and an array of market hubs are required.' });
    }

    try {
        const insertQuery = `
            INSERT INTO operating_cities (state_name, city_name, market_hubs)
            VALUES ($1, $2, $3)
            RETURNING *;
        `;
        const values = [state_name, city_name, market_hubs];
        
        const newCity = await db.query(insertQuery, values);

        res.status(201).json({
            status: "success",
            message: `Expansion successful! ShopIn is now live in ${city_name}, ${state_name}.`,
            city_details: newCity.rows[0]
        });
    } catch (err) {
        console.error("City Expansion Error:", err.message);
        res.status(500).json({ error: "Server error while adding new operating city." });
    }
});

// Route 24: Diaspora Order
app.post('/api/diaspora/send-food', async (req, res) => {
    const { sender_email, sender_country, recipient_shopin_id, order_value_usd } = req.body;

    if (!sender_email || !sender_country || !recipient_shopin_id || !order_value_usd) {
        return res.status(400).json({ error: 'Sender details, recipient ID, and USD value are required.' });
    }

    try {
        const userQuery = await db.query(
            'SELECT id, full_name FROM users WHERE shopin_id = $1', 
            [recipient_shopin_id.trim()]
        );
        
        if (userQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Recipient ShopIn ID not found. Please verify the ID.' });
        }
        const recipient = userQuery.rows[0];

        const exchange_rate_ngn = 1500;
        const total_ngn_value = order_value_usd * exchange_rate_ngn;

        const insertQuery = `
            INSERT INTO diaspora_orders (sender_email, sender_country, recipient_shopin_id, order_value_usd, exchange_rate_ngn)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *;
        `;
        const values = [sender_email, sender_country, recipient_shopin_id.trim(), order_value_usd, exchange_rate_ngn];
        
        const diasporaOrder = await db.query(insertQuery, values);

        res.status(201).json({
            status: "success",
            message: `Diaspora order logged! N${total_ngn_value} will be credited to ${recipient.full_name}'s grocery stash.`,
            order_details: diasporaOrder.rows[0]
        });
    } catch (err) {
        console.error("Diaspora Order Error:", err.message);
        res.status(500).json({ error: "Server error processing diaspora order." });
    }
});

const crypto = require('crypto');

// 🔒 Secure Paystack Webhook Endpoint for Asynchronous Payment Confirmations
app.post('/api/webhooks/paystack', async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  
  // Validate Paystack cryptographic signature header
  const hash = crypto
    .createHmac('sha512', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  const paystackSignature = req.headers['x-paystack-signature'];

  if (hash !== paystackSignature) {
    console.warn("⚠️ Invalid Paystack webhook signature detected!");
    return res.status(401).json({ error: 'Unauthorized webhook signature.' });
  }

  const event = req.body;

  // Handle successful charge event from Paystack
  if (event && event.event === 'charge.success') {
    const txData = event.data;
    const reference = txData.reference;
    const amountPaidNgn = txData.amount / 100; // Convert kobo to Naira
    const customerEmail = txData.customer.email;

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Check if reference was already processed
      const existingTx = await client.query('SELECT id FROM wallet_transactions WHERE reference_code = $1', [reference]);
      if (existingTx.rows.length > 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(200).json({ status: 'ignored', message: 'Transaction already processed.' });
      }

      // Find user by email or metadata
      const userQuery = await client.query('SELECT id FROM users WHERE email = $1 FOR UPDATE', [customerEmail]);
      if (userQuery.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ error: 'User not found for webhook email.' });
      }
      const userId = userQuery.rows[0].id;

      // Update wallet balance securely
      const walletResult = await client.query(`
        INSERT INTO stash_wallets (user_id, available_balance)
        VALUES ($1, $2)
        ON CONFLICT (user_id) 
        DO UPDATE SET available_balance = stash_wallets.available_balance + EXCLUDED.available_balance,
                      last_updated = CURRENT_TIMESTAMP
        RETURNING id;
      `, [userId, amountPaidNgn]);

      const walletId = walletResult.rows[0].id;

      // Log transaction
      await client.query(`
        INSERT INTO wallet_transactions (wallet_id, transaction_type, amount_ngn, reference_code)
        VALUES ($1, 'WEBHOOK_DEPOSIT', $2, $3)
      `, [walletId, amountPaidNgn, reference]);

      await client.query('COMMIT');
      client.release();

      console.log(`✅ Webhook processed successfully for reference: ${reference} (₦${amountPaidNgn})`);
    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      console.error("❌ Paystack Webhook DB Transaction Error:", err.message);
      return res.status(500).json({ error: 'Database transaction failed.' });
    }
  }

  res.status(200).json({ status: 'success' });
});

// Route 25: Setup Wallet Schema
app.get('/api/admin/setup-wallet', async (req, res) => {
    try {
        const createWalletsTable = `
            CREATE TABLE IF NOT EXISTS stash_wallets (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
                available_balance NUMERIC(10,2) DEFAULT 0.00,
                escrow_balance NUMERIC(10,2) DEFAULT 0.00,
                last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;

        const createTransactionsTable = `
            CREATE TABLE IF NOT EXISTS wallet_transactions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                wallet_id UUID REFERENCES stash_wallets(id) ON DELETE CASCADE,
                transaction_type VARCHAR(20) NOT NULL,
                amount_ngn NUMERIC(10,2) NOT NULL,
                reference_code VARCHAR(50) UNIQUE NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;

        await db.query(createWalletsTable);
        await db.query(createTransactionsTable);

        res.status(200).json({
            status: "success",
            message: "Stash Wallet and Transaction Ledger tables created successfully!"
        });
    } catch (err) {
        console.error("Wallet DB Setup Error:", err.message);
        res.status(500).json({ error: "Failed to create Stash Wallet tables." });
    }
});

// Route 26: Deposit into Stash Wallet
app.post('/api/wallet/deposit', async (req, res) => {
    const { shopin_id, amount_ngn } = req.body;

    if (!shopin_id || !amount_ngn || amount_ngn <= 0) {
        return res.status(400).json({ error: 'ShopIn ID and a valid deposit amount are required.' });
    }

    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        const userQuery = await client.query('SELECT id FROM users WHERE shopin_id = $1 FOR UPDATE', [shopin_id.trim()]);
        if (userQuery.rows.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(404).json({ error: 'User not found. Please register first.' });
        }
        const userId = userQuery.rows[0].id;

        const upsertWalletQuery = `
            INSERT INTO stash_wallets (user_id, available_balance)
            VALUES ($1, $2)
            ON CONFLICT (user_id) 
            DO UPDATE SET 
                available_balance = stash_wallets.available_balance + EXCLUDED.available_balance,
                last_updated = CURRENT_TIMESTAMP
            RETURNING *;
        `;
        const walletResult = await client.query(upsertWalletQuery, [userId, amount_ngn]);
        const walletId = walletResult.rows[0].id;
        const newBalance = walletResult.rows[0].available_balance;

        const refCode = `DEP-${Math.floor(100000 + Math.random() * 900000)}`;
        const insertTxQuery = `
            INSERT INTO wallet_transactions (wallet_id, transaction_type, amount_ngn, reference_code)
            VALUES ($1, 'DEPOSIT', $2, $3)
            RETURNING *;
        `;

        await client.query(insertTxQuery, [walletId, amount_ngn, refCode]);

        await client.query('COMMIT');
        client.release();

        res.status(200).json({
            status: "success",
            message: `N${amount_ngn} deposited successfully! Your new Stash Wallet balance is N${newBalance}.`,
            wallet_balance: newBalance
        });

    } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        console.error("Wallet Deposit Transaction Error:", err.message);
        res.status(500).json({ error: "Server error during wallet deposit transaction." });
    }
});

// Route: Transfer money between Liquid Stash and Target Stash
app.post('/api/wallet/transfer-to-target', async (req, res) => {
    const { shopin_id, amount_to_transfer } = req.body;

    if (!shopin_id || !amount_to_transfer || amount_to_transfer <= 0) {
        return res.status(400).json({ error: 'ShopIn ID and a valid amount are required.' });
    }

    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        // Find user
        const userQuery = await client.query('SELECT id FROM users WHERE shopin_id = $1', [shopin_id.trim()]);
        if (userQuery.rows.length === 0) throw new Error('User not found.');
        const userId = userQuery.rows[0].id;

        // Check if they have enough liquid cash
        const walletQuery = await client.query('SELECT available_balance FROM stash_wallets WHERE user_id = $1 FOR UPDATE', [userId]);
        if (walletQuery.rows[0].available_balance < amount_to_transfer) {
            throw new Error('Not enough money in your Liquid Stash!');
        }

        // Move the money!
        await client.query(`
            UPDATE stash_wallets 
            SET available_balance = available_balance - $1, 
                target_balance = target_balance + $1,
                last_updated = CURRENT_TIMESTAMP
            WHERE user_id = $2
        `, [amount_to_transfer, userId]);

        await client.query('COMMIT');
        client.release();

        res.status(200).json({ status: "success", message: `₦${amount_to_transfer} moved to your Target Savings!` });

    } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        res.status(500).json({ error: err.message });
    }
});

// Route: Get User Wallet Balances
app.get('/api/wallet/:shopin_id', async (req, res) => {
    const { shopin_id } = req.params;
    
    try {
        const userQuery = await db.query('SELECT id FROM users WHERE shopin_id = $1', [shopin_id.trim()]);
        if (userQuery.rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        const userId = userQuery.rows[0].id;

        const walletQuery = await db.query(
            'SELECT available_balance, escrow_balance, target_balance FROM stash_wallets WHERE user_id = $1', 
            [userId]
        );

        if (walletQuery.rows.length === 0) {
            return res.status(200).json({ available_balance: 0, escrow_balance: 0, target_balance: 0 });
        }

        res.status(200).json(walletQuery.rows[0]);
    } catch (err) {
        console.error("Wallet Fetch Error:", err.message);
        res.status(500).json({ error: "Failed to fetch wallet balance." });
    }
});

// Route 26b: Setup Pending Deposits Table (For Manual OPay Transfers)
app.get('/api/admin/setup-pending-deposits', async (req, res) => {
    try {
        const createPendingDepositsTable = `
            CREATE TABLE IF NOT EXISTS pending_deposits (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                amount_ngn NUMERIC(10,2) NOT NULL,
                status VARCHAR(30) DEFAULT 'PENDING',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;
        await db.query(createPendingDepositsTable);
        res.status(200).json({ status: "success", message: "Pending Deposits table created!" });
    } catch (err) {
        console.error("Setup Pending Deposits Error:", err.message);
        res.status(500).json({ error: "Failed to create Pending Deposits table." });
    }
});

// Route 26c: User Submits a Manual Deposit Claim
app.post('/api/wallet/request-deposit', async (req, res) => {
    const { shopin_id, amount_ngn, sender_name } = req.body;

    // 🌟 Validate that shopin_id, amount, AND sender name are present
    if (!shopin_id || !amount_ngn || amount_ngn <= 0 || !sender_name || !sender_name.trim()) {
        return res.status(400).json({ error: 'ShopIn ID, amount, and sender name are required.' });
    }

    try {
        // 1. Find the user
        const userQuery = await db.query('SELECT id FROM users WHERE shopin_id = $1', [shopin_id.trim()]);
        if (userQuery.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
        
        // 2. Log the pending claim including the sender's name
        const insertQuery = `
            INSERT INTO pending_deposits (user_id, amount_ngn, sender_name)
            VALUES ($1, $2, $3) RETURNING *;
        `;
        const result = await db.query(insertQuery, [userQuery.rows[0].id, amount_ngn, sender_name.trim()]);

        res.status(201).json({ 
            status: "success", 
            message: "Transfer claim submitted! Waiting for Admin verification.",
            pending_deposit: result.rows[0]
        });
    } catch (err) {
        console.error("Request Deposit Error:", err.message);
        res.status(500).json({ error: "Server error while requesting deposit." });
    }
});

// Route 26d: Admin Approves the Deposit (Credits the Wallet)
app.post('/api/admin/approve-deposit', verifyAdminMiddleware, async (req, res) => {
    const { pending_deposit_id } = req.body;
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        // 1. Get the pending deposit
        const pendingQuery = await client.query("SELECT * FROM pending_deposits WHERE id = $1 AND status = 'PENDING' FOR UPDATE", [pending_deposit_id]);
        if (pendingQuery.rows.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(404).json({ error: 'Pending deposit not found or already processed.' });
        }
        
        const deposit = pendingQuery.rows[0];

        // 2. Mark as APPROVED
        await client.query("UPDATE pending_deposits SET status = 'APPROVED' WHERE id = $1", [pending_deposit_id]);

        // 3. Update the Wallet (Reusing your existing wallet logic)
        const upsertWalletQuery = `
            INSERT INTO stash_wallets (user_id, available_balance)
            VALUES ($1, $2)
            ON CONFLICT (user_id) 
            DO UPDATE SET 
                available_balance = stash_wallets.available_balance + EXCLUDED.available_balance,
                last_updated = CURRENT_TIMESTAMP
            RETURNING available_balance, id;
        `;
        const walletResult = await client.query(upsertWalletQuery, [deposit.user_id, deposit.amount_ngn]);

        // 4. Record in Transaction Ledger
        const refCode = `OPAY-MANUAL-${Math.floor(100000 + Math.random() * 900000)}`;
        
        // 🚨 THE FIX: Changed 'amount_ngn' to 'amount' to perfectly match your database schema!
        await client.query(
            `INSERT INTO wallet_transactions (wallet_id, transaction_type, amount, reference_code, narration)
             VALUES ($1, 'DEPOSIT', $2, $3, 'Admin Approved OPay Transfer')`,
            [walletResult.rows[0].id, deposit.amount_ngn, refCode]
        );

        await client.query('COMMIT');
        client.release();

        res.status(200).json({ status: "success", message: "Deposit approved and wallet credited!" });
    } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        console.error("Approve Deposit Error:", err.message);
        res.status(500).json({ error: "Server error approving deposit." });
    }
});

// Route 26e: Fetch all pending deposits for Admin Dashboard
app.get('/api/admin/pending-deposits', verifyAdminMiddleware, async (req, res) => {
    try {
        const query = `
            SELECT pd.id, pd.amount_ngn, pd.status, pd.created_at, pd.sender_name, u.full_name, u.shopin_id 
            FROM pending_deposits pd
            JOIN users u ON pd.user_id = u.id
            WHERE pd.status = 'PENDING'
            ORDER BY pd.created_at ASC;
        `;
        const result = await db.query(query);
        res.status(200).json({ status: 'success', pending_deposits: result.rows });
    } catch (err) {
        console.error("Fetch Pending Deposits Error:", err.message);
        res.status(500).json({ error: "Server error fetching pending deposits." });
    }
});

// Route 26f: Admin Rejects/Deletes a Pending Deposit
app.post('/api/admin/reject-deposit', verifyAdminMiddleware, async (req, res) => {
    const { pending_deposit_id } = req.body;
    try {
        await db.query("DELETE FROM pending_deposits WHERE id = $1", [pending_deposit_id]);
        res.status(200).json({ status: "success", message: "Pending deposit removed." });
    } catch (err) {
        console.error("Reject Deposit Error:", err.message);
        res.status(500).json({ error: "Server error rejecting deposit." });
    }
});

// Route 27: Setup Batch Shuttles
app.get('/api/admin/setup-shuttles', async (req, res) => {
    try {
        const createShuttleBatchesTable = `
            CREATE TABLE IF NOT EXISTS shuttle_batches (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                route_name VARCHAR(100) NOT NULL,
                dispatch_time TIME NOT NULL,
                max_capacity INT DEFAULT 50,
                current_load INT DEFAULT 0,
                status VARCHAR(30) DEFAULT 'ACCEPTING_ORDERS',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;

        const addShuttleToOrders = `
            ALTER TABLE orders 
            ADD COLUMN IF NOT EXISTS shuttle_batch_id UUID REFERENCES shuttle_batches(id);
        `;

        await db.query(createShuttleBatchesTable);
        await db.query(addShuttleToOrders);

        res.status(200).json({
            status: "success",
            message: "Shuttle Batch tables and Order upgrades created successfully!"
        });
    } catch (err) {
        console.error("Shuttle DB Setup Error:", err.message);
        res.status(500).json({ error: "Failed to create Shuttle tables." });
    }
});

// Route 28: Create Shuttle Batch
app.post('/api/shuttles/create', async (req, res) => {
    const { route_name, dispatch_time, max_capacity } = req.body;

    if (!route_name || !dispatch_time) {
        return res.status(400).json({ error: 'Route name and dispatch time are required.' });
    }

    try {
        const insertQuery = `
            INSERT INTO shuttle_batches (route_name, dispatch_time, max_capacity)
            VALUES ($1, $2, $3)
            RETURNING *;
        `;
        const values = [route_name, dispatch_time, max_capacity || 50];
        
        const newShuttle = await db.query(insertQuery, values);

        res.status(201).json({
            status: "success",
            message: `Awesome! The ${route_name} shuttle scheduled for ${dispatch_time} is now accepting orders!`,
            shuttle_details: newShuttle.rows[0]
        });
    } catch (err) {
        console.error("Create Shuttle Error:", err.message);
        res.status(500).json({ error: "Server error while creating shuttle batch." });
    }
});

// Route 29: Board Shuttle (Dynamic Zone Rates)
app.post('/api/orders/join-shuttle', async (req, res) => {
    const { order_code, shuttle_id } = req.body;

    if (!order_code || !shuttle_id) {
        return res.status(400).json({ error: 'Order code and shuttle ID are required.' });
    }

    try {
        const shuttleQuery = await db.query(
            "SELECT id, current_load, max_capacity, route_name, dispatch_time FROM shuttle_batches WHERE id = $1 AND status = 'ACCEPTING_ORDERS'",
            [shuttle_id]
        );

        if (shuttleQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Shuttle not found or no longer accepting orders.' });
        }

        const shuttle = shuttleQuery.rows[0];
        if (shuttle.current_load >= shuttle.max_capacity) {
            return res.status(400).json({ error: 'Sorry, this shuttle is full!' });
        }

        const orderQuery = await db.query('SELECT id, total_estimated_cost, delivery_fee FROM orders WHERE order_code = $1', [order_code]);
        if (orderQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found.' });
        }
        
        const order = orderQuery.rows[0];

        const routeNameLower = shuttle.route_name.toLowerCase();
        const isInnerZone = routeNameLower.includes('al-hikmah') || 
                            routeNameLower.includes('alhikmah') || 
                            routeNameLower.includes('apalara');

        // 🌟 Updated to ₦500 discount: ₦1000 for inner zone, ₦1500 for outer
        const discountedDeliveryFee = isInnerZone ? 1000 : 1500;

        const newTotal = parseFloat(order.total_estimated_cost) - parseFloat(order.delivery_fee) + discountedDeliveryFee;

        await db.query(
            'UPDATE orders SET shuttle_batch_id = $1, delivery_fee = $2, total_estimated_cost = $3 WHERE order_code = $4',
            [shuttle.id, discountedDeliveryFee, newTotal, order_code]
        );

        await db.query(
            'UPDATE shuttle_batches SET current_load = current_load + 1 WHERE id = $1',
            [shuttle.id]
        );

        res.status(200).json({
            status: "success",
            message: `Success! Your order is on the ${shuttle.route_name} shuttle. Delivery fee adjusted to ₦${discountedDeliveryFee.toLocaleString()}!`,
            new_total: newTotal,
            delivery_fee: discountedDeliveryFee
        });

    } catch (err) {
        console.error("Join Shuttle Error:", err.message);
        res.status(500).json({ error: "Server error while joining shuttle." });
    }
});

// Route 30: Verify Paystack Payment & Fund Stash Wallet
app.post('/api/wallet/verify-paystack', async (req, res) => {
    const { reference, shopin_id } = req.body;

    if (!reference || !shopin_id) {
        return res.status(400).json({ error: 'Payment reference and ShopIn ID are required.' });
    }

    const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackSecretKey) {
        return res.status(500).json({ error: 'Paystack configuration missing on server.' });
    }

    const client = await db.getClient();

    try {
        const paystackResponse = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: {
                Authorization: `Bearer ${paystackSecretKey}`
            }
        });

        const txData = paystackResponse.data;

        if (!txData.status || txData.data.status !== 'success') {
            return res.status(400).json({ error: 'Payment verification failed or transaction not successful.' });
        }

        const amountPaidNgn = txData.data.amount / 100; 

        await client.query('BEGIN');

        const userQuery = await client.query('SELECT id FROM users WHERE shopin_id = $1 FOR UPDATE', [shopin_id.trim()]);
        if (userQuery.rows.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(404).json({ error: 'User not found.' });
        }
        const userId = userQuery.rows[0].id;

        const existingTx = await client.query('SELECT id FROM wallet_transactions WHERE reference_code = $1', [reference]);
        if (existingTx.rows.length > 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(400).json({ error: 'This payment reference has already been processed.' });
        }

        const upsertWalletQuery = `
            INSERT INTO stash_wallets (user_id, available_balance)
            VALUES ($1, $2)
            ON CONFLICT (user_id) 
            DO UPDATE SET 
                available_balance = stash_wallets.available_balance + EXCLUDED.available_balance,
                last_updated = CURRENT_TIMESTAMP
            RETURNING *;
        `;
        const walletResult = await client.query(upsertWalletQuery, [userId, amountPaidNgn]);
        const walletId = walletResult.rows[0].id;
        const newBalance = walletResult.rows[0].available_balance;

        await client.query(
            `INSERT INTO wallet_transactions (wallet_id, transaction_type, amount_ngn, reference_code)
             VALUES ($1, 'PAYSTACK_DEPOSIT', $2, $3)`,
            [walletId, amountPaidNgn, reference]
        );

        await client.query('COMMIT');
        client.release();

        return res.status(200).json({
            status: "success",
            message: `Payment of ₦${amountPaidNgn.toLocaleString()} verified and added to Stash Wallet!`,
            wallet_balance: newBalance
        });

    } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        console.error("Paystack Verification Error:", err.response?.data || err.message);
        return res.status(500).json({ error: 'Server error verifying payment transaction with Paystack.' });
    }
});

// Route: Admin Manual Quote Override for Custom Errands/Orders
app.put('/api/admin/orders/:id/override-quote', verifyAdminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { total_estimated_cost, delivery_fee, service_fee, admin_note } = req.body;

  if (!total_estimated_cost) {
    return res.status(400).json({ error: 'New total estimated cost is required.' });
  }

  try {
    const orderQuery = await db.query(
      `UPDATE orders 
       SET total_estimated_cost = $1, 
           delivery_fee = COALESCE($2, delivery_fee), 
           service_fee = COALESCE($3, service_fee),
           order_status = 'QUOTE_READY'
       WHERE id = $4 RETURNING *`,
      [total_estimated_cost, delivery_fee, service_fee, id]
    );

    if (orderQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const updatedOrder = orderQuery.rows[0];

    // Optional: Fetch user phone number to dispatch an SMS via Termii alerting them that their quote is ready
    const userQuery = await db.query('SELECT phone_number FROM users WHERE id = $1', [updatedOrder.user_id]);
    if (userQuery.rows.length > 0 && userQuery.rows[0].phone_number) {
      const phone = userQuery.rows[0].phone_number;
      const smsText = `[ShopIn Kwara] Your custom errand quote for order ${updatedOrder.order_code} is ready! Total: ₦${Number(total_estimated_cost).toLocaleString()}. Login to pay and confirm.`;
      sendSMS(phone, smsText).catch(err => console.warn("Quote SMS alert failed:", err.message));
    }

    res.status(200).json({
      status: 'success',
      message: 'Order quote successfully overridden and updated!',
      order: updatedOrder
    });
  } catch (err) {
    console.error("Quote Override Error:", err.message);
    res.status(500).json({ error: 'Server error updating order quote.' });
  }
});

// GET /api/pools - Fetch Active Food Pools
app.get('/api/pools', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        id,
        pool_title AS item_name,
        target_item_name,
        sourcing_market AS location,
        total_slots AS target_units,
        filled_slots AS current_units,
        price_per_slot AS unit_price,
        'Per Slot Share' AS unit_label,
        status,
        expires_at AS deadline
      FROM food_pools
      WHERE status = 'OPEN'
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching food pools:', err);
    res.status(500).json({ error: 'Failed to fetch food pools' });
  }
});

// POST /api/admin/pools - Admin Route to Launch New Food Pools
app.post('/api/admin/pools', verifyAdminMiddleware, async (req, res) => {
  const { 
    item_name, target_item_name, price_per_slot, 
    total_slots, sourcing_market 
  } = req.body;

  if (!item_name || !price_per_slot || !total_slots) {
    return res.status(400).json({ error: 'Missing required pool details.' });
  }

  try {
    const insertQuery = `
      INSERT INTO food_pools (pool_title, target_item_name, price_per_slot, total_slots, sourcing_market)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const values = [item_name, target_item_name || item_name, price_per_slot, total_slots, sourcing_market || 'Mandate Market'];
    
    const newPool = await db.query(insertQuery, values);

    res.status(201).json({
      status: "success",
      message: `Food Pool "${item_name}" launched successfully!`,
      pool: newPool.rows[0]
    });
  } catch (err) {
    console.error("Create Food Pool Error:", err.message);
    res.status(500).json({ error: "Server error while creating food pool." });
  }
});


// POST /api/pools/:id/join - Join Food Pool
app.post('/api/pools/:id/join', async (req, res) => {
  const { id } = req.params;
  const { units = 1 } = req.body;

  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const poolRes = await client.query('SELECT * FROM food_pools WHERE id = $1 FOR UPDATE', [id]);
    if (poolRes.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Pool not found.' });
    }

    const pool = poolRes.rows[0];

    if (pool.filled_slots + Number(units) > pool.total_slots) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({
        error: `Only ${pool.total_slots - pool.filled_slots} slots left in this pool.`,
      });
    }

    const updatedRes = await client.query(
      `UPDATE food_pools 
       SET filled_slots = filled_slots + $1,
           status = CASE WHEN filled_slots + $1 >= total_slots THEN 'FILLED' ELSE status END
       WHERE id = $2
       RETURNING *`,
      [units, id]
    );

    await client.query('COMMIT');
    client.release();

    res.json({
      message: 'Successfully joined pool!',
      pool: updatedRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    console.error('Error joining pool transaction:', err);
    res.status(500).json({ error: 'Server error while joining pool' });
  }
});

// PUT /api/admin/pools/:id - Admin Route to Edit a Food Pool
app.put('/api/admin/pools/:id', verifyAdminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { item_name, target_item_name, price_per_slot, total_slots, sourcing_market, status } = req.body;
  
  try {
    const result = await db.query(
      `UPDATE food_pools 
       SET pool_title = COALESCE($1, pool_title), 
           target_item_name = COALESCE($2, target_item_name), 
           price_per_slot = COALESCE($3, price_per_slot), 
           total_slots = COALESCE($4, total_slots), 
           sourcing_market = COALESCE($5, sourcing_market),
           status = COALESCE($6, status)
       WHERE id = $7 RETURNING *`,
      [item_name, target_item_name, price_per_slot, total_slots, sourcing_market, status, id]
    );
    
    if (result.rowCount === 0) return res.status(404).json({ error: 'Pool not found.' });
    res.json({ status: 'success', message: 'Pool updated successfully!', pool: result.rows[0] });
  } catch (err) {
    console.error("Edit Pool Error:", err.message);
    res.status(500).json({ error: 'Server error updating pool.' });
  }
});

// DELETE /api/admin/pools/:id - Admin Route to Delete a Food Pool
app.delete('/api/admin/pools/:id', verifyAdminMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query('DELETE FROM food_pools WHERE id = $1 RETURNING *', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Pool not found.' });
    res.json({ status: 'success', message: 'Pool deleted successfully!' });
  } catch (err) {
    console.error("Delete Pool Error:", err.message);
    res.status(500).json({ error: 'Server error deleting pool.' });
  }
});

// 🚀 Route 31: Admin Dashboard - Full User & Vendor Tracker (Supports UserTracker.jsx)
app.get('/api/admin/users', verifyAdminMiddleware, async (req, res) => {
  try {
    const statsQuery = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE user_role = 'consumer') AS total_buyers,
        COUNT(*) FILTER (WHERE user_role = 'vendor') AS total_vendors,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS signups_today,
        COUNT(*) AS total_platform_users
      FROM users
      WHERE shopin_id != 'GUEST-WEB';
    `);

    const usersDirectoryQuery = await db.query(`
      SELECT 
        u.id,
        u.shopin_id,
        u.full_name,
        u.phone_number,
        u.email,
        u.user_role,
        u.vendor_category,
        u.contact_mode,
        u.created_at,
        COALESCE(w.available_balance, 0.00) AS wallet_balance
      FROM users u
      LEFT JOIN stash_wallets w ON u.id = w.user_id
      WHERE u.shopin_id != 'GUEST-WEB'
      ORDER BY u.created_at DESC;
    `);

    res.status(200).json({
      status: 'success',
      metrics: statsQuery.rows[0],
      users: usersDirectoryQuery.rows
    });
  } catch (err) {
    console.error("User Tracking Endpoint Error:", err.message);
    res.status(500).json({ error: "Failed to fetch platform user metrics." });
  }
});

// Route 31b: Backward Compatible Alias for Admin Stats
app.get('/api/admin/user-stats', verifyAdminMiddleware, async (req, res) => {
  try {
    const statsQuery = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE user_role = 'consumer') AS total_consumers,
        COUNT(*) FILTER (WHERE user_role = 'vendor') AS total_vendors,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS signups_today
      FROM users
      WHERE shopin_id != 'GUEST-WEB';
    `);

    const recentUsersQuery = await db.query(`
      SELECT shopin_id, full_name, phone_number, user_role, vendor_category, contact_mode, created_at
      FROM users
      WHERE shopin_id != 'GUEST-WEB'
      ORDER BY created_at DESC
      LIMIT 10;
    `);

    res.status(200).json({
      status: 'success',
      metrics: statsQuery.rows[0],
      recent_signups: recentUsersQuery.rows
    });
  } catch (err) {
    console.error("User Stats Error:", err.message);
    res.status(500).json({ error: "Failed to fetch user analytics." });
  }
});

// Route 32: Update User Profile (Phone Number & Account Settings)
app.put('/api/users/profile', async (req, res) => {
  try {
    const { shopin_id, full_name, phone_number, email } = req.body;

    if (!shopin_id || !phone_number) {
      return res.status(400).json({ error: 'ShopIn ID and Phone Number are required.' });
    }

    const queryText = `
      UPDATE users 
      SET full_name = COALESCE($1, full_name),
          phone_number = COALESCE($2, phone_number),
          email = COALESCE($3, email)
      WHERE shopin_id = $4
      RETURNING *;
    `;
    const result = await db.query(queryText, [full_name, phone_number, email, shopin_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User profile not found.' });
    }

    res.status(200).json({
      status: 'success',
      message: 'Profile updated successfully!',
      user_data: result.rows[0]
    });
  } catch (err) {
    console.error("Profile Update Error:", err.message);
    res.status(500).json({ error: 'Failed to update user profile settings.' });
  }
});

// Route 33: Add or Update Address
app.post('/api/users/address', async (req, res) => {
  try {
    const { shopin_id, address_label = 'HOME', zone_name, major_checkpoint, detailed_address } = req.body;

    if (!shopin_id || !zone_name || !detailed_address) {
      return res.status(400).json({ error: 'Zone name and detailed address are required.' });
    }

    const userRes = await db.query('SELECT id FROM users WHERE shopin_id = $1', [shopin_id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const userId = userRes.rows[0].id;

    const queryText = `
      INSERT INTO user_addresses (user_id, address_label, zone_name, major_checkpoint, detailed_address)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const result = await db.query(queryText, [userId, address_label, zone_name, major_checkpoint || 'Central Market', detailed_address]);

    res.status(201).json({
      status: 'success',
      message: 'Address saved successfully!',
      address_data: result.rows[0]
    });
  } catch (err) {
    console.error("Save Address Error:", err.message);
    res.status(500).json({ error: 'Failed to save address.' });
  }
});

// Route: Verify Admin Passcode Securely
app.post('/api/admin/verify-pin', (req, res) => {
  const { pin } = req.body;
  const validAdminPin = process.env.ADMIN_PIN || '1234'; // Default fallback PIN

  if (!pin || pin.trim() !== validAdminPin) {
    return res.status(401).json({ error: 'Invalid admin passcode.' });
  }

  return res.status(200).json({ success: true, message: 'Admin verified successfully.' });
});

// Route: Setup Platform Settings Table
app.get('/api/admin/setup-settings', verifyAdminMiddleware, async (req, res) => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await db.query(`
      INSERT INTO platform_settings (key, value) 
      VALUES ('shopper_pin', '5678')
      ON CONFLICT (key) DO NOTHING;
    `);

    res.status(200).json({ status: 'success', message: 'Platform settings table initialized!' });
  } catch (err) {
    console.error("Settings Setup Error:", err.message);
    res.status(500).json({ error: 'Failed to create settings table.' });
  }
});

// Route: Update Shopper PIN Dynamically
app.put('/api/admin/shopper-pin', verifyAdminMiddleware, async (req, res) => {
  const { new_pin } = req.body;

  if (!new_pin || new_pin.trim().length < 4) {
    return res.status(400).json({ error: 'Shopper PIN must be at least 4 characters long.' });
  }

  try {
    await db.query(`
      INSERT INTO platform_settings (key, value, updated_at) 
      VALUES ('shopper_pin', $1, CURRENT_TIMESTAMP)
      ON CONFLICT (key) 
      DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;
    `, [new_pin.trim()]);

    res.status(200).json({ status: 'success', message: 'Shopper PIN updated successfully!' });
  } catch (err) {
    console.error("Update Shopper PIN Error:", err.message);
    res.status(500).json({ error: 'Server error updating shopper PIN.' });
  }
});

// Route 34: Fetch all dynamic locations (Markets, Supermarkets, Restaurants)
app.get('/api/locations', async (req, res) => {
    try {
        const query = `SELECT key, value FROM platform_settings WHERE key IN ('markets', 'supermarkets', 'restaurants')`;
        const result = await db.query(query);
        
        // These are the exact defaults you requested!
        const locations = {
            markets: ['Mandate', 'Oja Tuntun', 'Oja Oba', 'Ipata', 'Kulende'],
            supermarkets: ['Shoprite', 'Emirate Mall', 'Shopmall'],
            restaurants: ['Aroma', 'Captain Cook', 'Sheshede', 'Item 7', 'Food 101']
        };

        // If you have saved custom lists in the database, override the defaults
        result.rows.forEach(row => {
            try { locations[row.key] = JSON.parse(row.value); } catch(e) {}
        });

        res.status(200).json(locations);
    } catch (err) {
        console.error("Locations Fetch Error:", err.message);
        res.status(500).json({ error: "Failed to fetch locations." });
    }
});

// Route 35: Admin Update dynamic locations
app.put('/api/admin/locations', async (req, res) => {
    const { category, locations_array } = req.body;
    
    if (!['markets', 'supermarkets', 'restaurants'].includes(category)) {
        return res.status(400).json({ error: 'Invalid location category' });
    }

    try {
        await db.query(`
            INSERT INTO platform_settings (key, value, updated_at) 
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
        `, [category, JSON.stringify(locations_array)]);

        res.status(200).json({ status: 'success', message: `${category} updated successfully!` });
    } catch (err) {
        console.error("Update Locations Error:", err.message);
        res.status(500).json({ error: "Server error updating locations." });
    }
});

// Route: Admin Update Vendor Product/Item
app.put('/api/admin/vendor-products/:id', verifyAdminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { product_name, price_ngn, category, location } = req.body;

  try {
    const result = await db.query(
      `UPDATE vendor_products 
       SET product_name = COALESCE($1, product_name),
           price_ngn = COALESCE($2, price_ngn),
           category = COALESCE($3, category),
           location = COALESCE($4, location)
       WHERE id = $5 RETURNING *`,
      [product_name, price_ngn, category, location, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Product or restaurant item not found.' });
    }

    res.json({
      status: 'success',
      message: 'Item updated successfully!',
      product: result.rows[0]
    });
  } catch (err) {
    console.error('Error updating vendor product:', err);
    res.status(500).json({ error: 'Server error updating item.' });
  }
});

// Fetch all marketplace categories for the frontend tabs
app.get('/api/marketplace/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT category_name FROM marketplace_categories ORDER BY created_at ASC');
    res.status(200).json({ status: 'success', categories: result.rows.map(r => r.category_name) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories.' });
  }
});

// Admin: Add a brand new category (e.g. "House Agents")
app.post('/api/admin/categories', verifyAdminMiddleware, async (req, res) => {
  const { category_name } = req.body;
  if (!category_name) return res.status(400).json({ error: 'Category name is required.' });

  try {
    const result = await db.query(
      `INSERT INTO marketplace_categories (category_name) VALUES ($1) RETURNING *`,
      [category_name.trim()]
    );
    res.status(201).json({ status: 'success', message: `Category "${category_name}" created successfully!`, category: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'This category already exists.' });
    res.status(500).json({ error: 'Server error creating category.' });
  }
});

// 🔒 ADMIN: Fetch All Active/Pending Orders for Admin Console
app.get('/api/admin/orders', verifyAdminMiddleware, async (req, res) => {
  try {
    const ordersQuery = await db.query(`
      SELECT 
        o.id, 
        o.order_code, 
        o.raw_input_text, 
        o.parsed_json, 
        o.total_estimated_cost, 
        o.delivery_fee, 
        o.service_fee, 
        o.processing_fee, 
        o.order_status, 
        o.created_at,
        COALESCE(u.full_name, o.parsed_json->>'customer_name', 'Guest Customer') AS customer_name,
        COALESCE(u.phone_number, o.parsed_json->>'customer_phone', 'No Phone') AS customer_phone
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      WHERE o.order_status NOT IN ('COMPLETED', 'DELIVERED')
      ORDER BY o.created_at DESC;
    `);

    res.status(200).json({
      status: 'success',
      orders: ordersQuery.rows
    });
  } catch (err) {
    console.error("Fetch Admin Orders Error:", err.message);
    res.status(500).json({ error: "Failed to fetch orders." });
  }
});

// 🔒 ADMIN: Update Order Status (Shopping, Action Required, Completed)
app.put('/api/admin/orders/:id/status', verifyAdminMiddleware, async (req, res) => {
  const { id } = req.params;
  const status = req.body.order_status || req.body.status;

  if (!status) {
    return res.status(400).json({ error: 'Order status is required.' });
  }

  try {
    // 🌟 Cast id::text and check order_code so UUIDs and 'ORD-...' codes both work
    const result = await db.query(
      `UPDATE orders 
       SET order_status = $1 
       WHERE id::text = $2 OR order_code = $2 
       RETURNING *;`,
      [status.toUpperCase(), id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    res.status(200).json({
      status: 'success',
      message: `Order status updated to ${status}!`,
      order: result.rows[0]
    });
  } catch (err) {
    console.error("Update Order Status Error:", err.message);
    res.status(500).json({ error: 'Server error updating order status: ' + err.message });
  }
});

// Route: Delete an Order (Admin)
app.delete('/api/admin/orders/:id', verifyAdminMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `DELETE FROM orders 
       WHERE id::text = $1 OR order_code = $1 
       RETURNING *;`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    res.json({ success: true, message: `Order ${id} deleted successfully.` });
  } catch (err) {
    console.error('Delete Order Error:', err.message);
    res.status(500).json({ error: 'Failed to delete order: ' + err.message });
  }
});

// 👤 USER: Fetch Active/Pending Orders for Customer Tracker
app.get('/api/user/orders', async (req, res) => {
  const { shopin_id } = req.query;

  if (!shopin_id) {
    return res.status(400).json({ error: 'User identifier (shopin_id) is required.' });
  }

  const cleanId = shopin_id.trim();

  try {
    const query = `
      SELECT o.* 
      FROM orders o 
      LEFT JOIN users u ON o.user_id = u.id 
      WHERE u.shopin_id = $1 
         OR o.user_id::text = $1 
         OR o.parsed_json->>'shopin_id' = $1
         OR o.parsed_json->'user'->>'shopin_id' = $1
      ORDER BY o.created_at DESC;
    `;
    
    const result = await db.query(query, [cleanId]);
    
    // Return both raw array and structured object to prevent frontend mismatch
    res.status(200).json({ 
      status: 'success', 
      orders: result.rows,
      data: result.rows 
    });
  } catch (err) {
    console.error("Fetch User Orders Error:", err.message);
    res.status(500).json({ error: "Failed to fetch user orders: " + err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 ShopIn Backend running on http://localhost:${PORT}`);
});