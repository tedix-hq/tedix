ALTER TABLE `provider_event_channels` ADD `signing_secret_ciphertext` text;--> statement-breakpoint
ALTER TABLE `provider_event_deliveries` ADD `payload` text;--> statement-breakpoint
ALTER TABLE `provider_event_subscriptions` ADD `mcp_app_id` text;--> statement-breakpoint
ALTER TABLE `provider_event_subscriptions` ADD `event_arguments` text;--> statement-breakpoint
ALTER TABLE `provider_event_subscriptions` ADD `event_cursor` text;--> statement-breakpoint
ALTER TABLE `provider_event_subscriptions` ADD `max_wakes_per_hour` integer;--> statement-breakpoint
ALTER TABLE `provider_event_subscriptions` ADD `wake_window_started_at` text;--> statement-breakpoint
ALTER TABLE `provider_event_subscriptions` ADD `wake_window_count` integer DEFAULT 0 NOT NULL;