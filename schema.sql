-- Drop trigger function with CASCADE first (this automatically cleans up any attached triggers)
DROP FUNCTION IF EXISTS create_stash_wallet_for_new_user() CASCADE;

-- Drop tables in reverse order of foreign key dependencies to ensure clean runs
DROP TABLE IF EXISTS vendor_service_calls CASCADE;
DROP TABLE IF EXISTS service_requests CASCADE;
DROP TABLE IF EXISTS service_providers CASCADE;
DROP TABLE IF EXISTS escrow_transactions CASCADE;
DROP TABLE IF EXISTS vendor_products CASCADE;
DROP TABLE IF EXISTS pool_memberships CASCADE;
DROP TABLE IF EXISTS food_pools CASCADE;
DROP TABLE IF EXISTS delivery_pools CASCADE;
DROP TABLE IF EXISTS wallet_transactions CASCADE;
DROP TABLE IF EXISTS stash_wallets CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS market_prices CASCADE;
DROP TABLE IF EXISTS user_addresses CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS pending_deposits CASCADE;

-- 1. Users Table (Supports Consumers & Vendors with Category & Contact Mode)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shopin_id VARCHAR(12) UNIQUE NOT NULL, -- e.g. SHP-ILR-1024, VND-ILR-2048, or GUEST-WEB
    full_name VARCHAR(100) NOT NULL,
    phone_number VARCHAR(15) UNIQUE NOT NULL,
    email VARCHAR(100),
    user_role VARCHAR(20) DEFAULT 'consumer', -- consumer, vendor, shopper, rider, admin
    vendor_category VARCHAR(50), -- Wearables, Electronics, Foodstuff, Provisions, Micro-Services
    contact_mode VARCHAR(20) DEFAULT 'MIDDLEMAN', -- MIDDLEMAN (Escrow checkout) or DIRECT (Direct Phone call)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Delivery Addresses with Ilorin Checkpoints
CREATE TABLE user_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    address_label VARCHAR(20) DEFAULT 'HOME', -- HOME, HOSTEL, OFFICE
    zone_name VARCHAR(50) NOT NULL, -- e.g. Tanke/Unilorin Axis, Al-Hikmah/Apalara Axis
    major_checkpoint VARCHAR(100) NOT NULL, -- e.g. Tipper Garage
    detailed_address TEXT NOT NULL, -- e.g. Green storey building behind Sanrab
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Ilorin Market Price Index (With Multi-tier Kwara Measurements & Brand Support)
CREATE TABLE market_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_name VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL,
    brand_or_variant VARCHAR(100) DEFAULT 'Standard',
    unit VARCHAR(30) NOT NULL, -- paint_rubber, derica, module, tuber, kg, tin, naira_value
    min_price_ngn NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    max_price_ngn NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    tin_price NUMERIC(10,2),
    module_price NUMERIC(10,2),
    paint_rubber_price NUMERIC(10,2),
    half_bag_price NUMERIC(10,2),
    full_bag_price NUMERIC(10,2),
    is_variable_budget BOOLEAN DEFAULT FALSE, -- TRUE for produce where users type custom ₦ amount
    sourcing_market VARCHAR(50) DEFAULT 'Mandate', -- Mandate, Ipata, Sawmill
    fallback_market VARCHAR(50) DEFAULT 'Ipata',
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Vendor Products & Services (Wearables, Electronics, Pepper Blending, Cleaning)
CREATE TABLE vendor_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID REFERENCES users(id) ON DELETE CASCADE,
    product_name VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL, -- Wearables, Electronics, Provisions, Foodstuff, Micro-Services
    brand_or_variant VARCHAR(100), -- e.g. Dangote, NYSC Full Kit, 3-layer niqab
    price_ngn NUMERIC(10,2), -- NULL allowed for direct negotiation micro-services
    stock_quantity INT DEFAULT 1,
    image_url TEXT,
    service_type VARCHAR(50) DEFAULT 'product', -- product or service
    is_pickup_available BOOLEAN DEFAULT TRUE,
    allow_direct_contact BOOLEAN DEFAULT FALSE, -- TRUE for direct call micro-services
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Orders Table
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_code VARCHAR(15) UNIQUE NOT NULL,
    user_id UUID REFERENCES users(id),
    channel VARCHAR(10) NOT NULL, -- WEB, SMS, WHATSAPP, EMAIL
    raw_input_text TEXT NOT NULL,
    parsed_json JSONB NOT NULL,
    estimated_item_cost NUMERIC(10,2) NOT NULL,
    service_fee NUMERIC(10,2) NOT NULL, -- ₦500 standard or ₦200 vendor category fee
    delivery_fee NUMERIC(10,2) NOT NULL, -- ₦0 for Pickup
    total_estimated_cost NUMERIC(10,2) NOT NULL,
    order_status VARCHAR(30) DEFAULT 'PENDING_CONFIRMATION',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Escrow Transactions Table
CREATE TABLE escrow_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    buyer_id UUID REFERENCES users(id),
    vendor_id UUID REFERENCES users(id),
    amount_held NUMERIC(10,2) NOT NULL,
    status VARCHAR(30) DEFAULT 'HELD_IN_ESCROW', -- HELD_IN_ESCROW, RELEASED, REFUNDED
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. Stash Wallet (Balances & Escrow)
CREATE TABLE stash_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    available_balance NUMERIC(12,2) DEFAULT 0.00 CHECK (available_balance >= 0),
    escrow_balance NUMERIC(12,2) DEFAULT 0.00 CHECK (escrow_balance >= 0),
    target_balance NUMERIC(12,2) DEFAULT 0.00 CHECK (target_balance >= 0),
    currency VARCHAR(3) DEFAULT 'NGN',
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. Wallet Transactions Ledger
CREATE TABLE wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID REFERENCES stash_wallets(id) ON DELETE CASCADE,
    transaction_type VARCHAR(30) NOT NULL, -- DEPOSIT, ORDER_PAYMENT, SERVICE_CONTACT_FEE, ESCROW_HOLD, ESCROW_RELEASE, REFUND, PAYSTACK_DEPOSIT
    amount NUMERIC(12,2) NOT NULL,
    reference_code VARCHAR(50) UNIQUE NOT NULL,
    status VARCHAR(20) DEFAULT 'SUCCESS',
    narration TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 9. Micro-Service Providers (AB&S Cleaning, Pepper Blending, Laundry)
CREATE TABLE service_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    provider_name VARCHAR(100) DEFAULT 'AB&S Cleaning Services',
    service_category VARCHAR(50) NOT NULL, -- JANITORIAL, PEPPER_BLENDING, LAUNDRY, FUMIGATION
    base_rate_ngn NUMERIC(10,2) DEFAULT 0.00,
    is_verified BOOLEAN DEFAULT TRUE,
    average_rating NUMERIC(2,1) DEFAULT 5.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 10. Service Contact & Booking Log (Tracks ₦200 Contact Reveal Fees)
CREATE TABLE vendor_service_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id UUID REFERENCES users(id),
    vendor_id UUID REFERENCES users(id),
    service_category VARCHAR(50) NOT NULL,
    shopin_fee_paid NUMERIC(10,2) DEFAULT 200.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 11. Service Booking Requests
CREATE TABLE service_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id UUID REFERENCES users(id),
    provider_id UUID REFERENCES service_providers(id),
    service_type VARCHAR(50) NOT NULL,
    agreed_price_ngn NUMERIC(10,2) DEFAULT 0.00,
    status VARCHAR(30) DEFAULT 'PENDING_ACCEPTANCE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 12. Bulk Food Pooling Groups
CREATE TABLE food_pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_title VARCHAR(100) NOT NULL, -- Removed UNIQUE constraint to prevent errors
    target_item_name VARCHAR(100) NOT NULL,
    total_slots INT NOT NULL, 
    filled_slots INT DEFAULT 0,
    price_per_slot NUMERIC(10,2) NOT NULL,
    sourcing_market VARCHAR(50) DEFAULT 'Mandate',
    status VARCHAR(20) DEFAULT 'OPEN', 
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 13. Food Pooling Contributions
CREATE TABLE pool_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID REFERENCES food_pools(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    slots_claimed INT DEFAULT 1,
    amount_paid NUMERIC(10,2) NOT NULL,
    payment_status VARCHAR(20) DEFAULT 'HELD_IN_ESCROW',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pool_id, user_id)
);

-- 14. Delivery Route Shuttle Pools Table
CREATE TABLE delivery_pools (
    id SERIAL PRIMARY KEY,
    pool_code VARCHAR(50) UNIQUE NOT NULL,        -- e.g., POL-ALHIKMAH-01
    route_name VARCHAR(100) NOT NULL,              -- e.g., Mandate -> Al-Hikmah / Apalara
    origin_market VARCHAR(100) DEFAULT 'Mandate Market',
    destination_zone VARCHAR(100) NOT NULL,        -- e.g., Al-Hikmah / Apalara
    max_capacity INT DEFAULT 10,
    current_orders INT DEFAULT 0,
    base_shuttle_fee NUMERIC(10,2) DEFAULT 1300.00,
    status VARCHAR(20) DEFAULT 'OPEN',             -- 'OPEN', 'LOCKED', 'IN_TRANSIT', 'COMPLETED'
    cutoff_time TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 15. Pending Deposits Table
CREATE TABLE pending_deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    amount_ngn NUMERIC(10,2) NOT NULL,
    status VARCHAR(30) DEFAULT 'PENDING',
    sender_name VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ================================================
-- 🚀 AUTOMATIC STASH WALLET CREATION TRIGGER
-- ================================================
CREATE OR REPLACE FUNCTION create_stash_wallet_for_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO stash_wallets (user_id, available_balance, escrow_balance, currency)
    VALUES (NEW.id, 0.00, 0.00, 'NGN')
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_create_stash_wallet
AFTER INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION create_stash_wallet_for_new_user();

-- ================================================
-- 🌱 SEED DATA WITH CORRECTED MARKET PRICES
-- ================================================

INSERT INTO users (shopin_id, full_name, phone_number, email, user_role)
VALUES ('GUEST-WEB', 'Guest Customer', '08000000000', 'guest@shopin.ng', 'consumer')
ON CONFLICT (shopin_id) DO NOTHING;

INSERT INTO users (shopin_id, full_name, phone_number, email, user_role, vendor_category, contact_mode)
VALUES 
    ('VND-ILR-1001', 'Alhaja Pepper Grinding & Food Processing', '08031234567', 'pepper@shopin.ng', 'vendor', 'Micro-Services', 'DIRECT'),
    ('VND-ILR-1002', 'AB&S Cleaning Services', '08059876543', 'abs@shopin.ng', 'vendor', 'Micro-Services', 'DIRECT'),
    ('VND-ILR-1003', 'Kwara NYSC & Wearables Hub', '08071112223', 'wears@shopin.ng', 'vendor', 'Wearables', 'MIDDLEMAN')
ON CONFLICT (shopin_id) DO NOTHING;

-- 🌟 NEW & CORRECTED MARKET PRICES INJECTION
INSERT INTO market_prices (item_name, category, brand_or_variant, unit, min_price_ngn, max_price_ngn, is_variable_budget, sourcing_market, fallback_market)
VALUES
    -- 🌾 GRAINS & LEGUMES
    ('Rice', 'Grain', 'Standard', 'full_bag', 54000.00, 55000.00, FALSE, 'Mandate', 'Ipata'),
    ('Rice', 'Grain', 'Standard', 'paint_rubber', 4700.00, 4800.00, FALSE, 'Mandate', 'Ipata'),
    ('Rice', 'Grain', 'Standard', 'mudu', 1150.00, 1200.00, FALSE, 'Mandate', 'Ipata'),
    ('Rice', 'Grain', 'Standard', 'cup', 290.00, 300.00, FALSE, 'Mandate', 'Ipata'),
    
    ('Beans', 'Grain', 'Standard', 'full_bag', 105000.00, 110000.00, FALSE, 'Mandate', 'Ipata'),
    ('Beans', 'Grain', 'Standard', 'paint_rubber', 7500.00, 7850.00, FALSE, 'Mandate', 'Ipata'),
    ('Beans', 'Grain', 'Standard', 'mudu', 1875.00, 1960.00, FALSE, 'Mandate', 'Ipata'),
    ('Beans', 'Grain', 'Standard', 'cup', 470.00, 490.00, FALSE, 'Mandate', 'Ipata'),

    ('Garri', 'Grain', 'Standard', 'full_bag', 21000.00, 23800.00, FALSE, 'Mandate', 'Ipata'),
    ('Garri', 'Grain', 'Standard', 'paint_rubber', 1500.00, 1700.00, FALSE, 'Mandate', 'Ipata'),
    ('Garri', 'Grain', 'Standard', 'mudu', 380.00, 425.00, FALSE, 'Mandate', 'Ipata'),
    ('Garri', 'Grain', 'Standard', 'cup', 95.00, 110.00, FALSE, 'Mandate', 'Ipata'),

    ('Maize', 'Grain', 'Standard', 'paint_rubber', 2000.00, 2100.00, FALSE, 'Mandate', 'Ipata'),
    ('Maize', 'Grain', 'Standard', 'mudu', 500.00, 525.00, FALSE, 'Mandate', 'Ipata'),
    ('Jero', 'Grain', 'Standard', 'paint_rubber', 2000.00, 2100.00, FALSE, 'Mandate', 'Ipata'),
    ('Jero', 'Grain', 'Standard', 'mudu', 500.00, 525.00, FALSE, 'Mandate', 'Ipata'),
    ('Okababa', 'Grain', 'Standard', 'paint_rubber', 2000.00, 2100.00, FALSE, 'Mandate', 'Ipata'),
    ('Okababa', 'Grain', 'Standard', 'mudu', 500.00, 525.00, FALSE, 'Mandate', 'Ipata'),

    -- 🛢️ OILS & LIQUIDS
    ('Groundnut Oil', 'Oils & Liquids', 'Kings', '25_litres', 57500.00, 58000.00, FALSE, 'Mandate', 'Ipata'),
    ('Groundnut Oil', 'Oils & Liquids', 'Kings', '12.5_litres', 28500.00, 29000.00, FALSE, 'Mandate', 'Ipata'),
    ('Groundnut Oil', 'Oils & Liquids', 'Kings', '5_litres', 11500.00, 11600.00, FALSE, 'Mandate', 'Ipata'),
    ('Groundnut Oil', 'Oils & Liquids', 'Kings', '75cl', 1700.00, 1800.00, FALSE, 'Mandate', 'Ipata'),
    
    ('Palm Oil', 'Oils & Liquids', 'Standard', '25_litres', 49500.00, 50000.00, FALSE, 'Mandate', 'Ipata'),
    ('Palm Oil', 'Oils & Liquids', 'Standard', '12.5_litres', 24500.00, 25000.00, FALSE, 'Mandate', 'Ipata'),
    ('Palm Oil', 'Oils & Liquids', 'Standard', '5_litres', 9800.00, 10000.00, FALSE, 'Mandate', 'Ipata'),
    ('Palm Oil', 'Oils & Liquids', 'Standard', '75cl', 1450.00, 1500.00, FALSE, 'Mandate', 'Ipata'),

    -- 🍚 FOODSTUFF & STAPLES
    ('Semo', 'Foodstuff', 'Standard', '10kg', 10500.00, 10800.00, FALSE, 'Mandate', 'Ipata'),
    ('Semo', 'Foodstuff', 'Standard', '5kg', 5300.00, 5400.00, FALSE, 'Mandate', 'Ipata'),
    ('Semo', 'Foodstuff', 'Standard', '2.5kg', 2600.00, 2700.00, FALSE, 'Mandate', 'Ipata'),
    ('Semo', 'Foodstuff', 'Standard', 'kg', 1050.00, 1080.00, FALSE, 'Mandate', 'Ipata'),
    
    ('Wheat', 'Foodstuff', 'Standard', '10kg', 10500.00, 10700.00, FALSE, 'Mandate', 'Ipata'),
    ('Wheat', 'Foodstuff', 'Standard', '5kg', 5250.00, 5350.00, FALSE, 'Mandate', 'Ipata'),
    ('Wheat', 'Foodstuff', 'Standard', '2.5kg', 2600.00, 2675.00, FALSE, 'Mandate', 'Ipata'),
    ('Wheat', 'Foodstuff', 'Standard', 'kg', 1050.00, 1070.00, FALSE, 'Mandate', 'Ipata'),

    -- 🍝 PASTA & NOODLES
    ('Spaghetti', 'Pasta & Noodles', 'Golden Penny', 'carton', 18500.00, 18600.00, FALSE, 'Mandate', 'Ipata'),
    ('Spaghetti', 'Pasta & Noodles', 'Golden Penny', 'pack', 900.00, 950.00, FALSE, 'Mandate', 'Ipata'),
    
    ('Macaroni', 'Pasta & Noodles', 'Standard', 'carton', 18400.00, 18500.00, FALSE, 'Mandate', 'Ipata'),
    ('Macaroni', 'Pasta & Noodles', 'Standard', 'pack', 900.00, 950.00, FALSE, 'Mandate', 'Ipata'),

    -- ☕ BEVERAGES & PROVISIONS
    ('Cornflakes', 'Beverages', 'Nasco', 'roll', 1250.00, 1300.00, FALSE, 'Mandate', 'Ipata'),
    ('Cornflakes', 'Beverages', 'Nasco', 'sachet', 100.00, 130.00, FALSE, 'Mandate', 'Ipata'),
    
    ('Golden Morn', 'Beverages', 'Standard', 'roll', 2350.00, 2400.00, FALSE, 'Mandate', 'Ipata'),
    ('Golden Morn', 'Beverages', 'Standard', 'sachet', 240.00, 250.00, FALSE, 'Mandate', 'Ipata'),

    -- 🥬 PROTEINS, TUBERS & PRODUCE
    ('Yam (Laboko)', 'Tubers', 'Standard', 'tuber', 1500.00, 3500.00, FALSE, 'Ipata', 'Mandate'),
    ('Eggs', 'Proteins', 'Standard', 'crate', 3800.00, 4500.00, FALSE, 'Mandate', 'Ipata'),
    ('Tomatoes', 'Produce', 'Standard', 'basket', 3000.00, 8000.00, TRUE, 'Ipata', 'Mandate'),
    ('Ewedu', 'Produce', 'Standard', 'bunch', 200.00, 1000.00, TRUE, 'Ipata', 'Mandate');

INSERT INTO food_pools (pool_title, target_item_name, total_slots, filled_slots, price_per_slot, sourcing_market, expires_at)
VALUES 
    ('50kg Bag of Foreign Rice Share', 'Foreign Rice', 4, 3, 18500.00, 'Mandate', NOW() + INTERVAL '2 days'),
    ('100 Tubers of Laboko Yam Share', 'Yam (Laboko)', 5, 2, 12000.00, 'Mandate', NOW() + INTERVAL '3 days'),
    ('Paint Rubber Garri Ijebu Share', 'Garri Ijebu', 6, 4, 3500.00, 'Ipata', NOW() + INTERVAL '1 day');

INSERT INTO delivery_pools (pool_code, route_name, destination_zone, base_shuttle_fee, cutoff_time) 
VALUES
    ('POL-ALHIKMAH-01', 'Mandate Market ➔ Al-Hikmah / Apalara Route', 'Al-Hikmah / Apalara', 1300.00, NOW() + INTERVAL '2 hours'),
    ('POL-IREWOLEDE-01', 'Mandate Market ➔ Irewolede / Unity Road Route', 'Irewolede / Unity', 1300.00, NOW() + INTERVAL '3 hours'),
    ('POL-UNILORIN-01', 'Mandate Market ➔ Tanke / Unilorin Gate Route', 'Tanke / Unilorin', 1800.00, NOW() + INTERVAL '4 hours'),
    ('POL-CHALLENGE-01', 'Mandate Market ➔ Challenge / Fate Route', 'Challenge / Fate', 1800.00, NOW() + INTERVAL '2 hours')
ON CONFLICT (pool_code) DO NOTHING;

-- 1. Create the default test user
INSERT INTO users (shopin_id, full_name, phone_number, email, user_role)
VALUES ('SHP-ILR-1001', 'Test User', '08012345678', 'test@shopin.ng', 'consumer')
ON CONFLICT (shopin_id) DO NOTHING;

-- 2. Ensure they have a Stash Wallet attached
INSERT INTO stash_wallets (user_id, available_balance, escrow_balance)
SELECT id, 0.00, 0.00 FROM users WHERE shopin_id = 'SHP-ILR-1001'
ON CONFLICT (user_id) DO NOTHING;

-- PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_users_shopin_id ON users(shopin_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_order_code ON orders(order_code);
CREATE INDEX IF NOT EXISTS idx_market_prices_item_name ON market_prices(item_name);
CREATE INDEX IF NOT EXISTS idx_market_prices_brand ON market_prices(brand_or_variant);
CREATE INDEX IF NOT EXISTS idx_vendor_products_vendor ON vendor_products(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_products_category ON vendor_products(category);
CREATE INDEX IF NOT EXISTS idx_pool_memberships_user_id ON pool_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_stash_wallets_user ON stash_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet ON wallet_transactions(wallet_id);

-- 0. FIX: Add the missing column to the users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;

-- 1. FIRST: Create the verified Vendors
INSERT INTO users (shopin_id, full_name, phone_number, email, user_role, vendor_category, contact_mode, is_verified)
VALUES 
    ('VND-SUPER-01', 'Ace Supermarket (Tanke)', '080SUPER001', 'ace@shopin.ng', 'vendor', 'Supermarkets', 'MIDDLEMAN', TRUE),
    ('VND-REST-01', 'Item 7 (Tanke)', '080ITEM7001', 'item7@shopin.ng', 'vendor', 'Restaurants', 'MIDDLEMAN', TRUE),
    ('VND-REST-02', 'Iya Yusuf Buka', '080IYAYUSUF', 'iyayusuf@shopin.ng', 'vendor', 'Restaurants', 'MIDDLEMAN', TRUE),
    ('VND-MKT-01', 'Mummy Peace Wholesales (Oja)', '080MANDATE', 'oja@shopin.ng', 'vendor', 'Local Markets', 'MIDDLEMAN', TRUE)
ON CONFLICT (shopin_id) DO NOTHING;

-- 2. SECOND: Inject the Products and link them to the Vendors above!
INSERT INTO vendor_products (vendor_id, product_name, category, price_ngn, stock_quantity, service_type, is_verified)
VALUES
    -- 🛒 SUPERMARKET ITEMS
    ((SELECT id FROM users WHERE shopin_id = 'VND-SUPER-01'), 'Viva Plus Detergent (170g)', 'Supermarkets', 10600, 50, 'product', TRUE),
    ((SELECT id FROM users WHERE shopin_id = 'VND-SUPER-01'), 'Three Crowns Refill (800g)', 'Supermarkets', 7000, 50, 'product', TRUE),
    ((SELECT id FROM users WHERE shopin_id = 'VND-SUPER-01'), 'Nasco Cornflakes (Roll)', 'Supermarkets', 1300, 50, 'product', TRUE),
    ((SELECT id FROM users WHERE shopin_id = 'VND-SUPER-01'), 'Golden Morn 45g (Roll)', 'Supermarkets', 2400, 50, 'product', TRUE),
    ((SELECT id FROM users WHERE shopin_id = 'VND-SUPER-01'), 'Peak Milk Refill (320g)', 'Supermarkets', 4000, 50, 'product', TRUE),
    ((SELECT id FROM users WHERE shopin_id = 'VND-SUPER-01'), 'Checkers Custard 400g (Can)', 'Supermarkets', 1200, 50, 'product', TRUE),

    -- 🍽️ RESTAURANT ITEMS
    ((SELECT id FROM users WHERE shopin_id = 'VND-REST-01'), 'Chicken Sharwama (Item 7)', 'Restaurants', 3000, 100, 'product', TRUE),
    ((SELECT id FROM users WHERE shopin_id = 'VND-REST-01'), 'Jollof Rice & Chicken (Item 7)', 'Restaurants', 3000, 100, 'product', TRUE),
    
    ((SELECT id FROM users WHERE shopin_id = 'VND-REST-02'), 'Amala, Ewedu & Beef (Iya Yusuf)', 'Restaurants', 1500, 100, 'product', TRUE),
    ((SELECT id FROM users WHERE shopin_id = 'VND-REST-02'), 'Pounded Yam & Egusi (Iya Yusuf)', 'Restaurants', 2000, 100, 'product', TRUE),

    -- 🧺 LOCAL MARKET WHOLESALE
    ((SELECT id FROM users WHERE shopin_id = 'VND-MKT-01'), '50kg Bag of Foreign Rice', 'Local Markets', 54000, 20, 'product', TRUE),
    ((SELECT id FROM users WHERE shopin_id = 'VND-MKT-01'), 'Kings Groundnut Oil (25 Litres)', 'Local Markets', 58000, 10, 'product', TRUE);