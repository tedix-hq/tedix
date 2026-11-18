-- Private ops takes a row in this table before every production release,
-- including the one that applies migrations; 20261118032404 dropped it and
-- stopped every deploy. Ops now recreates it before locking, so this must be
-- a no-op when the table already exists.
CREATE TABLE IF NOT EXISTS `release_locks` (
	`surface` text PRIMARY KEY,
	`owner_token` text NOT NULL,
	`target_sha` text NOT NULL,
	`started_at` integer NOT NULL,
	`github_run_id` text,
	`github_job_id` text
);
