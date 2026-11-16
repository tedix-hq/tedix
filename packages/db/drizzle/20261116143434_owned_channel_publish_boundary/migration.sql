-- Backfill the owned-channel publish boundary that apps/mcp governance.ts
-- hard-coded by app slug and tool id. Every stored CMS publish row (and the
-- source row of every aggregated `<namespace>__content_publish` tool) now
-- declares the same routes and connection label, so decisions are unchanged.
-- Rows whose config is not a JSON object are left for review.
UPDATE `app_tools`
SET `config` = json_set(
	coalesce(`config`, '{}'),
	'$.ownedChannelPublish',
	json('{"routes":["tedix-unified:cms_landing__content_publish","tedix-unified:cms_tedix__content_publish","tedix-unified:cms-tedix__content_publish","cms-tedix-landing:cms__content_publish","cms-tedix-landing:content_publish","cms-tedix:cms__content_publish","cms-tedix:content_publish"],"connectionLabels":["tedix"]}')
)
WHERE (`tool_id` = 'content_publish'
		OR substr(`tool_id`, -17) = '__content_publish')
	AND (`config` IS NULL
		OR (json_valid(`config`) AND json_type(`config`) = 'object'));
