ALTER TABLE cameras
  ALTER COLUMN min_face_size SET DEFAULT 48,
  ALTER COLUMN quality_threshold SET DEFAULT 45;

UPDATE cameras
SET min_face_size = 48,
    quality_threshold = 45,
    updated_at = now()
WHERE stream_url ~* '^(rtsp|rtsps|http|https)://'
  AND min_face_size = 80
  AND quality_threshold = 62;
