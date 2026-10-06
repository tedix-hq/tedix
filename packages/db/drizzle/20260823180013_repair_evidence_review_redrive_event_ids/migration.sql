UPDATE work_events
SET id = lower(
  hex(randomblob(4)) || '-' ||
  hex(randomblob(2)) || '-' ||
  '4' || substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
  hex(randomblob(6))
)
WHERE actor_id = 'evidence-review-redrive'
  AND id LIKE 'evidence-review-wake:%';
