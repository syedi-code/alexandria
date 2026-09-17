-- Count records older than 3 months in each table
-- Run with: npm run sql:production -- sql/maintenance/count-old-records.sql

SELECT 'notes' as table_name, COUNT(*) as records_to_delete
FROM notes
WHERE created_at < datetime('now', '-3 months')
UNION ALL
SELECT 'quotes', COUNT(*)
FROM quotes
WHERE created_at < datetime('now', '-3 months')
UNION ALL
SELECT 'media', COUNT(*)
FROM media
WHERE created_at < datetime('now', '-3 months')
UNION ALL
SELECT 'links', COUNT(*)
FROM links
WHERE created_at < datetime('now', '-3 months')
UNION ALL
SELECT 'sleep', COUNT(*)
FROM sleep
WHERE created_at < datetime('now', '-3 months')
UNION ALL
SELECT 'weather_daily', COUNT(*)
FROM weather_daily
WHERE date < date('now', '-3 months')
UNION ALL
SELECT 'news_daily', COUNT(*)
FROM news_daily
WHERE date < date('now', '-3 months');
