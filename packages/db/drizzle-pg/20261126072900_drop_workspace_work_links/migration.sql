-- tedix: destructive-reviewed Work-Item: 6c03071f-213c-43db-a502-33152d3c1a45
-- Derived projection only; source event summaries retain workItemIds.
-- Deploy the writer removal first and retain the release recovery point.
DROP TABLE "public"."workspace_work_links";
