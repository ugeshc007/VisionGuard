ALTER TABLE cameras
  ALTER COLUMN min_face_size SET DEFAULT 40,
  ALTER COLUMN quality_threshold SET DEFAULT 35;

UPDATE cameras
SET min_face_size = LEAST(COALESCE(min_face_size, 40), 40),
    quality_threshold = LEAST(COALESCE(quality_threshold, 35), 35),
    updated_at = now()
WHERE stream_url ~* '^(rtsp|rtsps|http|https)://';
