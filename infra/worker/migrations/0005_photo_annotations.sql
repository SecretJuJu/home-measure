-- Pen marks and measurement lines drawn on a photo, stored beside its metadata.
-- Nullable and additive: a photo taken before this release simply has no annotation.
ALTER TABLE photos ADD COLUMN annotation_json TEXT;
