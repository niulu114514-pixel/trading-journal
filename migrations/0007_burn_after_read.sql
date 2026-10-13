ALTER TABLE share_links ADD COLUMN burn_after_read INTEGER NOT NULL DEFAULT 0;
ALTER TABLE share_links ADD COLUMN burned_at TEXT;
ALTER TABLE share_links ADD COLUMN burn_access_hash TEXT;
