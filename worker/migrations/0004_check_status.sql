ALTER TABLE credentials ADD COLUMN last_attempt INTEGER;
ALTER TABLE credentials ADD COLUMN last_finished INTEGER;
ALTER TABLE credentials ADD COLUMN last_result TEXT;
-- Preserve verified successes without inventing timestamps for old failures.
UPDATE credentials SET last_attempt=last_checked,last_finished=last_checked,last_result='success'
  WHERE status='Check completed' AND last_checked IS NOT NULL;
UPDATE settings SET value='office' WHERE id='realtime_hours';
