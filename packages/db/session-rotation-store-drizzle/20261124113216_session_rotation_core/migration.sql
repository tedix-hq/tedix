-- Baseline for objects that already hold these tables: IF NOT EXISTS lets
-- them adopt the chain unchanged. Their shape never changed before this.
CREATE TABLE IF NOT EXISTS `logout_replay_fingerprints` (
	`fingerprint` text PRIMARY KEY,
	`logged_out_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `refresh_rotation_state` (
	`singleton` integer PRIMARY KEY,
	`generation` integer NOT NULL,
	`current_fingerprint` text,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "refresh_rotation_state_singleton" CHECK("singleton" = 1),
	CONSTRAINT "refresh_rotation_state_status" CHECK("status" IN ('ready', 'reauth_required'))
);
