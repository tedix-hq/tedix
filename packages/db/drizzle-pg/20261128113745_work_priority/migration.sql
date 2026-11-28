ALTER TABLE "work_items" ADD COLUMN "priority_level" text DEFAULT 'normal' NOT NULL;
--> statement-breakpoint
UPDATE work_items SET priority_level = CASE priority WHEN 'critical' THEN 'urgent' WHEN 'high' THEN 'high' WHEN 'low' THEN 'low' ELSE 'normal' END;
