UPDATE `external_agent_attributions`
SET `target_type` = 'work_item_attempt'
WHERE `target_type` = 'work_item_checkout';--> statement-breakpoint
UPDATE `external_agent_attributions`
SET `metadata` = json_set(
	coalesce(`metadata`, '{}'),
	'$.provenanceCertification.source',
	'work_item_attempt'
)
WHERE json_extract(`metadata`, '$.provenanceCertification.source') = 'work_item_checkout';
