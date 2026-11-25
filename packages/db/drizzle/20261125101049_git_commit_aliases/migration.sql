CREATE TABLE `git_commit_aliases` (
	`old_sha` text PRIMARY KEY,
	`new_sha` text NOT NULL UNIQUE,
	`repository` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
