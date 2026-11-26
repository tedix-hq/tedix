-- Owned-channel publish authorization used to find the publishing tedi by
-- `metadata.ownedChannel.publisherTediSlug`, but retiring a tedi renames its
-- slug, so the lookup silently stopped matching. The canonical setting is now
-- `metadata.ownedChannel.publisherTediId`, a stable tedi id. Backfill it from
-- the configured slug: prefer the non-retired tedi currently holding the slug,
-- then a retired tedi whose `retired_slug` preserves it (it can never publish
-- again, but the id keeps the record honest). Settings an organization already
-- chose, and organizations with no publisher slug, are left alone.
UPDATE `organizations`
SET `metadata` = json_set(
	`metadata`,
	'$.ownedChannel.publisherTediId',
	(
		SELECT `t`.`id`
		FROM `tedis` AS `t`
		WHERE `t`.`organization_id` = `organizations`.`id`
			AND (
				(
					`t`.`slug` = json_extract(
						`organizations`.`metadata`,
						'$.ownedChannel.publisherTediSlug'
					)
					AND `t`.`retired_at` IS NULL
				)
				OR `t`.`retired_slug` = json_extract(
					`organizations`.`metadata`,
					'$.ownedChannel.publisherTediSlug'
				)
			)
		ORDER BY
			CASE
				WHEN `t`.`slug` = json_extract(
					`organizations`.`metadata`,
					'$.ownedChannel.publisherTediSlug'
				)
					AND `t`.`retired_at` IS NULL
				THEN 0
				ELSE 1
			END,
			`t`.`created_at` DESC
		LIMIT 1
	)
)
WHERE json_valid(`metadata`)
	AND json_type(`metadata`, '$.ownedChannel') = 'object'
	AND json_type(`metadata`, '$.ownedChannel.publisherTediSlug') = 'text'
	AND json_type(`metadata`, '$.ownedChannel.publisherTediId') IS NULL
	AND EXISTS (
		SELECT 1
		FROM `tedis` AS `t`
		WHERE `t`.`organization_id` = `organizations`.`id`
			AND (
				(
					`t`.`slug` = json_extract(
						`organizations`.`metadata`,
						'$.ownedChannel.publisherTediSlug'
					)
					AND `t`.`retired_at` IS NULL
				)
				OR `t`.`retired_slug` = json_extract(
					`organizations`.`metadata`,
					'$.ownedChannel.publisherTediSlug'
				)
			)
	);
