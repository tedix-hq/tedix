ALTER TABLE `work_attempts` ADD `external_session_key` text;--> statement-breakpoint
UPDATE `work_attempts` SET
	`external_session_key` = `executor_session_id`,
	`metadata` = json_set(coalesce(`metadata`,'{}'),'$.migrationExternalSessionKey','grandfathered_from_executor_session_id')
WHERE `executor_type` = 'external_agent';--> statement-breakpoint
UPDATE `work_evidence` SET `id` = CASE
	WHEN `id` LIKE 'commit:%' THEN '10000000-0000-5000-8000-' || printf('%012x', rowid)
	WHEN `id` LIKE 'legacy:%' THEN '20000000-0000-5000-8000-' || printf('%012x', rowid)
	ELSE `id` END
WHERE `id` LIKE 'commit:%' OR `id` LIKE 'legacy:%';
--> statement-breakpoint
UPDATE `work_events` SET `id` = '30000000-0000-5000-8000-' || printf('%012x', rowid)
WHERE `id` LIKE 'comment:%';
--> statement-breakpoint
DROP INDEX `uniq_work_evidence_observation`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_evidence_observation` ON `work_evidence` (`org_id`,`work_item_id`,`claim_key`,`uri`,coalesce(`digest`,''));
--> statement-breakpoint
PRAGMA foreign_key_check;
