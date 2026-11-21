ALTER TABLE `billing_accounts` ADD `stripe_webhook_customer_key` text;--> statement-breakpoint
ALTER TABLE `billing_accounts` ADD `stripe_webhook_event_created_at` integer;