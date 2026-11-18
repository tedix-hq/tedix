CREATE TABLE `app_catalog_category_totals` (
	`category` text PRIMARY KEY,
	`total` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO app_catalog_category_totals (category, total)
SELECT coalesce(category, ''), count(*) FROM app_catalog
WHERE is_discoverable = 1 AND status = 'ENABLED' AND review_status = 'RELEASED' AND developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY') GROUP BY coalesce(category, '');
--> statement-breakpoint
CREATE TRIGGER app_catalog_category_insert AFTER INSERT ON app_catalog
WHEN new.is_discoverable = 1 AND new.status = 'ENABLED' AND new.review_status = 'RELEASED' AND new.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')
BEGIN
  INSERT INTO app_catalog_category_totals (category, total) VALUES (coalesce(new.category, ''), 1)
  ON CONFLICT(category) DO UPDATE SET total = total + 1;
END;
--> statement-breakpoint
CREATE TRIGGER app_catalog_category_delete AFTER DELETE ON app_catalog
WHEN old.is_discoverable = 1 AND old.status = 'ENABLED' AND old.review_status = 'RELEASED' AND old.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')
BEGIN
  UPDATE app_catalog_category_totals SET total = total - 1 WHERE category = coalesce(old.category, '');
END;
--> statement-breakpoint
CREATE TRIGGER app_catalog_category_update
AFTER UPDATE OF category, is_discoverable, status, review_status, developer_type ON app_catalog
BEGIN
  UPDATE app_catalog_category_totals SET total = total - 1
  WHERE category = coalesce(old.category, '') AND old.is_discoverable = 1 AND old.status = 'ENABLED' AND old.review_status = 'RELEASED' AND old.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY');
  INSERT INTO app_catalog_category_totals (category, total)
  SELECT coalesce(new.category, ''), 1 WHERE new.is_discoverable = 1 AND new.status = 'ENABLED' AND new.review_status = 'RELEASED' AND new.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')
  ON CONFLICT(category) DO UPDATE SET total = total + 1;
END;
