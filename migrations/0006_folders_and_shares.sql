CREATE TABLE IF NOT EXISTS image_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#3ec9c5',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE images ADD COLUMN folder_id INTEGER REFERENCES image_folders(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK (target_type IN ('image', 'folder', 'mindmap')),
  target_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  expires_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_folders_sort ON image_folders(sort_order, id);
CREATE INDEX IF NOT EXISTS idx_share_links_target ON share_links(target_type, target_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token);
CREATE INDEX IF NOT EXISTS idx_share_links_expiry ON share_links(expires_at) WHERE revoked_at IS NULL;
