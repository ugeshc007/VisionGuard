CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cameras (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
  zone TEXT NOT NULL DEFAULT '',
  stream_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'online',
  fps INTEGER NOT NULL DEFAULT 20,
  health INTEGER NOT NULL DEFAULT 90,
  ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS camera_role TEXT NOT NULL DEFAULT 'area';
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS stream_alias TEXT NOT NULL DEFAULT '';
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS gateway_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS stream_mode TEXT NOT NULL DEFAULT 'hls';
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS min_face_size INTEGER NOT NULL DEFAULT 48;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS quality_threshold INTEGER NOT NULL DEFAULT 45;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS detection_interval_ms INTEGER NOT NULL DEFAULT 650;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS recognition_threshold NUMERIC(6,4) NOT NULL DEFAULT 0.82;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS retention_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS blur_untrusted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'employee',
  department TEXT DEFAULT '',
  access_level TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'authorized',
  face_status TEXT NOT NULL DEFAULT 'enrolled',
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE people ADD COLUMN IF NOT EXISTS watchlist_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN IF NOT EXISTS privacy_consent TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE people ADD COLUMN IF NOT EXISTS retention_until DATE;

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  plate TEXT NOT NULL,
  owner TEXT DEFAULT '',
  type TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'registered',
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  schedule TEXT NOT NULL DEFAULT 'always',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  action TEXT NOT NULL DEFAULT 'notify',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  vehicle_id TEXT REFERENCES vehicles(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  confidence INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT DEFAULT '',
  acknowledged_by TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_camera_id ON events(camera_id);

CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
  attendance_date DATE NOT NULL DEFAULT CURRENT_DATE,
  check_in TEXT DEFAULT '',
  check_out TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'present',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not-configured',
  endpoint TEXT DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'System',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS camera_captures (
  id TEXT PRIMARY KEY,
  camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'local-camera',
  image_mime TEXT NOT NULL DEFAULT 'image/jpeg',
  image_data BYTEA NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  face_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_camera_captures_created_at ON camera_captures(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_camera_captures_camera_id ON camera_captures(camera_id);

CREATE TABLE IF NOT EXISTS detected_faces (
  id TEXT PRIMARY KEY,
  capture_id TEXT REFERENCES camera_captures(id) ON DELETE CASCADE,
  camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  label TEXT DEFAULT '',
  category TEXT NOT NULL DEFAULT 'visitor',
  status TEXT NOT NULL DEFAULT 'untrained',
  confidence INTEGER NOT NULL DEFAULT 0,
  box JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding JSONB NOT NULL DEFAULT '[]'::jsonb,
  face_mime TEXT NOT NULL DEFAULT 'image/jpeg',
  face_image BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_detected_faces_created_at ON detected_faces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_detected_faces_category ON detected_faces(category);
CREATE INDEX IF NOT EXISTS idx_detected_faces_status ON detected_faces(status);

ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS matched_person_id TEXT REFERENCES people(id) ON DELETE SET NULL;
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS match_score NUMERIC(6,4) DEFAULT 0;
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS identity_result TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS quality_status TEXT NOT NULL DEFAULT 'unchecked';
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS quality_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS embedding_vector vector(512);
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'browser-lightweight';
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS embedding_dim INTEGER NOT NULL DEFAULT 0;
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS track_id TEXT;
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS cluster_id TEXT;
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS face_area INTEGER NOT NULL DEFAULT 0;
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS blur_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS save_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE detected_faces ADD COLUMN IF NOT EXISTS low_quality_reason TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_detected_faces_matched_person_id ON detected_faces(matched_person_id);
CREATE INDEX IF NOT EXISTS idx_detected_faces_identity_result ON detected_faces(identity_result);
CREATE INDEX IF NOT EXISTS idx_detected_faces_embedding_vector ON detected_faces USING ivfflat (embedding_vector vector_cosine_ops) WITH (lists = 32);
CREATE INDEX IF NOT EXISTS idx_detected_faces_track_id ON detected_faces(track_id);
CREATE INDEX IF NOT EXISTS idx_detected_faces_cluster_id ON detected_faces(cluster_id);

CREATE TABLE IF NOT EXISTS person_tracks (
  id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  visitor_label TEXT NOT NULL DEFAULT '',
  cluster_id TEXT NOT NULL DEFAULT '',
  camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
  site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'visitor',
  identity_result TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'active',
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  best_face_id TEXT REFERENCES detected_faces(id) ON DELETE SET NULL,
  best_score INTEGER NOT NULL DEFAULT 0,
  detection_count INTEGER NOT NULL DEFAULT 1,
  match_score NUMERIC(6,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_person_tracks_person_id ON person_tracks(person_id);
CREATE INDEX IF NOT EXISTS idx_person_tracks_visitor_label ON person_tracks(visitor_label);
CREATE INDEX IF NOT EXISTS idx_person_tracks_camera_id ON person_tracks(camera_id);
CREATE INDEX IF NOT EXISTS idx_person_tracks_last_seen ON person_tracks(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_person_tracks_cluster_id ON person_tracks(cluster_id);

CREATE TABLE IF NOT EXISTS face_merge_audit (
  id TEXT PRIMARY KEY,
  source_face_id TEXT,
  target_face_id TEXT,
  source_label TEXT DEFAULT '',
  target_label TEXT DEFAULT '',
  action TEXT NOT NULL DEFAULT 'merge',
  actor TEXT NOT NULL DEFAULT 'Security Admin',
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS privacy_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  retention_days INTEGER NOT NULL DEFAULT 30,
  delete_untrained_after_days INTEGER NOT NULL DEFAULT 7,
  blur_unknown BOOLEAN NOT NULL DEFAULT FALSE,
  allow_export BOOLEAN NOT NULL DEFAULT TRUE,
  consent_required BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO privacy_policies (id, name, retention_days, delete_untrained_after_days, blur_unknown, allow_export, consent_required, active)
VALUES ('default', 'Default face privacy policy', 30, 7, false, true, false, true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS identity_visits (
  id TEXT PRIMARY KEY,
  face_id TEXT REFERENCES detected_faces(id) ON DELETE SET NULL,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
  site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'visitor',
  identity_result TEXT NOT NULL DEFAULT 'unknown',
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  match_score NUMERIC(6,4) DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_identity_visits_created_at ON identity_visits(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_visits_person_id ON identity_visits(person_id);
CREATE INDEX IF NOT EXISTS idx_identity_visits_category ON identity_visits(category);

CREATE TABLE IF NOT EXISTS area_dwell_sessions (
  id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  visitor_label TEXT NOT NULL DEFAULT '',
  camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
  site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
  area_name TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'visitor',
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  detection_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_area_dwell_sessions_area ON area_dwell_sessions(area_name);
CREATE INDEX IF NOT EXISTS idx_area_dwell_sessions_person ON area_dwell_sessions(person_id);
CREATE INDEX IF NOT EXISTS idx_area_dwell_sessions_last_seen ON area_dwell_sessions(last_seen DESC);

CREATE TABLE IF NOT EXISTS person_flow_events (
  id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  visitor_label TEXT NOT NULL DEFAULT '',
  camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
  site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
  area_name TEXT NOT NULL DEFAULT '',
  flow_direction TEXT NOT NULL DEFAULT 'entry',
  category TEXT NOT NULL DEFAULT 'visitor',
  event_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_person_flow_events_date ON person_flow_events(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_person_flow_events_direction ON person_flow_events(flow_direction);
CREATE INDEX IF NOT EXISTS idx_person_flow_events_person ON person_flow_events(person_id);
CREATE INDEX IF NOT EXISTS idx_person_flow_events_camera ON person_flow_events(camera_id);
