-- 将旧版逐笔交易截图迁移为按交易日期共享的每日 K 线。
-- 同一天存在多张图时，选择最近更新的交易截图；已有每日 K 线绝不覆盖。
INSERT INTO daily_chart_images (trade_date, image_id, image_url)
SELECT trade_date, image_id, image_url
FROM (
  SELECT
    substr(t.entry_time, 1, 10) AS trade_date,
    i.id AS image_id,
    '/i/' || i.public_id AS image_url,
    ROW_NUMBER() OVER (
      PARTITION BY substr(t.entry_time, 1, 10)
      ORDER BY datetime(t.updated_at) DESC, t.id DESC, i.id DESC
    ) AS priority
  FROM trades t
  JOIN images i
    ON t.chart_image = '/i/' || i.public_id
    OR t.chart_image LIKE '%/i/' || i.public_id
  WHERE t.chart_image IS NOT NULL
    AND trim(t.chart_image) != ''
    AND i.public_id IS NOT NULL
    AND substr(t.entry_time, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
)
WHERE priority = 1
ON CONFLICT(trade_date) DO NOTHING;
