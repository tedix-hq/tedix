-- Give OS output revisions written before `access_envelope` existed the empty
-- envelope. The column arrived on 2026-09-03 with no backfill, so every older
-- revision holds NULL, and with no producing run to re-derive from, the reader
-- treats it as unverifiable: nobody, the owner included, can read it. Nothing
-- could cite a workspace source before envelopes existed, so empty is the
-- faithful value, the same one a human or external-agent author gets today.
-- Later NULLs are deliberate fail-closed results and stay untouched.
UPDATE `os_output_revisions`
SET `access_envelope` = '{"version":1,"sources":[]}'
WHERE `access_envelope` IS NULL
	AND `skill_run_id` IS NULL
	AND `created_at` < '2026-09-03';
