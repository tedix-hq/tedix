-- Baseline for intents that already hold this table: IF NOT EXISTS lets them
-- adopt the chain unchanged. Older intents get their later columns from
-- adoptLegacyIntentColumns() first.
CREATE TABLE IF NOT EXISTS `session_intent` (
	`singleton` integer PRIMARY KEY,
	`intent_json` text NOT NULL,
	`status` text NOT NULL,
	`code_hash` text,
	`code_expires_at` integer,
	`grant_kind` text,
	`granted_tenant_id` text,
	`session_jwt` text,
	`subject` text,
	`session_expires_at` integer,
	`updated_at` integer NOT NULL,
	`reauth_started_at` integer,
	CONSTRAINT "session_intent_singleton" CHECK("singleton" = 1),
	CONSTRAINT "session_intent_status" CHECK("status" IN ('pending', 'granted', 'consumed', 'failed')),
	CONSTRAINT "session_intent_grant_kind" CHECK("grant_kind" IN ('session', 'logout'))
);
