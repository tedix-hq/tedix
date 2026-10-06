CREATE TABLE `release_locks` (
	`surface` text PRIMARY KEY,
	`owner_token` text NOT NULL,
	`target_sha` text NOT NULL,
	`started_at` integer NOT NULL
);
