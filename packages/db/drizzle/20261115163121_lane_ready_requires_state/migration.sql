-- Work without a laneDispatch plan no longer counts as ready. Give every
-- already-assigned task the plan it was implicitly treated as having, then
-- rebuild the ready index on the explicit state.
UPDATE `work_items` SET `metadata` = json_set(`metadata`, '$.laneDispatch', json('{"state":"ready"}')) WHERE json_valid(`metadata`) AND json_extract(`metadata`, '$.executor') IN ('codex','claude-code','opencode','devin','tedi','human') AND json_extract(`metadata`, '$.laneDispatch.state') IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_work_items_lane_ready`;--> statement-breakpoint
CREATE INDEX `idx_work_items_lane_ready` ON `work_items` (`org_id`,`disposition`,json_extract("metadata", '$.executor'),`created_at`,`id`) WHERE json_extract("work_items"."metadata", '$.laneDispatch.state') = 'ready';
