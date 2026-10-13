ALTER TABLE trades ADD COLUMN entry_price REAL;
ALTER TABLE trades ADD COLUMN add_price REAL;
ALTER TABLE trades ADD COLUMN exit_price REAL;

INSERT OR IGNORE INTO settings (category, label, value, sort_order, is_active)
SELECT 'symbol', TRIM(symbol), TRIM(symbol), MIN(id), 1
FROM trades
WHERE symbol IS NOT NULL AND TRIM(symbol) != ''
GROUP BY TRIM(symbol);

INSERT OR IGNORE INTO settings (category, label, value, sort_order, is_active)
VALUES ('symbol', 'XAUUSD', 'XAUUSD', 1, 1);
