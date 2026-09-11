PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS properties_user_id_idx ON properties(user_id);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS rooms_property_id_idx ON rooms(property_id);

CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  room_id TEXT,
  element_id TEXT,
  label TEXT NOT NULL,
  category TEXT,
  required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('pending', 'complete', 'skipped')),
  measurement_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE,
  FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS checklist_items_property_id_idx ON checklist_items(property_id);
CREATE INDEX IF NOT EXISTS checklist_items_room_id_idx ON checklist_items(room_id);

CREATE TABLE IF NOT EXISTS measurements (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  room_id TEXT,
  element_id TEXT,
  checklist_item_id TEXT,
  type TEXT NOT NULL,
  value REAL,
  unit TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE,
  FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE SET NULL,
  FOREIGN KEY(checklist_item_id) REFERENCES checklist_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS measurements_property_id_idx ON measurements(property_id);
CREATE INDEX IF NOT EXISTS measurements_checklist_item_id_idx ON measurements(checklist_item_id);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  room_id TEXT,
  element_id TEXT,
  checklist_item_id TEXT,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE,
  FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE SET NULL,
  FOREIGN KEY(checklist_item_id) REFERENCES checklist_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS photos_property_id_idx ON photos(property_id);
CREATE INDEX IF NOT EXISTS photos_user_id_idx ON photos(user_id);

CREATE TABLE IF NOT EXISTS idempotent_mutations (
  user_id TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, client_mutation_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
