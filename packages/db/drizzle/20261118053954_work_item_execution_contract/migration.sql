ALTER TABLE `work_items` ADD `executor_type` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD `executor_id` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD `dispatch_state` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD `delegation_depth` integer;--> statement-breakpoint
ALTER TABLE `work_items` ADD `max_attempts` integer;--> statement-breakpoint
ALTER TABLE `work_items` ADD `root_work_item_id` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD `root_goal` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD `budget_share_micros` integer;--> statement-breakpoint
UPDATE `work_items` SET
	`executor_type` = CASE
		WHEN json_type(`metadata`, '$.executor') IS NULL OR json_type(`metadata`, '$.executor') != 'text' OR length(json_extract(`metadata`, '$.executor')) NOT BETWEEN 1 AND 300 THEN NULL
		WHEN json_extract(`metadata`, '$.executor') = 'human' THEN 'human'
		WHEN json_extract(`metadata`, '$.executor') = 'tedi' THEN 'tedi'
		ELSE 'external_agent'
	END,
	`executor_id` = CASE
		WHEN json_extract(`metadata`, '$.executor') = 'human' AND `accountable_owner_type` = 'user' AND length(`accountable_owner_id`) BETWEEN 1 AND 300 THEN `accountable_owner_id`
		WHEN json_extract(`metadata`, '$.executor') = 'tedi' AND `accountable_owner_type` = 'tedi' AND length(`accountable_owner_id`) BETWEEN 1 AND 300 THEN `accountable_owner_id`
		WHEN json_type(`metadata`, '$.executor') = 'text' AND length(json_extract(`metadata`, '$.executor')) BETWEEN 1 AND 300 THEN json_extract(`metadata`, '$.executor')
	END,
	`dispatch_state` = CASE WHEN json_extract(`metadata`, '$.laneDispatch.state') IN ('held','ready') THEN json_extract(`metadata`, '$.laneDispatch.state') END,
	`delegation_depth` = CASE WHEN json_type(`metadata`, '$.laneExecution.delegationDepth') = 'integer' AND json_extract(`metadata`, '$.laneExecution.delegationDepth') BETWEEN 0 AND 10 THEN json_extract(`metadata`, '$.laneExecution.delegationDepth') END,
	`max_attempts` = CASE
		WHEN json_type(`metadata`, '$.laneExecution.maxAttempts') = 'integer' AND json_extract(`metadata`, '$.laneExecution.maxAttempts') BETWEEN 1 AND 20 THEN json_extract(`metadata`, '$.laneExecution.maxAttempts')
		WHEN json_type(`metadata`, '$.factoryCycle.maxAttempts') = 'integer' AND json_extract(`metadata`, '$.factoryCycle.maxAttempts') BETWEEN 1 AND 5 THEN json_extract(`metadata`, '$.factoryCycle.maxAttempts')
	END,
	`root_work_item_id` = CASE WHEN json_type(`metadata`, '$.rootWorkItemId') = 'text' AND (
		json_extract(`metadata`, '$.rootWorkItemId') = '00000000-0000-0000-0000-000000000000' OR (
			length(json_extract(`metadata`, '$.rootWorkItemId')) = 36
			AND substr(json_extract(`metadata`, '$.rootWorkItemId'), 9, 1) = '-'
			AND substr(json_extract(`metadata`, '$.rootWorkItemId'), 14, 1) = '-'
			AND lower(substr(json_extract(`metadata`, '$.rootWorkItemId'), 15, 1)) IN ('1','2','3','4','5','6','7','8')
			AND substr(json_extract(`metadata`, '$.rootWorkItemId'), 19, 1) = '-'
			AND lower(substr(json_extract(`metadata`, '$.rootWorkItemId'), 20, 1)) IN ('8','9','a','b')
			AND substr(json_extract(`metadata`, '$.rootWorkItemId'), 24, 1) = '-'
			AND length(replace(json_extract(`metadata`, '$.rootWorkItemId'), '-', '')) = 32
			AND replace(json_extract(`metadata`, '$.rootWorkItemId'), '-', '') NOT GLOB '*[^0-9A-Fa-f]*'
		)
	) THEN json_extract(`metadata`, '$.rootWorkItemId') END,
	`root_goal` = CASE WHEN json_type(`metadata`, '$.rootGoal') = 'text' AND length(json_extract(`metadata`, '$.rootGoal')) <= 10000 THEN json_extract(`metadata`, '$.rootGoal') END,
	`budget_share_micros` = CASE WHEN json_type(`metadata`, '$.budgetShareMicros') = 'integer' AND json_extract(`metadata`, '$.budgetShareMicros') BETWEEN 0 AND 1000000 THEN json_extract(`metadata`, '$.budgetShareMicros') END
WHERE json_valid(`metadata`);--> statement-breakpoint
DROP INDEX `idx_work_items_lane_executor`;--> statement-breakpoint
DROP INDEX `idx_work_items_lane_ready`;--> statement-breakpoint
CREATE INDEX `idx_work_items_lane_executor` ON `work_items` (`org_id`,`disposition`,`executor_type`,`executor_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_work_items_lane_ready` ON `work_items` (`org_id`,`disposition`,`executor_type`,`executor_id`,`created_at`,`id`) WHERE `dispatch_state` = 'ready';
