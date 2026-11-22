-- Owned-channel publishing used to allow one tedi slug and one collection
-- fixed in shared code. Both are now the organization's own settings:
-- `metadata.ownedChannel.publisherTediSlug` and `.collection`. Keep existing
-- receipts usable by copying them from each organization's latest receipt:
-- the collection it names and the slug of the active tedi that owns its Work.
-- Settings an organization already chose are left alone. Receipts do not name
-- locales, so an organization that already issued one keeps the single locale
-- the shared rule used to allow; owners can change the list afterwards.
UPDATE `organizations`
SET `metadata` = json_set(
	`metadata`,
	'$.ownedChannel.collection',
	(
		SELECT json_extract(json_extract(`e`.`payload`, '$.body'), '$.collection')
		FROM `work_events` AS `e`
		WHERE `e`.`org_id` = `organizations`.`id`
			AND `e`.`event_type` = 'owned_channel_authorization'
			AND json_valid(json_extract(`e`.`payload`, '$.body'))
			AND json_type(json_extract(`e`.`payload`, '$.body'), '$.collection') = 'text'
		ORDER BY `e`.`occurred_at` DESC
		LIMIT 1
	)
)
WHERE json_valid(`metadata`)
	AND json_type(`metadata`, '$.ownedChannel') = 'object'
	AND json_type(`metadata`, '$.ownedChannel.collection') IS NULL
	AND EXISTS (
		SELECT 1
		FROM `work_events` AS `e`
		WHERE `e`.`org_id` = `organizations`.`id`
			AND `e`.`event_type` = 'owned_channel_authorization'
			AND json_valid(json_extract(`e`.`payload`, '$.body'))
			AND json_type(json_extract(`e`.`payload`, '$.body'), '$.collection') = 'text'
	);
--> statement-breakpoint
UPDATE `organizations`
SET `metadata` = json_set(
	`metadata`,
	'$.ownedChannel.publisherTediSlug',
	(
		SELECT `t`.`slug`
		FROM `work_events` AS `e`
		INNER JOIN `work_items` AS `w`
			ON `w`.`id` = `e`.`work_item_id`
			AND `w`.`org_id` = `e`.`org_id`
			AND `w`.`accountable_owner_type` = 'tedi'
		INNER JOIN `tedis` AS `t`
			ON `t`.`id` = `w`.`accountable_owner_id`
			AND `t`.`organization_id` = `e`.`org_id`
			AND `t`.`status` = 'active'
		WHERE `e`.`org_id` = `organizations`.`id`
			AND `e`.`event_type` = 'owned_channel_authorization'
		ORDER BY `e`.`occurred_at` DESC
		LIMIT 1
	)
)
WHERE json_valid(`metadata`)
	AND json_type(`metadata`, '$.ownedChannel') = 'object'
	AND json_type(`metadata`, '$.ownedChannel.publisherTediSlug') IS NULL
	AND EXISTS (
		SELECT 1
		FROM `work_events` AS `e`
		INNER JOIN `work_items` AS `w`
			ON `w`.`id` = `e`.`work_item_id`
			AND `w`.`org_id` = `e`.`org_id`
			AND `w`.`accountable_owner_type` = 'tedi'
		INNER JOIN `tedis` AS `t`
			ON `t`.`id` = `w`.`accountable_owner_id`
			AND `t`.`organization_id` = `e`.`org_id`
			AND `t`.`status` = 'active'
		WHERE `e`.`org_id` = `organizations`.`id`
			AND `e`.`event_type` = 'owned_channel_authorization'
	);
--> statement-breakpoint
UPDATE `organizations`
SET `metadata` = json_set(`metadata`, '$.ownedChannel.locales', json_array('en'))
WHERE json_valid(`metadata`)
	AND json_type(`metadata`, '$.ownedChannel') = 'object'
	AND json_type(`metadata`, '$.ownedChannel.locales') IS NULL
	AND EXISTS (
		SELECT 1
		FROM `work_events` AS `e`
		WHERE `e`.`org_id` = `organizations`.`id`
			AND `e`.`event_type` = 'owned_channel_authorization'
	);
