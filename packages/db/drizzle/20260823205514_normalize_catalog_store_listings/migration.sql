UPDATE `app_catalog_store_listings`
SET
	`source` = 'tedix',
	`source_app_id` = 'tedix:' || substr(`source_app_id`, length('tenant:') + 1)
WHERE `source` = 'tenant'
	AND `source_app_id` LIKE 'tenant:%';
--> statement-breakpoint

UPDATE `app_catalog_store_listings`
SET `id` = lower(
	substr(`id`, 4, 8) || '-' ||
	substr(`id`, 12, 4) || '-4' ||
	substr(`id`, 17, 3) || '-a' ||
	substr(`id`, 21, 3) || '-' ||
	substr(`id`, 24, 12)
)
WHERE `id` GLOB 'sl_[0-9a-fA-F]*'
	AND `id` NOT GLOB 'sl_*[^0-9a-fA-F]*'
	AND length(`id`) = 35;
