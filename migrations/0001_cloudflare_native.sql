PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('guest','staff','manager','admin')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hotel_profile (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  hero_image TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Standard','Deluxe','Executive')),
  image TEXT NOT NULL,
  nightly_rate INTEGER NOT NULL CHECK (nightly_rate > 0),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 3),
  size INTEGER NOT NULL CHECK (size > 0),
  bed TEXT NOT NULL,
  view TEXT NOT NULL,
  amenities TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(amenities)),
  description TEXT NOT NULL,
  inventory INTEGER NOT NULL DEFAULT 0 CHECK (inventory BETWEEN 0 AND 1000),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  bookings_revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  request_id TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  room_slug TEXT NOT NULL,
  room_name TEXT NOT NULL,
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  guests INTEGER NOT NULL CHECK (guests BETWEEN 1 AND 3),
  nightly_rate INTEGER NOT NULL CHECK (nightly_rate > 0),
  total_amount INTEGER NOT NULL CHECK (total_amount >= 100),
  currency TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','expired','cancelled')),
  expires_at TEXT NOT NULL,
  payment_id TEXT,
  latest_payment_reference TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(guest_id, request_id),
  CHECK (check_out > check_in)
);

CREATE INDEX IF NOT EXISTS idx_bookings_room_dates ON bookings(room_id,status,check_in,check_out,expires_at);
CREATE INDEX IF NOT EXISTS idx_bookings_guest ON bookings(guest_id,created_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  guest_id TEXT NOT NULL REFERENCES users(id),
  reference TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL CHECK (amount >= 100),
  currency TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','abandoned','review_required','refund_required','refunded')),
  authorization_url TEXT NOT NULL DEFAULT '',
  channel TEXT,
  paid_at TEXT,
  refund_status TEXT NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none','requested','pending','processing','processed','failed')),
  refund_reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_successful_payment_per_booking ON payments(booking_id) WHERE status = 'success';
CREATE INDEX IF NOT EXISTS idx_payments_guest ON payments(guest_id,created_at);

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  guest_id TEXT NOT NULL REFERENCES users(id),
  arrival_time TEXT NOT NULL,
  document_kind TEXT NOT NULL,
  document_object_key TEXT,
  document_mime TEXT,
  document_delete_at TEXT,
  document_deleted_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_checkins_status ON checkins(status,submitted_at);
CREATE INDEX IF NOT EXISTS idx_checkins_guest ON checkins(guest_id);

CREATE TABLE IF NOT EXISTS room_keys (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  guest_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS service_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  price INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS service_requests (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  guest_id TEXT NOT NULL REFERENCES users(id),
  category_id TEXT REFERENCES service_categories(id),
  type TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','cancelled')),
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_service_requests_guest ON service_requests(guest_id,requested_at);

CREATE TABLE IF NOT EXISTS concierge_messages (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  booking_id TEXT REFERENCES bookings(id),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_concierge_messages_guest ON concierge_messages(guest_id,created_at);

CREATE TABLE IF NOT EXISTS loyalty_rules (
  id TEXT PRIMARY KEY,
  points_per_night INTEGER NOT NULL CHECK (points_per_night BETWEEN 0 AND 10000),
  effective_at TEXT NOT NULL,
  changed_by TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS loyalty_awards (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES users(id),
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  paid_payment_id TEXT NOT NULL REFERENCES payments(id),
  nights INTEGER NOT NULL CHECK (nights BETWEEN 1 AND 365),
  points_per_night INTEGER NOT NULL,
  points INTEGER NOT NULL,
  awarded_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_loyalty_awards_guest ON loyalty_awards(guest_id,awarded_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_id TEXT,
  booking_id TEXT,
  payment_id TEXT,
  details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
