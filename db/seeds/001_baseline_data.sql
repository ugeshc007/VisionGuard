INSERT INTO sites (id, name, address, status)
VALUES
  ('site-hq', 'Head Office', 'Main branch / reception and operations floor', 'active')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    address = EXCLUDED.address,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO cameras (
  id, name, site_id, zone, stream_url, status, fps, health, ai_enabled,
  camera_role, stream_alias, gateway_enabled, stream_mode,
  min_face_size, quality_threshold, detection_interval_ms, recognition_threshold, retention_days
)
VALUES
  ('cam-entry-main', 'Main Entry Camera', 'site-hq', 'Main Entry', '', 'online', 20, 92, true, 'entry', 'main-entry', true, 'hls', 80, 62, 650, 0.82, 30),
  ('cam-lobby', 'Lobby Camera', 'site-hq', 'Lobby', '', 'online', 20, 90, true, 'area', 'lobby', true, 'hls', 80, 62, 650, 0.82, 30),
  ('cam-exit-main', 'Main Exit Camera', 'site-hq', 'Main Exit', '', 'online', 20, 91, true, 'exit', 'main-exit', true, 'hls', 80, 62, 650, 0.82, 30)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    site_id = EXCLUDED.site_id,
    zone = EXCLUDED.zone,
    status = EXCLUDED.status,
    fps = EXCLUDED.fps,
    health = EXCLUDED.health,
    ai_enabled = EXCLUDED.ai_enabled,
    camera_role = EXCLUDED.camera_role,
    stream_alias = EXCLUDED.stream_alias,
    gateway_enabled = EXCLUDED.gateway_enabled,
    stream_mode = EXCLUDED.stream_mode,
    min_face_size = EXCLUDED.min_face_size,
    quality_threshold = EXCLUDED.quality_threshold,
    detection_interval_ms = EXCLUDED.detection_interval_ms,
    recognition_threshold = EXCLUDED.recognition_threshold,
    retention_days = EXCLUDED.retention_days,
    updated_at = now();

INSERT INTO people (id, name, category, department, access_level, status, face_status, last_seen)
VALUES
  ('person-security-admin', 'Security Admin', 'employee', 'Security', 'admin', 'authorized', 'enrolled', now()),
  ('person-reception-demo', 'Reception Staff', 'employee', 'Front Office', 'standard', 'authorized', 'pending', now()),
  ('person-customer-demo', 'VIP Customer', 'customer', 'Customer', 'visitor', 'authorized', 'pending', now())
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    category = EXCLUDED.category,
    department = EXCLUDED.department,
    access_level = EXCLUDED.access_level,
    status = EXCLUDED.status,
    face_status = EXCLUDED.face_status,
    updated_at = now();

INSERT INTO rules (id, name, type, camera_id, severity, schedule, enabled, action)
VALUES
  ('rule-watchlist-entry', 'Watchlist person at entry', 'watchlist-face', 'cam-entry-main', 'critical', 'always', true, 'notify'),
  ('rule-after-hours', 'After-hours movement', 'after-hours-person', null, 'high', 'outside-business-hours', true, 'notify'),
  ('rule-unknown-loitering', 'Unknown visitor dwell time', 'area-dwell', 'cam-lobby', 'medium', 'always', true, 'notify')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    type = EXCLUDED.type,
    camera_id = EXCLUDED.camera_id,
    severity = EXCLUDED.severity,
    schedule = EXCLUDED.schedule,
    enabled = EXCLUDED.enabled,
    action = EXCLUDED.action,
    updated_at = now();

INSERT INTO notification_channels (id, name, status, endpoint, enabled)
VALUES
  ('notify-dashboard', 'Dashboard Alerts', 'ready', '/api/events', true),
  ('notify-email', 'Email', 'not-configured', '', false),
  ('notify-whatsapp', 'WhatsApp', 'not-configured', '', false),
  ('notify-slack', 'Slack', 'not-configured', '', false)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    status = EXCLUDED.status,
    endpoint = EXCLUDED.endpoint,
    enabled = EXCLUDED.enabled,
    updated_at = now();

INSERT INTO audit_logs (id, action, detail, actor)
VALUES ('audit-seed-baseline', 'baseline_seeded', 'VisionGuard baseline deployment data loaded.', 'Deployment')
ON CONFLICT (id) DO NOTHING;
