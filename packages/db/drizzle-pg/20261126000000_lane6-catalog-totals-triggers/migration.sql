-- Install catalog totals triggers atomically; catalog writes cannot race the backfill.

DO $lane6_catalog_totals$

BEGIN

LOCK TABLE catalog.app_catalog IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX "app_catalog_public_browse_name_idx" ON "catalog"."app_catalog" ("name") WHERE "is_discoverable" = true AND "status" = 'ENABLED' AND "review_status" = 'RELEASED' AND "developer_type" IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY');

CREATE INDEX "app_catalog_explore_name_idx" ON "catalog"."app_catalog" ("name") WHERE "is_discoverable" = true AND "status" = 'ENABLED' AND "review_status" = 'RELEASED' AND "developer_type" IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY') AND "explore_shadowed" = false;

CREATE FUNCTION catalog_app_browse_totals_track() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
	old_visible boolean;
	new_visible boolean;
	old_explore boolean;
	new_explore boolean;
BEGIN
	IF TG_OP <> 'INSERT' THEN
		old_visible := OLD.is_discoverable = true
			AND OLD.status = 'ENABLED'
			AND OLD.review_status = 'RELEASED'
			AND OLD.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY');
		old_explore := old_visible AND OLD.explore_shadowed = false;
	END IF;
	IF TG_OP <> 'DELETE' THEN
		new_visible := NEW.is_discoverable = true
			AND NEW.status = 'ENABLED'
			AND NEW.review_status = 'RELEASED'
			AND NEW.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY');
		new_explore := new_visible AND NEW.explore_shadowed = false;
	END IF;
	UPDATE catalog.app_catalog_browse_totals
	SET total = total
		- CASE WHEN old_visible THEN 1 ELSE 0 END
		+ CASE WHEN new_visible THEN 1 ELSE 0 END,
		explore_total = explore_total
		- CASE WHEN old_explore THEN 1 ELSE 0 END
		+ CASE WHEN new_explore THEN 1 ELSE 0 END
	WHERE id = 'public';
	RETURN NULL;
END;
$function$;

CREATE TRIGGER app_catalog_browse_totals_insert AFTER INSERT ON catalog.app_catalog FOR EACH ROW EXECUTE FUNCTION catalog_app_browse_totals_track();

CREATE TRIGGER app_catalog_browse_totals_update AFTER UPDATE OF is_discoverable, status, review_status, developer_type, explore_shadowed ON catalog.app_catalog FOR EACH ROW EXECUTE FUNCTION catalog_app_browse_totals_track();

CREATE TRIGGER app_catalog_browse_totals_delete AFTER DELETE ON catalog.app_catalog FOR EACH ROW EXECUTE FUNCTION catalog_app_browse_totals_track();

CREATE FUNCTION catalog_app_category_totals_track() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
	old_visible boolean;
	new_visible boolean;
BEGIN
	IF TG_OP <> 'INSERT' THEN
		old_visible := OLD.is_discoverable = true
			AND OLD.status = 'ENABLED'
			AND OLD.review_status = 'RELEASED'
			AND OLD.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY');
		IF old_visible THEN
			UPDATE catalog.app_catalog_category_totals
			SET total = total - 1
			WHERE category = coalesce(OLD.category, '');
		END IF;
	END IF;
	IF TG_OP <> 'DELETE' THEN
		new_visible := NEW.is_discoverable = true
			AND NEW.status = 'ENABLED'
			AND NEW.review_status = 'RELEASED'
			AND NEW.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY');
		IF new_visible THEN
			INSERT INTO catalog.app_catalog_category_totals (category, total)
			VALUES (coalesce(NEW.category, ''), 1)
			ON CONFLICT (category) DO UPDATE
			SET total = app_catalog_category_totals.total + 1;
		END IF;
	END IF;
	RETURN NULL;
END;
$function$;

CREATE TRIGGER app_catalog_category_totals_insert AFTER INSERT ON catalog.app_catalog FOR EACH ROW WHEN (NEW.is_discoverable = true AND NEW.status = 'ENABLED' AND NEW.review_status = 'RELEASED' AND NEW.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')) EXECUTE FUNCTION catalog_app_category_totals_track();

CREATE TRIGGER app_catalog_category_totals_update AFTER UPDATE OF category, is_discoverable, status, review_status, developer_type ON catalog.app_catalog FOR EACH ROW EXECUTE FUNCTION catalog_app_category_totals_track();

CREATE TRIGGER app_catalog_category_totals_delete AFTER DELETE ON catalog.app_catalog FOR EACH ROW WHEN (OLD.is_discoverable = true AND OLD.status = 'ENABLED' AND OLD.review_status = 'RELEASED' AND OLD.developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')) EXECUTE FUNCTION catalog_app_category_totals_track();

DELETE FROM catalog.app_catalog_browse_totals;

INSERT INTO catalog.app_catalog_browse_totals (id, total, explore_total)
SELECT 'public', count(*), coalesce(sum((explore_shadowed = false)::int), 0)
FROM catalog.app_catalog
WHERE is_discoverable = true AND status = 'ENABLED' AND review_status = 'RELEASED' AND developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY');

DELETE FROM catalog.app_catalog_category_totals;

INSERT INTO catalog.app_catalog_category_totals (category, total)
SELECT coalesce(category, ''), count(*)
FROM catalog.app_catalog
WHERE is_discoverable = true AND status = 'ENABLED' AND review_status = 'RELEASED' AND developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')
GROUP BY coalesce(category, '');

END;

$lane6_catalog_totals$;
