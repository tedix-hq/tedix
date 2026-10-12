CREATE TABLE `app_catalog_browse_totals` (
	`id` text PRIMARY KEY,
	`total` integer NOT NULL,
	`explore_total` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_catalog_public_browse_name_idx` ON `app_catalog` (`name`) WHERE "app_catalog"."is_discoverable" = 1 AND "app_catalog"."status" = 'ENABLED' AND "app_catalog"."review_status" = 'RELEASED' AND "app_catalog"."developer_type" IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY');--> statement-breakpoint
CREATE INDEX `app_catalog_explore_name_idx` ON `app_catalog` (`name`) WHERE "app_catalog"."is_discoverable" = 1 AND "app_catalog"."status" = 'ENABLED' AND "app_catalog"."review_status" = 'RELEASED' AND "app_catalog"."developer_type" IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY') AND "app_catalog"."explore_shadowed" = 0;
--> statement-breakpoint
INSERT INTO app_catalog_browse_totals (id, total, explore_total)
SELECT 'public', count(*), coalesce(sum(explore_shadowed = 0), 0)
FROM app_catalog WHERE is_discoverable = 1 AND status = 'ENABLED' AND review_status = 'RELEASED' AND developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY');
--> statement-breakpoint
CREATE TRIGGER app_catalog_browse_insert AFTER INSERT ON app_catalog
BEGIN
  UPDATE app_catalog_browse_totals
  SET total = total + coalesce((new.is_discoverable = 1 AND new.status = 'ENABLED' AND new.review_status = 'RELEASED' AND new.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')), 0),
      explore_total = explore_total + coalesce((new.is_discoverable = 1 AND new.status = 'ENABLED' AND new.review_status = 'RELEASED' AND new.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')), 0) * (new.explore_shadowed = 0)
  WHERE id = 'public';
END;
--> statement-breakpoint
CREATE TRIGGER app_catalog_browse_delete AFTER DELETE ON app_catalog
BEGIN
  UPDATE app_catalog_browse_totals
  SET total = total - coalesce((old.is_discoverable = 1 AND old.status = 'ENABLED' AND old.review_status = 'RELEASED' AND old.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')), 0),
      explore_total = explore_total - coalesce((old.is_discoverable = 1 AND old.status = 'ENABLED' AND old.review_status = 'RELEASED' AND old.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')), 0) * (old.explore_shadowed = 0)
  WHERE id = 'public';
END;
--> statement-breakpoint
CREATE TRIGGER app_catalog_browse_update
AFTER UPDATE OF is_discoverable, status, review_status, developer_type, explore_shadowed ON app_catalog
BEGIN
  UPDATE app_catalog_browse_totals
  SET total = total - coalesce((old.is_discoverable = 1 AND old.status = 'ENABLED' AND old.review_status = 'RELEASED' AND old.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')), 0) + coalesce((new.is_discoverable = 1 AND new.status = 'ENABLED' AND new.review_status = 'RELEASED' AND new.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')), 0),
      explore_total = explore_total - coalesce((old.is_discoverable = 1 AND old.status = 'ENABLED' AND old.review_status = 'RELEASED' AND old.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')), 0) * (old.explore_shadowed = 0)
                    + coalesce((new.is_discoverable = 1 AND new.status = 'ENABLED' AND new.review_status = 'RELEASED' AND new.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')), 0) * (new.explore_shadowed = 0)
  WHERE id = 'public';
END;
