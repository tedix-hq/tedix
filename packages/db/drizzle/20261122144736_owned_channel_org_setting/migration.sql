-- Owned-channel receipts used to name one channel fixed in shared code. They
-- now name the organization's `metadata.ownedChannel.channel`, and the publish
-- boundary honors a receipt only while the two match. Keep existing receipts
-- valid by copying the channel from each organization's latest receipt.
-- Organizations that never issued one stay unset until an owner sets it.
-- Rows whose metadata is not a JSON object, or that already chose a channel,
-- are left alone.
UPDATE `organizations`
SET `metadata` = json_set(
	coalesce(`metadata`, '{}'),
	'$.ownedChannel',
	json_object('channel', (
		SELECT json_extract(json_extract(`e`.`payload`, '$.body'), '$.channel')
		FROM `work_events` AS `e`
		WHERE `e`.`org_id` = `organizations`.`id`
			AND `e`.`event_type` = 'owned_channel_authorization'
			AND json_valid(json_extract(`e`.`payload`, '$.body'))
			AND json_type(json_extract(`e`.`payload`, '$.body'), '$.channel') = 'text'
		ORDER BY `e`.`occurred_at` DESC
		LIMIT 1
	))
)
WHERE (`metadata` IS NULL
		OR (json_valid(`metadata`) AND json_type(`metadata`) = 'object'))
	AND json_type(coalesce(`metadata`, '{}'), '$.ownedChannel') IS NULL
	AND EXISTS (
		SELECT 1
		FROM `work_events` AS `e`
		WHERE `e`.`org_id` = `organizations`.`id`
			AND `e`.`event_type` = 'owned_channel_authorization'
			AND json_valid(json_extract(`e`.`payload`, '$.body'))
			AND json_type(json_extract(`e`.`payload`, '$.body'), '$.channel') = 'text'
	);
