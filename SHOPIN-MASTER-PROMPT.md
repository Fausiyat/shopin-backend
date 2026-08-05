-- Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shopin_id VARCHAR(12) UNIQUE NOT NULL, -- e.g. SHP-ILR-1024
    full_name VARCHAR(100) NOT NULL,
    phone_number VARCHAR(15) UNIQUE NOT NULL,
    email VARCHAR(100),
    user_role VARCHAR(20) DEFAULT 'consumer', -- consumer, vendor, shopper, rider, admin
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Delivery Addresses with Ilorin Checkpoints
CREATE TABLE user_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    address_label VARCHAR(20) DEFAULT 'HOME', -- HOME, HOSTEL, OFFICE
    zone_name VARCHAR(50) NOT NULL, -- e.g. Tanke/Unilorin Axis
    major_checkpoint VARCHAR(100) NOT NULL, -- e.g. Tipper Garage
    detailed_address TEXT NOT NULL, -- e.g. Green storey building behind Sanrab
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Ilorin Market Price Index
CREATE TABLE market_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_name VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL,
    unit VARCHAR(30) NOT NULL, -- paint_rubber, derica, tuber, kg
    min_price_ngn NUMERIC(10,2) NOT NULL,
    max_price_ngn NUMERIC(10,2) NOT NULL,
    sourcing_market VARCHAR(50) DEFAULT 'Mandate', -- Mandate, Ipata, Sawmill
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Orders Table
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_code VARCHAR(15) UNIQUE NOT NULL,
    user_id UUID REFERENCES users(id),
    channel VARCHAR(10) NOT NULL, -- WEB, SMS, WHATSAPP, EMAIL
    raw_input_text TEXT NOT NULL,
    parsed_json JSONB NOT NULL,
    estimated_item_cost NUMERIC(10,2) NOT NULL,
    service_fee NUMERIC(10,2) NOT NULL,
    delivery_fee NUMERIC(10,2) NOT NULL,
    total_estimated_cost NUMERIC(10,2) NOT NULL,
    order_status VARCHAR(30) DEFAULT 'PENDING_CONFIRMATION', -- PENDING, CONFIRMED, PURCHASING, DELIVERING, COMPLETED, CANCELLED
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
