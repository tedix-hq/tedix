ALTER TABLE "work_items" ADD COLUMN "executor_type" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "executor_id" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "dispatch_state" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "delegation_depth" integer;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "max_attempts" integer;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "root_work_item_id" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "root_goal" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "budget_share_micros" integer;--> statement-breakpoint
UPDATE "work_items" SET
	"executor_type" = CASE
		WHEN jsonb_typeof("metadata" -> 'executor') IS NULL OR jsonb_typeof("metadata" -> 'executor') != 'string' OR char_length("metadata" ->> 'executor') NOT BETWEEN 1 AND 300 THEN NULL
		WHEN "metadata" ->> 'executor' = 'human' THEN 'human'
		WHEN "metadata" ->> 'executor' = 'tedi' THEN 'tedi'
		ELSE 'external_agent'
	END,
	"executor_id" = CASE
		WHEN "metadata" ->> 'executor' = 'human' AND "accountable_owner_type" = 'user' AND char_length("accountable_owner_id") BETWEEN 1 AND 300 THEN "accountable_owner_id"
		WHEN "metadata" ->> 'executor' = 'tedi' AND "accountable_owner_type" = 'tedi' AND char_length("accountable_owner_id") BETWEEN 1 AND 300 THEN "accountable_owner_id"
		WHEN jsonb_typeof("metadata" -> 'executor') = 'string' AND char_length("metadata" ->> 'executor') BETWEEN 1 AND 300 THEN "metadata" ->> 'executor'
	END,
	"dispatch_state" = CASE WHEN "metadata" #>> '{laneDispatch,state}' IN ('held','ready') THEN "metadata" #>> '{laneDispatch,state}' END,
	"delegation_depth" = CASE WHEN "metadata" #>> '{laneExecution,delegationDepth}' ~ '^[0-9]+$' AND ("metadata" #>> '{laneExecution,delegationDepth}')::numeric BETWEEN 0 AND 10 THEN ("metadata" #>> '{laneExecution,delegationDepth}')::integer END,
	"max_attempts" = CASE
		WHEN "metadata" #>> '{laneExecution,maxAttempts}' ~ '^[0-9]+$' AND ("metadata" #>> '{laneExecution,maxAttempts}')::numeric BETWEEN 1 AND 20 THEN ("metadata" #>> '{laneExecution,maxAttempts}')::integer
		WHEN "metadata" #>> '{factoryCycle,maxAttempts}' ~ '^[0-9]+$' AND ("metadata" #>> '{factoryCycle,maxAttempts}')::numeric BETWEEN 1 AND 5 THEN ("metadata" #>> '{factoryCycle,maxAttempts}')::integer
	END,
	"root_work_item_id" = CASE WHEN jsonb_typeof("metadata" -> 'rootWorkItemId') = 'string' AND (("metadata" ->> 'rootWorkItemId') = '00000000-0000-0000-0000-000000000000' OR ("metadata" ->> 'rootWorkItemId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN "metadata" ->> 'rootWorkItemId' END,
	"root_goal" = CASE WHEN jsonb_typeof("metadata" -> 'rootGoal') = 'string' AND char_length("metadata" ->> 'rootGoal') <= 10000 THEN "metadata" ->> 'rootGoal' END,
	"budget_share_micros" = CASE WHEN "metadata" ->> 'budgetShareMicros' ~ '^[0-9]+$' AND ("metadata" ->> 'budgetShareMicros')::numeric BETWEEN 0 AND 1000000 THEN ("metadata" ->> 'budgetShareMicros')::integer END;--> statement-breakpoint
DROP INDEX "idx_work_items_lane_executor";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_work_items_lane_ready";--> statement-breakpoint
CREATE INDEX "idx_work_items_lane_executor" ON "work_items" ("org_id","disposition","executor_type","executor_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_work_items_lane_ready" ON "work_items" ("org_id","disposition","executor_type","executor_id","created_at","id") WHERE "dispatch_state" = 'ready';
