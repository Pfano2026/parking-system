-- =====================================================================
-- SmartPark IoT - database schema (PostgreSQL)
-- Safe to run many times: server.js runs this file automatically on start.
-- You can also paste it into the Render database "psql" shell by hand.
-- =====================================================================

-- Admin-controlled settings (booking switch + hourly rate)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('system_open', 'true'),
  ('hourly_rate', '20')
ON CONFLICT (key) DO NOTHING;

-- The 4 parking bays. ir_occupied is written by the ESP32 IR sensors.
CREATE TABLE IF NOT EXISTS bays (
  id          INT PRIMARY KEY CHECK (id BETWEEN 1 AND 4),
  name        TEXT NOT NULL,
  ir_occupied BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO bays (id, name) VALUES
  (1, 'Bay 1'), (2, 'Bay 2'), (3, 'Bay 3'), (4, 'Bay 4')
ON CONFLICT (id) DO NOTHING;

-- Customer bookings. The 4-digit PIN is emailed to the customer.
-- Life cycle: reserved -> active (PIN at entry keypad) -> completed (same PIN at exit keypad)
--             reserved -> cancelled (customer) or expired (not used in time)
CREATE TABLE IF NOT EXISTS bookings (
  id             SERIAL PRIMARY KEY,
  bay_id         INT NOT NULL REFERENCES bays(id),
  customer_name  TEXT NOT NULL,
  email          TEXT NOT NULL,
  plate          TEXT NOT NULL,
  pin            CHAR(4) NOT NULL,
  access_token   TEXT NOT NULL UNIQUE,   -- kept in the customer's browser to find their booking
  status         TEXT NOT NULL DEFAULT 'reserved'
                 CHECK (status IN ('reserved','active','completed','cancelled','expired')),
  rate           NUMERIC(10,2) NOT NULL DEFAULT 20,   -- hourly rate locked in at booking time
  fee            NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_in_at  TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ
);

-- One open booking per bay, and one open booking per PIN (so a PIN is never ambiguous)
CREATE UNIQUE INDEX IF NOT EXISTS one_open_booking_per_bay
  ON bookings (bay_id) WHERE status IN ('reserved','active');
CREATE UNIQUE INDEX IF NOT EXISTS one_open_pin
  ON bookings (pin) WHERE status IN ('reserved','active');

-- Every email the system sends (also shown in the website "Email Inbox" tab)
CREATE TABLE IF NOT EXISTS emails (
  id         SERIAL PRIMARY KEY,
  booking_id INT REFERENCES bookings(id) ON DELETE SET NULL,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  delivery   TEXT NOT NULL DEFAULT 'inbox-only'   -- sent | inbox-only | failed
             CHECK (delivery IN ('sent','inbox-only','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ESP32 heartbeat: last_seen decides ONLINE / OFFLINE on the website
CREATE TABLE IF NOT EXISTS device_status (
  id        INT PRIMARY KEY CHECK (id = 1),
  last_seen TIMESTAMPTZ,
  ip        TEXT,
  rssi      INT,
  uptime_s  BIGINT
);

INSERT INTO device_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Manual gate commands from the admin dashboard, picked up by the ESP32
CREATE TABLE IF NOT EXISTS commands (
  id         SERIAL PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('open_entry','open_exit')),
  consumed   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
