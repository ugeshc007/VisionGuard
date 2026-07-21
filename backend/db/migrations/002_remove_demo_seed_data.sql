DELETE FROM audit_logs
WHERE id = 'audit-seed-baseline'
   OR action = 'baseline_seeded';

DELETE FROM rules
WHERE id IN (
  'rule-watchlist-entry',
  'rule-after-hours',
  'rule-unknown-loitering'
);

DELETE FROM people
WHERE id IN (
  'person-security-admin',
  'person-reception-demo',
  'person-customer-demo'
);

DELETE FROM cameras
WHERE id IN (
  'cam-entry-main',
  'cam-lobby',
  'cam-exit-main'
);

DELETE FROM sites
WHERE id = 'site-hq'
  AND NOT EXISTS (
    SELECT 1
    FROM cameras
    WHERE cameras.site_id = 'site-hq'
  );
