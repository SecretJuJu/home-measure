ALTER TABLE photos ADD COLUMN upload_status TEXT NOT NULL DEFAULT 'pending'
  CHECK(upload_status IN ('pending', 'uploaded'));
ALTER TABLE photos ADD COLUMN uploaded_at INTEGER;

CREATE INDEX IF NOT EXISTS photos_upload_status_idx ON photos(upload_status);
