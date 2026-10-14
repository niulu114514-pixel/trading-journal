CREATE TABLE IF NOT EXISTS daily_chart_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date TEXT NOT NULL UNIQUE,
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_daily_chart_images_date ON daily_chart_images(trade_date);
