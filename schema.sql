-- Enable UUID extension if not enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

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

-- 1. Users Table (Supports Consumers & Vendors with Category & Contact Mode)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shopin_id VARCHAR(12) UNIQUE NOT NULL, -- e.g. SHP-ILR-1024 or VND-ILR-2048
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
    currency VARCHAR(3) DEFAULT 'NGN',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. Wallet Transactions Ledger
CREATE TABLE wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID REFERENCES stash_wallets(id) ON DELETE CASCADE,
    transaction_type VARCHAR(20) NOT NULL, -- DEPOSIT, ORDER_PAYMENT, SERVICE_CONTACT_FEE, ESCROW_HOLD, ESCROW_RELEASE, REFUND
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
    pool_title VARCHAR(100) UNIQUE NOT NULL, -- e.g. 50kg Bag of Foreign Rice Share
    target_item_name VARCHAR(100) NOT NULL,
    total_slots INT NOT NULL, -- e.g. 4 slots
    filled_slots INT DEFAULT 1,
    price_per_slot NUMERIC(10,2) NOT NULL,
    sourcing_market VARCHAR(50) DEFAULT 'Mandate',
    status VARCHAR(20) DEFAULT 'OPEN', -- OPEN, FILLED, COMPLETED, CANCELLED
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
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
    pool_code VARCHAR(50) UNIQUE NOT NULL,       -- e.g., POL-ALHIKMAH-01
    route_name VARCHAR(100) NOT NULL,            -- e.g., Mandate -> Al-Hikmah / Apalara
    origin_market VARCHAR(100) DEFAULT 'Mandate Market',
    destination_zone VARCHAR(100) NOT NULL,      -- e.g., Al-Hikmah / Apalara
    max_capacity INT DEFAULT 10,
    current_orders INT DEFAULT 0,
    base_shuttle_fee NUMERIC(10,2) DEFAULT 1300.00,
    status VARCHAR(20) DEFAULT 'OPEN',            -- 'OPEN', 'LOCKED', 'IN_TRANSIT', 'COMPLETED'
    cutoff_time TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ================================================
-- SEED DATA (Ilorin Markets, Vendors & Micro-Services)
-- ================================================

-- Seed Initial Guest User for Web Checkout
INSERT INTO users (shopin_id, full_name, phone_number, email, user_role)
VALUES ('GUEST-WEB', 'Guest Customer', '08000000000', 'guest@shopin.ng', 'consumer')
ON CONFLICT (shopin_id) DO NOTHING;

-- Seed Sample Vendors (Direct Contact & Middleman)
INSERT INTO users (shopin_id, full_name, phone_number, email, user_role, vendor_category, contact_mode)
VALUES 
    ('VND-ILR-1001', 'Alhaja Pepper Grinding & Food Processing', '08031234567', 'pepper@shopin.ng', 'vendor', 'Micro-Services', 'DIRECT'),
    ('VND-ILR-1002', 'AB&S Cleaning Services', '08059876543', 'abs@shopin.ng', 'vendor', 'Micro-Services', 'DIRECT'),
    ('VND-ILR-1003', 'Kwara NYSC & Wearables Hub', '08071112223', 'wears@shopin.ng', 'vendor', 'Wearables', 'MIDDLEMAN')
ON CONFLICT (shopin_id) DO NOTHING;

-- Seed Initial Market Prices (Mandate / Ipata / Sawmill)
INSERT INTO market_prices (item_name, category, brand_or_variant, unit, min_price_ngn, max_price_ngn, tin_price, module_price, paint_rubber_price, half_bag_price, full_bag_price, is_variable_budget, sourcing_market)
VALUES
    ('Garri Ijebu', 'Grain', 'Standard', 'paint_rubber', 1500.00, 1800.00, 100.00, 800.00, 2400.00, 14400.00, 28800.00, FALSE, 'Mandate'),
    ('White Garri', 'Grain', 'Standard', 'paint_rubber', 1200.00, 1500.00, 100.00, 800.00, 2400.00, 14400.00, 28800.00, FALSE, 'Mandate'),
    ('Foreign Rice', 'Grain', 'Standard', 'paint_rubber', 3500.00, 4200.00, 800.00, 2400.00, 7200.00, 30000.00, 60000.00, FALSE, 'Mandate'),
    ('Yam (Laboko)', 'Tubers', 'Standard', 'tuber', 1500.00, 3500.00, NULL, NULL, NULL, NULL, NULL, FALSE, 'Ipata'),
    ('Groundnut Oil', 'Oils & Liquids', 'Power Oil', 'bottle', 1200.00, 1600.00, NULL, NULL, NULL, NULL, NULL, FALSE, 'Sawmill'),
    ('Groundnut Oil', 'Oils & Liquids', 'Kings', 'keg_25l', 35000.00, 42000.00, NULL, NULL, NULL, NULL, NULL, FALSE, 'Sawmill'),
    ('Spaghetti', 'Pasta & Noodles', 'Dangote', 'pack', 700.00, 850.00, NULL, NULL, NULL, NULL, NULL, FALSE, 'Mandate'),
    ('Spaghetti', 'Pasta & Noodles', 'Golden Penny', 'pack', 750.00, 900.00, NULL, NULL, NULL, NULL, NULL, FALSE, 'Mandate'),
    ('Palm Oil', 'Oils & Liquids', 'Pure Palm Oil', 'bottle', 1000.00, 1300.00, NULL, NULL, NULL, NULL, NULL, FALSE, 'Sawmill'),
    ('Eggs', 'Proteins', 'Standard', 'crate', 3800.00, 4500.00, NULL, NULL, NULL, NULL, NULL, FALSE, 'Mandate'),
    ('Tomatoes', 'Produce', 'Standard', 'basket', 3000.00, 8000.00, NULL, NULL, NULL, NULL, NULL, TRUE, 'Ipata'),
    ('Ewedu', 'Produce', 'Standard', 'bunch', 200.00, 1000.00, NULL, NULL, NULL, NULL, NULL, TRUE, 'Ipata');

-- Seed Initial Food Pools
INSERT INTO food_pools (pool_title, target_item_name, total_slots, filled_slots, price_per_slot, sourcing_market, expires_at)
VALUES 
    ('50kg Bag of Foreign Rice Share', 'Foreign Rice', 4, 3, 18500.00, 'Mandate', NOW() + INTERVAL '2 days'),
    ('100 Tubers of Laboko Yam Share', 'Yam (Laboko)', 5, 2, 12000.00, 'Mandate', NOW() + INTERVAL '3 days'),
    ('Paint Rubber Garri Ijebu Share', 'Garri Ijebu', 6, 4, 3500.00, 'Ipata', NOW() + INTERVAL '1 day');

-- Seed Ilorin Key Route Corridors
INSERT INTO delivery_pools (pool_code, route_name, destination_zone, base_shuttle_fee, cutoff_time) 
VALUES
    ('POL-ALHIKMAH-01', 'Mandate Market ➔ Al-Hikmah / Apalara Route', 'Al-Hikmah / Apalara', 1300.00, NOW() + INTERVAL '2 hours'),
    ('POL-IREWOLEDE-01', 'Mandate Market ➔ Irewolede / Unity Road Route', 'Irewolede / Unity', 1300.00, NOW() + INTERVAL '3 hours'),
    ('POL-UNILORIN-01', 'Mandate Market ➔ Tanke / Unilorin Gate Route', 'Tanke / Unilorin', 1800.00, NOW() + INTERVAL '4 hours'),
    ('POL-CHALLENGE-01', 'Mandate Market ➔ Challenge / Fate Route', 'Challenge / Fate', 1800.00, NOW() + INTERVAL '2 hours');

-- ================================================
-- PERFORMANCE INDEXES
-- ================================================
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_order_code ON orders(order_code);
CREATE INDEX idx_market_prices_item_name ON market_prices(item_name);
CREATE INDEX idx_market_prices_brand ON market_prices(brand_or_variant);
CREATE INDEX idx_vendor_products_vendor ON vendor_products(vendor_id);
CREATE INDEX idx_vendor_products_category ON vendor_products(category);
CREATE INDEX idx_pool_memberships_user_id ON pool_memberships(user_id);